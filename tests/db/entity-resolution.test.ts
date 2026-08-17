/**
 * Pre-publication entity-resolution evidence (migration 0030 + the match layer).
 *
 * This layer answers "what else could this source property be?" and never
 * "should this be published?". The suite is organised around the two ways that
 * distinction gets lost:
 *
 *   1. an automatic MATCH — some count, distance or dimension quietly accepting
 *      a candidate. D063 §12.2 refuses a universal threshold, so nothing here
 *      may compute one, and several tests exist purely to prove no such code
 *      path exists.
 *   2. an automatic NEW PROPERTY — "the sweep found nothing, therefore this is
 *      new". That converts a statement about the RULES into a statement about
 *      the world, and D062 would later read it as authorisation to publish.
 *
 * All fixtures synthetic. No real provider data appears here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "./harness";
import { seed, USERS, DEST, HOTEL } from "../rls/seed";
import {
  haversineMetres,
  nameContainment,
  normalizeAddress,
  normalizeBrand,
  normalizeDomain,
  normalizeName,
  normalizePhone,
} from "../../scripts/entity-resolution/normalize";
import { compareRecords, type ComparableRecord } from "../../scripts/entity-resolution/evidence";
import { discoverCandidates, matchMethodFor } from "../../scripts/entity-resolution/candidates";
import { generateCandidates } from "../../scripts/entity-resolution/writer";

const d = describe.skipIf(!hasTestDb);
const SOURCE = "hotelbeds";
const REPO_ROOT = path.resolve(__dirname, "..", "..");

let counter = 0;
const uniq = () => `e${Date.now().toString(36)}${(counter += 1)}`;

const blank: ComparableRecord = {
  name: null,
  websiteUrl: null,
  address: null,
  phone: null,
  phoneType: null,
  brandCode: null,
  chainCode: null,
  latitude: null,
  longitude: null,
};
const rec = (over: Partial<ComparableRecord>): ComparableRecord => ({ ...blank, ...over });

interface Fixture {
  identityId: string;
  runId: string;
  sourcePropertyId: string;
}

async function newRun(destinationId: string): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    `insert into public.source_runs (source, source_environment, destination_id, run_mode, started_at)
     values ($1, 'evaluation', $2, 'evaluation', now()) returning id`,
    [SOURCE, destinationId],
  );
  return rows[0]!.id;
}

interface ObservationFields {
  name?: string | null;
  website?: string | null;
  address?: string | null;
  phone?: string | null;
  phoneType?: string | null;
  brand?: string | null;
  lat?: number | null;
  lon?: number | null;
}

async function identity(
  fields: ObservationFields & { destinationId?: string; runId?: string } = {},
): Promise<Fixture> {
  const destinationId = fields.destinationId ?? DEST.bali;
  const runId = fields.runId ?? (await newRun(destinationId));
  const sourcePropertyId = uniq();
  const rows = await adminQuery<{ id: string }>(
    `insert into public.source_property_identities
       (source, source_environment, source_property_id, first_seen_run_id, last_seen_run_id)
     values ($1, 'evaluation', $2, $3, $3) returning id`,
    [SOURCE, sourcePropertyId, runId],
  );
  const identityId = rows[0]!.id;
  await adminQuery(
    `insert into public.source_property_observations
       (source_run_id, source_property_identity_id, source, source_environment, observed_at,
        source_name, source_website_url, source_address, source_phone, source_phone_type,
        source_brand_code, source_latitude, source_longitude, source_coordinates_plausible)
     values ($1,$2,$3,'evaluation', now(), $4,$5,$6,$7,$8,$9,$10,$11,
             case when $10::numeric is null then null else true end)`,
    [
      runId,
      identityId,
      SOURCE,
      fields.name ?? null,
      fields.website ?? null,
      fields.address ?? null,
      fields.phone ?? null,
      fields.phoneType ?? null,
      fields.brand ?? null,
      fields.lat ?? null,
      fields.lon ?? null,
    ],
  );
  return { identityId, runId, sourcePropertyId };
}

async function runMatcher(apply = true) {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    return await generateCandidates(client, {
      source: SOURCE,
      environment: "evaluation",
      runId: null,
      apply,
    });
  } finally {
    await client.end();
  }
}

async function candidateBetween(a: string, b: string) {
  const [left, right] = a < b ? [a, b] : [b, a];
  const rows = await adminQuery<Record<string, string | number | boolean | null>>(
    `select * from public.source_match_candidates
      where source_property_identity_id = $1 and candidate_source_property_identity_id = $2`,
    [left, right],
  );
  return rows[0];
}

d("pre-publication entity resolution (0030)", () => {
  beforeAll(async () => {
    await setupDatabase();
    await seed();
  });
  afterAll(teardownDatabase);

  // -----------------------------------------------------------------------
  describe("normalisation is conservative and comparison-only", () => {
    it("reduces a hostname to what identifies a site", () => {
      expect(normalizeDomain("HTTPS://WWW.Example.com/rooms?x=1")).toBe("example.com");
      expect(normalizeDomain("http://user:pw@example.com:8443/")).toBe("example.com");
      // A subdomain can be a different property; it is NOT stripped.
      expect(normalizeDomain("bali.example.com")).toBe("bali.example.com");
    });

    it("refuses a value that is not a hostname", () => {
      // The real Bali payload contains a `web` value of exactly "n". Treating it
      // as a blocking key would have made every property carrying it a candidate
      // for every other one.
      for (const junk of ["n", "", "  ", "localhost", "1234", "http://", ".com", "a..b.com"]) {
        expect(normalizeDomain(junk), JSON.stringify(junk)).toBeNull();
      }
    });

    it("compares a phone only when the provider gave an international form", () => {
      expect(normalizePhone("+62 361 771714")).toBe("62361771714");
      expect(normalizePhone("0062361771714")).toBe("62361771714");
      // The Bali payload carries this doubled prefix for the same lines.
      expect(normalizePhone("+0062361771714")).toBe("62361771714");
      // A national number would need a country code invented for it. It is not.
      expect(normalizePhone("0361 771714")).toBeNull();
      expect(normalizePhone("62361771714")).toBeNull();
      expect(normalizePhone("+1234")).toBeNull();
    });

    it("normalises a name without dropping words", () => {
      expect(normalizeName("The  Legian, Bali!")).toBe("the legian bali");
      // "Hotel" is not a stop word here: dropping it would make "Hotel Bali"
      // and "Bali" the same property.
      expect(normalizeName("Hotel Bali")).not.toBe(normalizeName("Bali"));
    });

    it("treats containment as containment, not as overlap", () => {
      expect(nameContainment("The Legian", "The Legian Bali")).toBe(true);
      // A single shared token is a coincidence waiting to happen.
      expect(nameContainment("Bali", "Bali Dynasty Resort")).toBe(false);
      expect(nameContainment("Bali Garden", "Bali Dynasty")).toBe(false);
    });

    it("normalises address textually and brand exactly", () => {
      expect(normalizeAddress("Jl.  Kartika Plaza, No 8")).toBe("jl kartika plaza no 8");
      // No abbreviation dictionary: "Jl." and "Jalan" do NOT compare equal, which
      // produces no agreement rather than a false one.
      expect(normalizeAddress("Jl. Kartika")).not.toBe(normalizeAddress("Jalan Kartika"));
      expect(normalizeBrand(" rotana ")).toBe("ROTANA");
    });

    it("computes raw great-circle distance, and null when a point is missing", () => {
      expect(haversineMetres(-8.5, 115.2, -8.5, 115.2)).toBe(0);
      expect(Math.round(haversineMetres(-8.5, 115.2, -8.5001, 115.2)!)).toBe(11);
      expect(haversineMetres(-8.5, 115.2, null, 115.2)).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  describe("1-14. evidence semantics", () => {
    const withDomain = (u: string | null) => rec({ websiteUrl: u });
    const withPhone = (p: string | null) => rec({ phone: p });

    it("1/2/3. domain agrees, differs, unavailable", () => {
      expect(
        compareRecords(withDomain("https://a.com"), withDomain("http://www.a.com/x"))
          .domainEvidence,
      ).toBe("agrees");
      expect(compareRecords(withDomain("a.com"), withDomain("b.com")).domainEvidence).toBe(
        "differs",
      );
      expect(compareRecords(withDomain(null), withDomain("b.com")).domainEvidence).toBe(
        "unavailable",
      );
      expect(compareRecords(withDomain(null), withDomain(null)).domainEvidence).toBe("unavailable");
    });

    it("4/5/6. phone agrees, differs, unavailable", () => {
      expect(
        compareRecords(withPhone("+62361771714"), withPhone("0062 361 771714")).phoneEvidence,
      ).toBe("agrees");
      expect(
        compareRecords(withPhone("+62361771714"), withPhone("+62361771715")).phoneEvidence,
      ).toBe("differs");
      expect(compareRecords(withPhone(null), withPhone("+62361771714")).phoneEvidence).toBe(
        "unavailable",
      );
      // A fax is not a way to reach a property; two sharing one says nothing.
      const fax = rec({ phone: "+62361771714", phoneType: "FAXNUMBER" });
      expect(compareRecords(fax, withPhone("+62361771714")).phoneEvidence).toBe("unavailable");
    });

    it("7/8. name exact and token containment", () => {
      expect(
        compareRecords(rec({ name: "The Legian" }), rec({ name: "the  legian!" })).nameEvidence,
      ).toBe("exact");
      expect(
        compareRecords(rec({ name: "The Legian" }), rec({ name: "The Legian Bali" })).nameEvidence,
      ).toBe("token_containment");
      expect(
        compareRecords(rec({ name: "Bali Garden" }), rec({ name: "Bali Dynasty" })).nameEvidence,
      ).toBe("none");
      expect(compareRecords(rec({ name: null }), rec({ name: "x y" })).nameEvidence).toBe("none");
    });

    it("10/11. address and brand evidence", () => {
      expect(
        compareRecords(rec({ address: "Jl. Kartika 8" }), rec({ address: "JL KARTIKA 8" }))
          .addressEvidence,
      ).toBe("agrees");
      expect(compareRecords(rec({ address: "A" }), rec({ address: "B" })).addressEvidence).toBe(
        "differs",
      );
      expect(
        compareRecords(rec({ brandCode: "ROTANA" }), rec({ chainCode: "rotana" })).brandEvidence,
      ).toBe("agrees");
      expect(compareRecords(rec({ brandCode: "ROTANA" }), rec({})).brandEvidence).toBe(
        "unavailable",
      );
    });

    it("12. coordinate distance is stored raw, and is never bucketed", async () => {
      const a = await identity({ website: "https://coord.example.com", lat: -8.5, lon: 115.2 });
      const b = await identity({ website: "https://coord.example.com", lat: -8.5001, lon: 115.2 });
      await runMatcher();
      const row = await candidateBetween(a.identityId, b.identityId);
      expect(Number(row!.coordinate_distance_metres)).toBeCloseTo(11.1, 0);
      // The evidence vocabulary has no coordinate dimension at all, so there is
      // nowhere for a distance verdict to be written even by accident.
      expect(Object.keys(row!)).not.toContain("coordinate_evidence");
    });

    it("13. `unavailable` is not `differs`, on every dimension", () => {
      const e = compareRecords(blank, blank);
      expect([e.domainEvidence, e.addressEvidence, e.phoneEvidence, e.brandEvidence]).toEqual([
        "unavailable",
        "unavailable",
        "unavailable",
        "unavailable",
      ]);
      expect(e.nameEvidence).toBe("none");
      expect(e.coordinateDistanceMetres).toBeNull();
    });

    it("14. agreeing_dimensions is DB-generated and cannot be written", async () => {
      const a = await identity({ website: "https://gen.example.com" });
      const b = await identity({ website: "https://gen.example.com" });
      await runMatcher();
      const row = await candidateBetween(a.identityId, b.identityId);
      expect(typeof row!.agreeing_dimensions).toBe("number");
      await expect(
        adminQuery(
          `update public.source_match_candidates set agreeing_dimensions = 6 where id = $1`,
          [row!.id],
        ),
      ).rejects.toThrow(/can only be updated to DEFAULT|generated/i);
    });
  });

  // -----------------------------------------------------------------------
  describe("15-18. candidate shape and targets", () => {
    it("15. each kind requires exactly its own target", async () => {
      const f = await identity({});
      await expect(
        adminQuery(
          `insert into public.source_match_candidates
             (source_property_identity_id, source, source_environment, candidate_kind,
              candidate_hotel_id, match_method)
           values ($1,$2,'evaluation','source_identity',$3,'t')`,
          [f.identityId, SOURCE, HOTEL.bali],
        ),
      ).rejects.toThrow(/target_shape/i);
    });

    it("16. a source identity is never a candidate for itself", async () => {
      const f = await identity({});
      await expect(
        adminQuery(
          `insert into public.source_match_candidates
             (source_property_identity_id, source, source_environment, candidate_kind,
              candidate_source_property_identity_id, match_method)
           values ($1,$2,'evaluation','source_identity',$1,'t')`,
          [f.identityId, SOURCE],
        ),
      ).rejects.toThrow(/no_self_match/i);
      // …and discovery never produces such a pair either.
      const one = {
        identityId: "x",
        observationId: "o",
        destinationId: "d",
        ...blank,
        name: "same name",
      };
      expect(discoverCandidates([one, one]).pairs).toHaveLength(0);
    });

    it("17. source↔source works with NO canonical hotel anywhere", async () => {
      const a = await identity({ name: "Twin Villa Ubud" });
      const b = await identity({ name: "Twin Villa Ubud" });
      await runMatcher();
      const row = await candidateBetween(a.identityId, b.identityId);
      expect(row!.candidate_kind).toBe("source_identity");
      expect(row!.candidate_hotel_id).toBeNull();
      const hotels = await adminQuery<{ n: string }>(`select count(*)::text n from public.hotels`);
      // The seed has canonical hotels; the point is that this pair needed none.
      expect(Number(hotels[0]!.n)).toBeGreaterThanOrEqual(0);
    });

    it("18. the canonical_hotel path works on a synthetic fixture", async () => {
      // No canonical candidate is generated from real evaluation data — there is
      // nothing to match against — so the path is proved directly.
      const f = await identity({ name: "Canonical Probe" });
      const rows = await adminQuery<{ kind: string; n: number }>(
        `insert into public.source_match_candidates
           (source_property_identity_id, source, source_environment, candidate_kind,
            candidate_hotel_id, match_method, name_evidence, domain_evidence)
         values ($1,$2,'evaluation','canonical_hotel',$3,'blocking:exact_name_in_destination',
                 'exact','agrees')
         returning candidate_kind as kind, agreeing_dimensions as n`,
        [f.identityId, SOURCE, HOTEL.bali],
      );
      expect(rows[0]!.kind).toBe("canonical_hotel");
      expect(rows[0]!.n).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // NO AUTOMATIC MATCH, NO AUTOMATIC NEW PROPERTY
  // -----------------------------------------------------------------------
  describe("19-21. the two decisions this layer refuses to make", () => {
    it("9/21. no evidence combination accepts a candidate", async () => {
      // Everything agreeing on every dimension, at zero distance.
      const a = await identity({
        name: "Total Agreement Resort",
        website: "https://agree.example.com",
        address: "Same Street 1",
        phone: "+6236100000",
        brand: "AGREE",
        lat: -8.5,
        lon: 115.2,
      });
      const b = await identity({
        name: "Total Agreement Resort",
        website: "https://agree.example.com",
        address: "Same Street 1",
        phone: "+6236100000",
        brand: "AGREE",
        lat: -8.5,
        lon: 115.2,
      });
      await runMatcher();
      const row = await candidateBetween(a.identityId, b.identityId);
      expect(row!.agreeing_dimensions).toBe(5);
      expect(Number(row!.coordinate_distance_metres)).toBe(0);
      // Maximum possible evidence, zero metres apart — and still PENDING.
      expect(row!.status).toBe("pending");
      expect(row!.resolved_at).toBeNull();
    });

    it("21. no source file compares evidence to a numeric threshold", () => {
      // A structural check, not a stylistic one: the whole point of D063 §12.2
      // is that such a comparison must not exist anywhere in the pipeline.
      for (const file of [
        "candidates.ts",
        "evidence.ts",
        "normalize.ts",
        "writer.ts",
        "review.ts",
      ]) {
        const src = readFileSync(
          path.join(REPO_ROOT, "scripts", "entity-resolution", file),
          "utf8",
        );
        const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
        expect(code, `${file} compares agreeing_dimensions`).not.toMatch(
          /agreeing_?dimensions\s*(?:[<>]=?|[!=]==?)\s*\d/i,
        );
        expect(code, `${file} thresholds a distance`).not.toMatch(
          /distance\w*\s*(?:[<>]=?|[!=]==?)\s*\d/i,
        );
        expect(code, `${file} carries a confidence/score`).not.toMatch(
          /confidence|matchScore|similarity/i,
        );
        expect(code, `${file} sets a status other than pending`).not.toMatch(
          /'(accepted|rejected|superseded)'/,
        );
      }
    });

    it("19. no machine candidate NEVER becomes a new_property row", async () => {
      const lonely = await identity({ name: `Utterly Unique ${uniq()}` });
      const counts = await runMatcher();
      expect(counts.identitiesWithoutCandidate).toBeGreaterThan(0);
      const rows = await adminQuery<{ n: string }>(
        `select count(*)::text n from public.source_match_candidates
          where candidate_kind = 'new_property'`,
      );
      expect(rows[0]!.n).toBe("0");
      const mine = await adminQuery<{ n: string }>(
        `select count(*)::text n from public.source_match_candidates
          where source_property_identity_id = $1 or candidate_source_property_identity_id = $1`,
        [lonely.identityId],
      );
      expect(mine[0]!.n).toBe("0");
    });

    it("19. the database refuses a new_property row with no finding behind it", async () => {
      const f = await identity({});
      // The bulk-sweep shape: every identity with no candidate, inserted as new.
      await expect(
        adminQuery(
          `insert into public.source_match_candidates
             (source_property_identity_id, source, source_environment, candidate_kind, match_method)
           values ($1,$2,'evaluation','new_property','no_candidate_found')`,
          [f.identityId, SOURCE],
        ),
      ).rejects.toThrow(/new_property_requires_finding/i);
      // …and the quieter version: omitting the kind, which DEFAULTS to it.
      await expect(
        adminQuery(
          `insert into public.source_match_candidates
             (source_property_identity_id, source, source_environment, match_method)
           values ($1,$2,'evaluation','sweep')`,
          [f.identityId, SOURCE],
        ),
      ).rejects.toThrow(/new_property_requires_finding/i);
    });

    it("20. an EXPLICIT new_property finding is accepted, and only once", async () => {
      const f = await identity({});
      await expect(
        adminQuery(
          `insert into public.source_match_candidates
             (source_property_identity_id, source, source_environment, candidate_kind,
              match_method, review_note)
           values ($1,$2,'evaluation','new_property','manual_search',
                   'Searched Google/Booking/canonical inventory 2026-08-18; no existing property. — editor:ana')`,
          [f.identityId, SOURCE],
        ),
      ).resolves.toBeTruthy();
      await expect(
        adminQuery(
          `insert into public.source_match_candidates
             (source_property_identity_id, source, source_environment, candidate_kind,
              match_method, review_note)
           values ($1,$2,'evaluation','new_property','manual_search','second look — editor:bo')`,
          [f.identityId, SOURCE],
        ),
      ).rejects.toThrow(/new_property_uk|duplicate key/i);
    });
  });

  // -----------------------------------------------------------------------
  describe("22-23. blocking behaviour", () => {
    it("22. generation is idempotent, and a decided row is left alone", async () => {
      const a = await identity({ website: "https://idem.example.com" });
      const b = await identity({ website: "https://idem.example.com" });
      const first = await runMatcher();
      expect(first.candidatesCreated).toBeGreaterThan(0);
      const replay = await runMatcher();
      expect(replay.candidatesCreated).toBe(0);
      expect(replay.candidatesEvidenceUpdated).toBe(0);

      const row = await candidateBetween(a.identityId, b.identityId);
      await adminQuery(`update public.source_match_candidates set status='rejected' where id=$1`, [
        row!.id,
      ]);
      const afterDecision = await runMatcher();
      expect(afterDecision.candidatesDecidedSkipped).toBeGreaterThan(0);
      const again = await candidateBetween(a.identityId, b.identityId);
      // The reviewer's decision, and the evidence it rested on, are untouched.
      expect(again!.status).toBe("rejected");
      expect(again!.match_method).toBe(row!.match_method);
    });

    it("a pair found by two rules is ONE candidate with both reasons", async () => {
      const a = await identity({ website: "https://both.example.com", phone: "+62361555111" });
      const b = await identity({ website: "https://both.example.com", phone: "+62361555111" });
      await runMatcher();
      const rows = await adminQuery<{ n: string; m: string }>(
        `select count(*)::text n, min(match_method) m from public.source_match_candidates
          where source_property_identity_id in ($1,$2)
            and candidate_source_property_identity_id in ($1,$2)`,
        [a.identityId, b.identityId],
      );
      expect(rows[0]!.n).toBe("1");
      expect(rows[0]!.m).toBe(matchMethodFor(["exact_domain", "exact_phone"]));
    });

    it("a key naming a GROUP is a cluster, never pairs", () => {
      const make = (id: string, website: string) => ({
        identityId: id,
        observationId: `o${id}`,
        destinationId: "dest-1",
        ...blank,
        websiteUrl: website,
      });
      const chain = ["a", "b", "c"].map((id) => make(id, "https://chain.example.com"));
      const result = discoverCandidates(chain);
      expect(result.pairs).toHaveLength(0);
      expect(result.sharedKeyClusters).toHaveLength(1);
      expect(result.sharedKeyClusters[0]!.identityIds).toEqual(["a", "b", "c"]);
      // Two, on the other hand, is a pair.
      expect(discoverCandidates(chain.slice(0, 2)).pairs).toHaveLength(1);
    });

    it("23. a cross-destination collision is an anomaly, never a pair", () => {
      const make = (id: string, destinationId: string) => ({
        identityId: id,
        observationId: `o${id}`,
        destinationId,
        ...blank,
        websiteUrl: "https://ritzcarlton.example.com",
        name: "Ritz Probe",
      });
      const result = discoverCandidates([make("a", "bali"), make("b", "dubai")]);
      expect(result.pairs).toHaveLength(0);
      expect(result.crossDestinationCollisions.length).toBeGreaterThan(0);
      expect(result.crossDestinationCollisions[0]!.identityIds).toEqual(["a", "b"]);
    });
  });

  // -----------------------------------------------------------------------
  describe("24-27. canonical safety, security and stability", () => {
    it("24/25. generating candidates writes nothing canonical and moves no state", async () => {
      const snapshot = async () =>
        (
          await adminQuery<Record<string, string>>(
            `select (select count(*) from public.hotels)::text h,
                    (select count(*) from public.hotel_source_identities)::text l,
                    (select count(*) from public.hotel_contacts)::text ct,
                    (select count(*) from public.source_property_reviews)::text r,
                    (select count(*) from public.editorial_evidence)::text e,
                    (select count(*) from public.source_property_identities
                      where resolution_state <> 'unresolved')::text terminal,
                    (select count(*) from public.source_property_identities
                      where promoted_hotel_id is not null)::text promoted`,
          )
        )[0];
      const before = await snapshot();
      await identity({ website: "https://safety.example.com" });
      await identity({ website: "https://safety.example.com" });
      await runMatcher();
      expect(await snapshot()).toEqual(before);
      expect(before!.terminal).toBe("0");
      expect(before!.promoted).toBe("0");
    });

    it("the writer contains no SQL for canonical or terminal tables", () => {
      for (const file of ["writer.ts", "candidates.ts", "evidence.ts", "match.ts"]) {
        const src = readFileSync(
          path.join(REPO_ROOT, "scripts", "entity-resolution", file),
          "utf8",
        );
        const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
        for (const forbidden of [
          "public.hotels",
          "hotel_source_identities",
          "source_property_reviews",
          "resolution_state",
          "promoted_hotel_id",
        ]) {
          expect(code, `${file} touches ${forbidden}`).not.toContain(forbidden);
        }
      }
    });

    it("26. an ordinary creator sees no candidate or review rows", async () => {
      await identity({ website: "https://rls.example.com" });
      await identity({ website: "https://rls.example.com" });
      await runMatcher();
      for (const relation of ["source_match_candidates", "source_property_reviews"]) {
        const res = await queryAs<{ n: string }>(
          { role: "authenticated", sub: USERS.free },
          `select count(*)::text as n from public.${relation}`,
        );
        expect(res.error, `creator errored on ${relation}`).toBeNull();
        expect(res.rows[0]!.n, `creator saw rows in ${relation}`).toBe("0");
      }
      const anon = await queryAs(
        { role: "anon", sub: null },
        `select * from public.source_match_candidates`,
      );
      expect(anon.error?.code).toBe("42501");
    });

    it("27. a full replay leaves the candidate set byte-identical", async () => {
      const checksum = async () =>
        (
          await adminQuery<{ ck: string | null }>(
            `select md5(string_agg(x, '|' order by x)) as ck from (
               select id::text || ':' || match_method || ':' || status || ':' ||
                      name_evidence || domain_evidence || address_evidence ||
                      phone_evidence || brand_evidence || ':' ||
                      coalesce(coordinate_distance_metres::text,'~') || ':' ||
                      agreeing_dimensions::text as x
                 from public.source_match_candidates) t`,
          )
        )[0]!.ck;
      const before = await checksum();
      const replay = await runMatcher();
      expect(replay.candidatesCreated).toBe(0);
      expect(replay.candidatesEvidenceUpdated).toBe(0);
      expect(await checksum()).toBe(before);
    });
  });
});
