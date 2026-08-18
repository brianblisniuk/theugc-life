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
import {
  discoverCandidates,
  matchMethodFor,
  type DiscoveryResult,
} from "../../scripts/entity-resolution/candidates";
import {
  compareMachinePairSync,
  isGeneratorOwned,
  partitionForReview,
  type PairKey,
} from "../../scripts/entity-resolution/queues";
import {
  ACTIONABLE_COUNT_QUERY,
  CANDIDATE_QUERY,
  loadAccountedNonMachinePairs,
  loadPersistedMachinePairs,
  outOfSyncMessage,
} from "../../scripts/entity-resolution/review";
import {
  generateCandidates,
  loadBlockableIdentities,
} from "../../scripts/entity-resolution/writer";

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

/** A LATER observation for an existing identity, in a run of its own. */
async function addObservation(
  f: Fixture,
  fields: ObservationFields & { destinationId?: string } = {},
): Promise<void> {
  const runId = await newRun(fields.destinationId ?? DEST.bali);
  await adminQuery(
    `insert into public.source_property_observations
       (source_run_id, source_property_identity_id, source, source_environment, observed_at,
        source_name, source_website_url, source_address, source_phone, source_phone_type,
        source_brand_code, source_latitude, source_longitude, source_coordinates_plausible)
     values ($1,$2,$3,'evaluation', now() + interval '1 second', $4,$5,$6,$7,$8,$9,$10,$11,
             case when $10::numeric is null then null else true end)`,
    [
      runId,
      f.identityId,
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
      }

      // ACCEPTED and REJECTED are a human's words.
      //
      // The guard is on the WRITE, not on the string, and that is the stronger
      // claim: `review.ts` has to NAME those statuses to classify a row as
      // already decided, and banning the characters would have forced that
      // read-only classification to be written obscurely instead. So every file
      // that is not the writer must contain no candidate write AT ALL — no
      // insert, no update, no delete — which forbids deciding a candidate along
      // with everything else it could otherwise do.
      for (const file of [
        "candidates.ts",
        "evidence.ts",
        "normalize.ts",
        "review.ts",
        "match.ts",
      ]) {
        const code = readFileSync(
          path.join(REPO_ROOT, "scripts", "entity-resolution", file),
          "utf8",
        ).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
        expect(code, `${file} writes to source_match_candidates`).not.toMatch(
          /\b(insert\s+into|update|delete\s+from)\s+public\.source_match_candidates/i,
        );
        expect(code, `${file} writes a candidate status`).not.toMatch(/set\s+status\s*=/i);
      }

      // And the writer, which DOES write, still may not write either of them.
      {
        const writerCode = readFileSync(
          path.join(REPO_ROOT, "scripts", "entity-resolution", "writer.ts"),
          "utf8",
        ).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
        expect(writerCode, "writer.ts decides a candidate").not.toMatch(/'(accepted|rejected)'/);
      }

      // `superseded` IS written, by the generator standing down its own stale
      // rows — so the guard on it is narrower and stronger than "never".
      const writer = readFileSync(
        path.join(REPO_ROOT, "scripts", "entity-resolution", "writer.ts"),
        "utf8",
      ).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      for (const required of [
        "'no_current_blocking_rule'", // never an unexplained supersession
        "status = 'pending'", // only a row nobody has decided
        "match_method like 'blocking:%'", // only a row the generator made
      ]) {
        expect(writer, `stand-down is missing ${required}`).toContain(required);
      }
      // `'superseded'` is likewise permitted only where it cannot decide
      // anything: the four non-writer files carry no candidate write at all
      // (asserted above), so any mention of it there is a read filter.
      for (const file of ["candidates.ts", "evidence.ts", "normalize.ts", "match.ts"]) {
        const src = readFileSync(
          path.join(REPO_ROOT, "scripts", "entity-resolution", file),
          "utf8",
        );
        const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
        expect(code, `${file} changes a candidate status`).not.toMatch(/'superseded'/);
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

    it("a decided candidate is NEVER rewritten, superseded or revived", async () => {
      const a = await identity({ website: "https://decided.example.com" });
      const b = await identity({ website: "https://decided.example.com" });
      await runMatcher();
      const row = await candidateBetween(a.identityId, b.identityId);

      // A human accepts it, then the provider removes the shared domain.
      await adminQuery(
        `update public.source_match_candidates set status='accepted', resolved_at=now() where id=$1`,
        [row!.id],
      );
      await addObservation(a, { website: "https://moved-away.example.com" });
      await runMatcher();

      const after = await candidateBetween(a.identityId, b.identityId);
      expect(after!.status).toBe("accepted");
      expect(after!.superseded_reason).toBeNull();
      expect(after!.match_method).toBe(row!.match_method);
      expect(after!.domain_evidence).toBe(row!.domain_evidence);

      // …and a human-superseded row is not revived when the evidence returns,
      // because it carries no machine reason.
      await adminQuery(
        `update public.source_match_candidates set status='superseded', resolved_at=now() where id=$1`,
        [row!.id],
      );
      await addObservation(a, { website: "https://decided.example.com" });
      await runMatcher();
      const final = await candidateBetween(a.identityId, b.identityId);
      expect(final!.status).toBe("superseded");
      expect(final!.superseded_reason).toBeNull();
    });

    it("27. a full replay leaves the candidate set byte-identical", async () => {
      // The checksum covers the COMPLETE mutable candidate state — including
      // `superseded_reason` and `resolved_at`, the two fields the lifecycle
      // moves — so "nothing changed" is a claim about lifecycle too, not only
      // about evidence.
      const checksum = async () =>
        (
          await adminQuery<{ ck: string | null }>(
            `select md5(string_agg(x, '|' order by x)) as ck from (
               select id::text || ':' || match_method || ':' || status || ':' ||
                      coalesce(superseded_reason,'~') || ':' ||
                      coalesce(resolved_at::text,'~') || ':' ||
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

  // -----------------------------------------------------------------------
  // A PAIR IS ONE ROW, IN ONE ORIENTATION
  // -----------------------------------------------------------------------
  describe("unordered pair uniqueness is a DATABASE invariant", () => {
    const insertPair = (left: string, right: string) =>
      adminQuery(
        `insert into public.source_match_candidates
           (source_property_identity_id, candidate_source_property_identity_id, source,
            source_environment, candidate_kind, match_method)
         values ($1,$2,$3,'evaluation','source_identity','manual_probe')`,
        [left, right, SOURCE],
      );

    it("accepts the canonical orientation, and refuses both the reverse and the repeat", async () => {
      const x = await identity({});
      const y = await identity({});
      const [low, high] =
        x.identityId < y.identityId ? [x.identityId, y.identityId] : [y.identityId, x.identityId];

      await expect(insertPair(low, high)).resolves.toBeTruthy();
      // The same pair, written the other way round: two rows for one pair, for a
      // reviewer to decide twice and possibly differently.
      await expect(insertPair(high, low)).rejects.toThrow(/source_pair_orientation/i);
      await expect(insertPair(low, high)).rejects.toThrow(/source_pair_uk|duplicate key/i);
    });

    it("refuses the reverse orientation even with no row present at all", async () => {
      const x = await identity({});
      const y = await identity({});
      const [low, high] =
        x.identityId < y.identityId ? [x.identityId, y.identityId] : [y.identityId, x.identityId];
      // Structural, not a deduplication side effect.
      await expect(insertPair(high, low)).rejects.toThrow(/source_pair_orientation/i);
    });

    it("leaves canonical_hotel candidates unconstrained by orientation", async () => {
      const f = await identity({});
      await expect(
        adminQuery(
          `insert into public.source_match_candidates
             (source_property_identity_id, source, source_environment, candidate_kind,
              candidate_hotel_id, match_method)
           values ($1,$2,'evaluation','canonical_hotel',$3,'manual_probe')`,
          [f.identityId, SOURCE, HOTEL.bali],
        ),
      ).resolves.toBeTruthy();
    });

    it("discovery orients every pair canonically", () => {
      const make = (id: string) => ({
        identityId: id,
        observationId: `o${id}`,
        destinationId: "dest-1",
        ...blank,
        websiteUrl: "https://orient.example.com",
      });
      for (const order of [
        ["zzz", "aaa"],
        ["aaa", "zzz"],
      ]) {
        const { pairs } = discoverCandidates(order.map(make));
        expect(pairs).toHaveLength(1);
        expect(pairs[0]!.leftIdentityId < pairs[0]!.rightIdentityId).toBe(true);
      }
    });
  });

  // -----------------------------------------------------------------------
  // A PENDING CANDIDATE IS A CLAIM ABOUT CURRENT EVIDENCE
  // -----------------------------------------------------------------------
  describe("stale machine candidates are stood down, not left pending", () => {
    it("appears → disappears → reappears, with history intact throughout", async () => {
      const a = await identity({ website: "https://lifecycle.example.com" });
      const b = await identity({ website: "https://lifecycle.example.com" });

      // APPEARS.
      const first = await runMatcher();
      expect(first.candidatesCreated).toBeGreaterThan(0);
      const appeared = await candidateBetween(a.identityId, b.identityId);
      expect(appeared!.status).toBe("pending");
      expect(appeared!.match_method).toBe(matchMethodFor(["exact_domain"]));

      // DISAPPEARS: the provider corrects one property's website, so no blocking
      // rule connects them any more.
      await addObservation(a, { website: "https://elsewhere.example.com" });
      const second = await runMatcher();
      expect(second.candidatesSuperseded).toBeGreaterThan(0);

      const stoodDown = await candidateBetween(a.identityId, b.identityId);
      expect(stoodDown!.status).toBe("superseded");
      expect(stoodDown!.superseded_reason).toBe("no_current_blocking_rule");
      // History is not deleted, and the evidence that WAS current is preserved
      // exactly, so a reader can still see why the pair once stood.
      expect(stoodDown!.id).toBe(appeared!.id);
      expect(stoodDown!.match_method).toBe(appeared!.match_method);
      expect(stoodDown!.domain_evidence).toBe(appeared!.domain_evidence);

      // Replay after standing down changes nothing further.
      const third = await runMatcher();
      expect(third.candidatesSuperseded).toBe(0);
      expect(third.candidatesCreated).toBe(0);
      expect(third.candidatesReactivated).toBe(0);

      // REAPPEARS: the correction is itself corrected.
      await addObservation(a, { website: "https://lifecycle.example.com" });
      const fourth = await runMatcher();
      expect(fourth.candidatesReactivated).toBe(1);
      expect(fourth.candidatesCreated).toBe(0);

      const revived = await candidateBetween(a.identityId, b.identityId);
      // The SAME row: this is the current-candidate record for this pair, so a
      // second row would be a second thing to review for one relationship.
      expect(revived!.id).toBe(appeared!.id);
      expect(revived!.status).toBe("pending");
      expect(revived!.superseded_reason).toBeNull();
      expect(revived!.resolved_at).toBeNull();

      const fifth = await runMatcher();
      expect([
        fifth.candidatesCreated,
        fifth.candidatesReactivated,
        fifth.candidatesSuperseded,
        fifth.candidatesEvidenceUpdated,
      ]).toEqual([0, 0, 0, 0]);
    });

    it("a pair that stays current but whose evidence changes is refreshed in place", async () => {
      const a = await identity({ website: "https://refresh.example.com", name: "Alpha One" });
      const b = await identity({ website: "https://refresh.example.com", name: "Beta Two" });
      await runMatcher();
      const before = await candidateBetween(a.identityId, b.identityId);
      expect(before!.name_evidence).toBe("none");

      // Still linked by domain; now the names agree too.
      await addObservation(a, { website: "https://refresh.example.com", name: "Beta Two" });
      const run = await runMatcher();
      expect(run.candidatesEvidenceUpdated).toBe(1);
      expect(run.candidatesSuperseded).toBe(0);

      const after = await candidateBetween(a.identityId, b.identityId);
      expect(after!.id).toBe(before!.id);
      expect(after!.name_evidence).toBe("exact");
      expect(after!.status).toBe("pending");
    });

    it("never stands down a candidate it did not generate", async () => {
      const x = await identity({});
      const y = await identity({});
      const [low, high] =
        x.identityId < y.identityId ? [x.identityId, y.identityId] : [y.identityId, x.identityId];
      await adminQuery(
        `insert into public.source_match_candidates
           (source_property_identity_id, candidate_source_property_identity_id, source,
            source_environment, candidate_kind, match_method, review_note)
         values ($1,$2,$3,'evaluation','source_identity','manual_search','found by an editor')`,
        [low, high, SOURCE],
      );
      await runMatcher();
      const row = await candidateBetween(low, high);
      // No blocking rule supports it, and it is still pending: `match_method`
      // does not carry the generator's mark, so the generator leaves it alone.
      expect(row!.status).toBe("pending");
      expect(row!.superseded_reason).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // GEOGRAPHY COMES FROM THE OBSERVATION BEING COMPARED
  // -----------------------------------------------------------------------
  describe("destination evidence is aligned to the latest observation", () => {
    it("uses the LATEST observation's own run, not the first-seen run", async () => {
      const f = await identity({ destinationId: DEST.bali, name: "Moved Property" });
      await addObservation(f, { destinationId: DEST.ubud, name: "Moved Property v2" });

      const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
      await client.connect();
      let loaded;
      try {
        loaded = await loadBlockableIdentities(client, {
          source: SOURCE,
          environment: "evaluation",
        });
      } finally {
        await client.end();
      }
      const mine = loaded.find((i) => i.identityId === f.identityId)!;
      // Latest fields AND the geography of the run that observed them: one
      // current evidence unit, not two moments spliced together.
      expect(mine.name).toBe("Moved Property v2");
      expect(mine.destinationId).toBe(DEST.ubud);
      expect(mine.destinationId).not.toBe(DEST.bali);
    });

    it("UNKNOWN destination is not the SAME destination", () => {
      const make = (
        id: string,
        destinationId: string | null,
        over: Partial<typeof blank> = {},
      ) => ({
        identityId: id,
        observationId: `o${id}`,
        destinationId,
        ...blank,
        ...over,
      });

      for (const [label, over] of [
        ["name", { name: "Identical Villa Name" }],
        ["domain", { websiteUrl: "https://unknown-geo.example.com" }],
        ["phone", { phone: "+62361999888" }],
      ] as const) {
        const result = discoverCandidates([make("a", null, over), make("b", null, over)]);
        expect(result.pairs, `${label} paired two unknown-geography identities`).toHaveLength(0);
        // Not silently dropped: reported as what it is.
        expect(result.incompleteGeography.length, `${label} not reported`).toBeGreaterThan(0);
        // …and an absent destination is not a second destination either.
        expect(result.crossDestinationCollisions, `${label} faked an anomaly`).toHaveLength(0);
      }
    });

    it("two KNOWN and equal destinations still pair normally", () => {
      const make = (id: string, destinationId: string) => ({
        identityId: id,
        observationId: `o${id}`,
        destinationId,
        ...blank,
        name: "Identical Villa Name",
      });
      expect(discoverCandidates([make("a", "bali"), make("b", "bali")]).pairs).toHaveLength(1);
      const cross = discoverCandidates([make("a", "bali"), make("b", "dubai")]);
      expect(cross.pairs).toHaveLength(0);
      expect(cross.crossDestinationCollisions.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // THE REVIEW PARTITION
  // -----------------------------------------------------------------------
  // Every queue is derived from ONE current discovery result, because the way
  // queues stop agreeing is by being computed in different places from
  // different sources.
  describe("review queues describe CURRENT state", () => {
    /** The CANDIDATES queue exactly as the manifest builds it. */
    async function actionableQueue() {
      const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
      await client.connect();
      try {
        const rows = await client.query<{ candidate_id: string; status: string }>(CANDIDATE_QUERY, [
          SOURCE,
          "evaluation",
          1000,
          "pending",
        ]);
        const total = await client.query<{ n: string }>(ACTIONABLE_COUNT_QUERY, [
          SOURCE,
          "evaluation",
          "pending",
        ]);
        return { ids: rows.rows.map((r) => r.candidate_id), total: Number(total.rows[0]!.n) };
      } finally {
        await client.end();
      }
    }

    async function currentPartition() {
      const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
      await client.connect();
      try {
        const identities = await loadBlockableIdentities(client, {
          source: SOURCE,
          environment: "evaluation",
        });
        return partitionForReview(identities, discoverCandidates(identities));
      } finally {
        await client.end();
      }
    }

    it("2. a current pending pair IS in the CANDIDATES queue, and the count agrees", async () => {
      const a = await identity({ website: "https://queue-pending.example.com" });
      const b = await identity({ website: "https://queue-pending.example.com" });
      await runMatcher();
      const row = await candidateBetween(a.identityId, b.identityId);
      const queue = await actionableQueue();
      expect(queue.ids).toContain(row!.id);
      // The list and the total must use identical semantics, or the header lies.
      expect(queue.total).toBe(queue.ids.length);
    });

    it("3. a MACHINE-SUPERSEDED pair is NOT in the CANDIDATES queue", async () => {
      const a = await identity({ website: "https://queue-stale.example.com" });
      const b = await identity({ website: "https://queue-stale.example.com" });
      await runMatcher();
      const row = await candidateBetween(a.identityId, b.identityId);
      expect((await actionableQueue()).ids).toContain(row!.id);

      await addObservation(a, { website: "https://queue-moved.example.com" });
      await runMatcher();
      const after = await candidateBetween(a.identityId, b.identityId);
      expect(after!.status).toBe("superseded");
      // History, not an action item — and still on record.
      expect((await actionableQueue()).ids).not.toContain(row!.id);
      expect(after!.id).toBe(row!.id);
    });

    it("4. an ACCEPTED, REJECTED or human-SUPERSEDED candidate is NOT actionable", async () => {
      for (const status of ["accepted", "rejected", "superseded"]) {
        const a = await identity({ website: `https://decided-${status}.example.com` });
        const b = await identity({ website: `https://decided-${status}.example.com` });
        await runMatcher();
        const row = await candidateBetween(a.identityId, b.identityId);
        await adminQuery(
          `update public.source_match_candidates set status = $2, resolved_at = now() where id = $1`,
          [row!.id, status],
        );
        expect((await actionableQueue()).ids, status).not.toContain(row!.id);
      }
    });

    it("5. classification follows CURRENT discovery, not historical rows", async () => {
      const a = await identity({ website: "https://queue-history.example.com" });
      const b = await identity({ website: "https://queue-history.example.com" });
      await runMatcher();
      let partition = await currentPartition();
      expect(partition.inPairs.has(a.identityId)).toBe(true);
      expect(partition.noMachineFinding).not.toContain(a.identityId);

      // The pair disappears. A row remains on record — and MUST NOT keep these
      // identities out of "nothing surfaced" forever.
      await addObservation(a, { website: "https://queue-history-gone.example.com" });
      await runMatcher();
      expect(await candidateBetween(a.identityId, b.identityId)).toBeDefined();

      partition = await currentPartition();
      expect(partition.inPairs.has(a.identityId)).toBe(false);
      expect(partition.noMachineFinding).toContain(a.identityId);
      expect(partition.noMachineFinding).toContain(b.identityId);
    });

    it("6. a shared-key CLUSTER identity is NOT in NO MACHINE CANDIDATE", async () => {
      // The OYO shape: three or more properties behind one group domain produce
      // a cluster and no pairs. The machine found something material about every
      // one of them.
      const key = `https://cluster-${uniq()}.example.com`;
      const members = [
        await identity({ website: key }),
        await identity({ website: key }),
        await identity({ website: key }),
      ];
      const partition = await currentPartition();
      for (const m of members) {
        expect(partition.inSharedKeyClusters.has(m.identityId)).toBe(true);
        expect(partition.inPairs.has(m.identityId)).toBe(false);
        expect(partition.noMachineFinding).not.toContain(m.identityId);
      }
    });

    it("7. a CROSS-DESTINATION anomaly identity is NOT in NO MACHINE CANDIDATE", async () => {
      const key = `https://chain-${uniq()}.example.com`;
      const bali = await identity({ website: key, destinationId: DEST.bali });
      const other = await identity({ website: key, destinationId: DEST.ubud });
      const partition = await currentPartition();
      for (const f of [bali, other]) {
        expect(partition.inCrossDestinationAnomalies.has(f.identityId)).toBe(true);
        expect(partition.inPairs.has(f.identityId)).toBe(false);
        expect(partition.noMachineFinding).not.toContain(f.identityId);
      }
    });

    it("8/9. an INCOMPLETE-GEOGRAPHY identity is surfaced, not swallowed", async () => {
      // A run with no destination: geography unknown, so no destination-scoped
      // rule can fire — but the shared key is still a finding.
      const runId = (
        await adminQuery<{ id: string }>(
          `insert into public.source_runs (source, source_environment, destination_id, run_mode, started_at)
           values ($1,'evaluation',null,'evaluation', now()) returning id`,
          [SOURCE],
        )
      )[0]!.id;
      const key = `https://nogeo-${uniq()}.example.com`;
      const a = await identity({ website: key, runId });
      const b = await identity({ website: key, runId });

      const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
      await client.connect();
      let discovery;
      try {
        const identities = await loadBlockableIdentities(client, {
          source: SOURCE,
          environment: "evaluation",
        });
        discovery = discoverCandidates(identities);
        var partition = partitionForReview(identities, discovery);
      } finally {
        await client.end();
      }

      // 9. visible in the ANOMALIES data the manifest renders.
      // The finding carries the NORMALISED key — the same string blocking used.
      const finding = discovery.incompleteGeography.find((g) => g.key === normalizeDomain(key));
      expect(finding, "incomplete geography not reported").toBeDefined();
      expect(finding!.identityIds.sort()).toEqual([a.identityId, b.identityId].sort());
      expect(finding!.reason).toBe("exact_domain");

      // 8. and NOT counted as "nothing surfaced".
      for (const f of [a, b]) {
        expect(partition!.inIncompleteGeography.has(f.identityId)).toBe(true);
        expect(partition!.inPairs.has(f.identityId)).toBe(false);
        expect(partition!.noMachineFinding).not.toContain(f.identityId);
      }
    });

    it("10. an identity with NO finding of any kind IS in NO MACHINE CANDIDATE", async () => {
      const lonely = await identity({ name: `Nothing Shares This ${uniq()}` });
      const partition = await currentPartition();
      expect(partition.inPairs.has(lonely.identityId)).toBe(false);
      expect(partition.inSharedKeyClusters.has(lonely.identityId)).toBe(false);
      expect(partition.inCrossDestinationAnomalies.has(lonely.identityId)).toBe(false);
      expect(partition.inIncompleteGeography.has(lonely.identityId)).toBe(false);
      expect(partition.noMachineFinding).toContain(lonely.identityId);
    });

    it("11. the NO MACHINE CANDIDATE display geography is the LATEST observation's", async () => {
      const f = await identity({
        name: `Relocated ${uniq()}`,
        destinationId: DEST.bali,
      });
      await addObservation(f, { name: `Relocated v2 ${uniq()}`, destinationId: DEST.ubud });

      // The manifest renders this identity from the same query shape.
      const rows = await adminQuery<{ slug: string | null; source_name: string | null }>(
        `select d.slug, o.source_name
           from public.source_property_identities i
           join lateral (select o.source_name, o.source_run_id
                           from public.source_property_observations o
                          where o.source_property_identity_id = i.id
                          order by o.observed_at desc, o.id desc limit 1) o on true
           join public.source_runs r on r.id = o.source_run_id
           left join public.destinations d on d.id = r.destination_id
          where i.id = $1`,
        [f.identityId],
      );
      expect(rows[0]!.slug).toBe("ubud");
      expect(rows[0]!.source_name).toMatch(/^Relocated v2/);

      const partition = await currentPartition();
      expect(partition.noMachineFinding).toContain(f.identityId);
    });

    it("the finding sets OVERLAP, and only the residual is exclusive", async () => {
      // One identity can be in a pair on its phone and in a cluster on its
      // chain domain, and both facts are true.
      const domain = `https://overlap-${uniq()}.example.com`;
      const phone = "+62361700700";
      const a = await identity({ website: domain, phone });
      const b = await identity({ website: domain, phone });
      await identity({ website: domain });

      const partition = await currentPartition();
      expect(partition.inSharedKeyClusters.has(a.identityId)).toBe(true);
      expect(partition.inPairs.has(a.identityId)).toBe(true);
      expect(partition.inPairs.has(b.identityId)).toBe(true);
      expect(partition.noMachineFinding).not.toContain(a.identityId);
    });
  });

  // -----------------------------------------------------------------------
  // The CANDIDATES queue reads PERSISTED rows, so unlike the other two queues
  // it can silently fall behind the evidence. The gate compares the generator's
  // own pair set against a live sweep, and refuses rather than filters.
  describe("the CANDIDATES sync gate fails CLOSED", () => {
    /**
     * Current discovery vs persisted machine pairs, exactly as the manifest
     * checks it — but restricted to the identities THIS test created.
     *
     * The gate itself is global, and has to be: an unpersisted pair anywhere is
     * a pair no reviewer can see. These tests share one database with fifty
     * others that deliberately leave drifting fixtures behind, so a global
     * assertion here would measure that ambient state rather than the behaviour
     * under test. Scoping the comparison keeps the assertion about this pair.
     */
    async function syncState(...owned: Fixture[]) {
      const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
      await client.connect();
      try {
        const identities = await loadBlockableIdentities(client, {
          source: SOURCE,
          environment: "evaluation",
        });
        const discovery = discoverCandidates(identities);
        const persisted = await loadPersistedMachinePairs(client, {
          source: SOURCE,
          environment: "evaluation",
        });
        const accounted = await loadAccountedNonMachinePairs(client, {
          source: SOURCE,
          environment: "evaluation",
        });
        const mine = new Set(owned.map((f) => f.identityId));
        const scope = (pairs: readonly PairKey[]) =>
          mine.size === 0
            ? pairs
            : pairs.filter((p) => mine.has(p.leftIdentityId) || mine.has(p.rightIdentityId));
        return compareMachinePairSync(scope(discovery.pairs), scope(persisted), scope(accounted));
      } finally {
        await client.end();
      }
    }

    it("1. persisted machine state matching current discovery lets review proceed", async () => {
      const key = `https://sync-ok-${uniq()}.example.com`;
      const a = await identity({ website: key });
      const b = await identity({ website: key });
      await runMatcher();

      const sync = await syncState(a, b);
      expect(sync.inSync, JSON.stringify(sync)).toBe(true);
      expect(sync.discoveredNotPersisted).toHaveLength(0);
      expect(sync.persistedNotDiscovered).toHaveLength(0);
    });

    it("2. a stale pending row REFUSES the queue when the matcher has not re-run", async () => {
      const key = `https://sync-stale-${uniq()}.example.com`;
      const a = await identity({ website: key });
      const b = await identity({ website: key });
      await runMatcher();
      expect((await syncState(a, b)).inSync).toBe(true);

      // The provider corrects A so the pair shares nothing. No matcher run.
      await addObservation(a, { name: `Now Unrelated ${uniq()}` });

      const sync = await syncState(a, b);
      expect(sync.inSync).toBe(false);
      expect(sync.persistedNotDiscovered).toHaveLength(1);
      expect(sync.discoveredNotPersisted).toHaveLength(0);
      const [stale] = sync.persistedNotDiscovered;
      expect([stale!.leftIdentityId, stale!.rightIdentityId].sort()).toEqual(
        [a.identityId, b.identityId].sort(),
      );

      // And the operator is told what to run — not offered a filtered queue.
      const message = outOfSyncMessage(sync, SOURCE);
      expect(message).toContain("NOT current");
      expect(message).toContain(`npm run source:match -- --provider ${SOURCE} --apply`);
    });

    it("3. running the matcher supersedes the stale row and restores sync", async () => {
      const key = `https://sync-restore-${uniq()}.example.com`;
      const a = await identity({ website: key });
      const b = await identity({ website: key });
      await runMatcher();
      await addObservation(a, { name: `Now Unrelated ${uniq()}` });
      expect((await syncState(a, b)).inSync).toBe(false);

      const counts = await runMatcher();
      expect(counts.candidatesSuperseded).toBeGreaterThanOrEqual(1);

      const row = await candidateBetween(a.identityId, b.identityId);
      expect(row!.status).toBe("superseded");
      expect(row!.superseded_reason).toBe("no_current_blocking_rule");
      expect((await syncState(a, b)).inSync).toBe(true);
    });

    it("4. a newly discovered pair nobody persisted REFUSES the queue", async () => {
      const key = `https://sync-unpersisted-${uniq()}.example.com`;
      const a = await identity({ website: key });
      const b = await identity({ website: key });
      // Deliberately no matcher run: discovery sees the pair, the queue cannot.
      const sync = await syncState(a, b);
      expect(sync.inSync).toBe(false);
      expect(sync.discoveredNotPersisted).toHaveLength(1);
      const [fresh] = sync.discoveredNotPersisted;
      expect([fresh!.leftIdentityId, fresh!.rightIdentityId].sort()).toEqual(
        [a.identityId, b.identityId].sort(),
      );
    });

    it("5. persisting it restores sync", async () => {
      const key = `https://sync-persist-${uniq()}.example.com`;
      const a = await identity({ website: key });
      const b = await identity({ website: key });
      expect((await syncState(a, b)).inSync).toBe(false);

      await runMatcher();
      expect((await syncState(a, b)).inSync).toBe(true);
    });

    it("6. a MANUAL pending candidate is review work, not a sync failure", async () => {
      // A reviewer's own pair. Discovery never claimed to produce it, so its
      // absence from the sweep says nothing about whether the sweep is current.
      const a = await identity({ name: `Manual Left ${uniq()}` });
      const b = await identity({ name: `Manual Right ${uniq()}` });
      const [left, right] =
        a.identityId < b.identityId ? [a.identityId, b.identityId] : [b.identityId, a.identityId];
      await adminQuery(
        `insert into public.source_match_candidates
           (source, source_environment, source_property_identity_id,
            candidate_source_property_identity_id, candidate_kind, match_method, status,
            name_evidence, domain_evidence, address_evidence, phone_evidence, brand_evidence)
         values ($1,'evaluation',$2,$3,'source_identity','manual_search','pending',
                 'none','unavailable','unavailable','unavailable','unavailable')`,
        [SOURCE, left, right],
      );
      await runMatcher();

      expect((await syncState(a, b)).inSync).toBe(true);

      // It is still actionable review work, and it is still labelled as manual.
      const row = await candidateBetween(a.identityId, b.identityId);
      const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
      await client.connect();
      try {
        const queue = await client.query<{ candidate_id: string; match_method: string }>(
          CANDIDATE_QUERY,
          [SOURCE, "evaluation", 1000, "pending"],
        );
        expect(queue.rows.map((r) => r.candidate_id)).toContain(row!.id as string);
      } finally {
        await client.end();
      }
      expect(
        isGeneratorOwned({
          candidateKind: row!.candidate_kind as string,
          matchMethod: row!.match_method as string,
        }),
      ).toBe(false);
    });

    it("7. accepted / rejected / human-superseded rows are outside the machine sync set", async () => {
      const decided: { id: string; pair: string }[] = [];
      const involved: Fixture[] = [];
      for (const status of ["accepted", "rejected", "superseded"] as const) {
        const key = `https://sync-decided-${status}-${uniq()}.example.com`;
        const a = await identity({ website: key });
        const b = await identity({ website: key });
        await runMatcher();
        const row = await candidateBetween(a.identityId, b.identityId);
        // A HUMAN decision: no superseded_reason is recorded for any of them.
        await adminQuery(
          `update public.source_match_candidates set status = $2, resolved_at = now(),
                  review_note = 'human decision' where id = $1`,
          [row!.id, status],
        );
        decided.push({
          id: row!.id as string,
          pair: [a.identityId, b.identityId].sort().join(" "),
        });
        involved.push(a, b);
      }

      const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
      await client.connect();
      try {
        // Discovery still produces all three pairs, but none of them is
        // ACTIONABLE MACHINE state any more, so neither side of the comparison
        // carries them and the gate has nothing to disagree about.
        const persisted = await loadPersistedMachinePairs(client, {
          source: SOURCE,
          environment: "evaluation",
        });
        const persistedPairs = persisted.map((p) =>
          [p.leftIdentityId, p.rightIdentityId].sort().join(" "),
        );
        for (const d of decided) expect(persistedPairs).not.toContain(d.pair);

        // And the matcher leaves every one of them exactly as the human left it.
        const counts = await generateCandidates(client, {
          source: SOURCE,
          environment: "evaluation",
          runId: null,
          apply: true,
        });
        expect(counts.candidatesDecidedSkipped).toBeGreaterThanOrEqual(3);
      } finally {
        await client.end();
      }

      for (const d of decided) {
        const rows = await adminQuery<{ status: string; superseded_reason: string | null }>(
          "select status, superseded_reason from public.source_match_candidates where id = $1",
          [d.id],
        );
        expect(rows[0]!.superseded_reason).toBeNull();
      }
      expect((await syncState(...involved)).inSync).toBe(true);
    });

    it("8. machine-superseded history is outside the current actionable sync set", async () => {
      const key = `https://sync-history-${uniq()}.example.com`;
      const a = await identity({ website: key });
      const b = await identity({ website: key });
      await runMatcher();
      await addObservation(a, { name: `Now Unrelated ${uniq()}` });
      await runMatcher();

      const row = await candidateBetween(a.identityId, b.identityId);
      expect(row!.status).toBe("superseded");

      const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
      await client.connect();
      try {
        const persisted = await loadPersistedMachinePairs(client, {
          source: SOURCE,
          environment: "evaluation",
        });
        const ids = persisted.map((p) => `${p.leftIdentityId} ${p.rightIdentityId}`);
        const pair = [a.identityId, b.identityId].sort().join(" ");
        expect(ids).not.toContain(pair);
      } finally {
        await client.end();
      }
      expect((await syncState(a, b)).inSync).toBe(true);
    });

    it("compares pairs UNORDERED, and reports each direction of disagreement", () => {
      // Pure, so the gate is auditable without a database.
      const x = "00000000-0000-4000-8000-000000000001";
      const y = "00000000-0000-4000-8000-000000000002";
      const z = "00000000-0000-4000-8000-000000000003";

      expect(
        compareMachinePairSync(
          [{ leftIdentityId: x, rightIdentityId: y }],
          [{ leftIdentityId: y, rightIdentityId: x }],
        ).inSync,
      ).toBe(true);

      const drift = compareMachinePairSync(
        [{ leftIdentityId: x, rightIdentityId: y }],
        [{ leftIdentityId: x, rightIdentityId: z }],
      );
      expect(drift.inSync).toBe(false);
      expect(drift.discoveredNotPersisted).toHaveLength(1);
      expect(drift.persistedNotDiscovered).toHaveLength(1);

      expect(compareMachinePairSync([], []).inSync).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // One pair is one row, so when a reviewer creates A↔B by hand the
  // generator's INSERT conflicts with THEIR row. What happens next is the
  // whole question: the generator must leave it alone rather than seize it.
  describe("a MANUAL pending pair belongs to the human who made it", () => {
    /** A reviewer's own pair, created the way a review tool would. */
    async function manualPair(a: Fixture, b: Fixture, note = "reviewer found this") {
      const [left, right] =
        a.identityId < b.identityId ? [a.identityId, b.identityId] : [b.identityId, a.identityId];
      const rows = await adminQuery<{ id: string }>(
        `insert into public.source_match_candidates
           (source, source_environment, source_property_identity_id,
            candidate_source_property_identity_id, candidate_kind, match_method, status,
            name_evidence, domain_evidence, address_evidence, phone_evidence, brand_evidence,
            review_note)
         values ($1,'evaluation',$2,$3,'source_identity','manual_search','pending',
                 'none','unavailable','unavailable','unavailable','unavailable',$4)
         returning id`,
        [SOURCE, left, right, note],
      );
      return rows[0]!.id;
    }

    /** Every column that matters, so "byte-identical" is a real assertion. */
    async function snapshot(id: string) {
      const rows = await adminQuery<Record<string, unknown>>(
        `select id::text, match_method, status, candidate_kind, superseded_reason,
                resolved_at::text, review_note, name_evidence, domain_evidence,
                address_evidence, phone_evidence, brand_evidence,
                coordinate_distance_metres::text, agreeing_dimensions::text
           from public.source_match_candidates where id = $1`,
        [id],
      );
      return rows[0]!;
    }

    async function accountedFor(a: Fixture, b: Fixture) {
      const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
      await client.connect();
      try {
        const identities = await loadBlockableIdentities(client, {
          source: SOURCE,
          environment: "evaluation",
        });
        const discovery = discoverCandidates(identities);
        const persisted = await loadPersistedMachinePairs(client, {
          source: SOURCE,
          environment: "evaluation",
        });
        const accounted = await loadAccountedNonMachinePairs(client, {
          source: SOURCE,
          environment: "evaluation",
        });
        const mine = new Set([a.identityId, b.identityId]);
        const scope = (pairs: readonly PairKey[]) =>
          pairs.filter((p) => mine.has(p.leftIdentityId) || mine.has(p.rightIdentityId));
        return compareMachinePairSync(scope(discovery.pairs), scope(persisted), scope(accounted));
      } finally {
        await client.end();
      }
    }

    it("1. with no machine blocking rule, the matcher leaves it byte-identical", async () => {
      const a = await identity({ name: `Manual Only Left ${uniq()}` });
      const b = await identity({ name: `Manual Only Right ${uniq()}` });
      const id = await manualPair(a, b);
      const before = await snapshot(id);

      await runMatcher();

      expect(await snapshot(id)).toEqual(before);
    });

    it("2. once the SAME pair becomes machine-discoverable, the gate is satisfied", async () => {
      const a = await identity({ name: `Overlap Left ${uniq()}` });
      const b = await identity({ name: `Overlap Right ${uniq()}` });
      await manualPair(a, b);
      await runMatcher();

      // The provider now gives both the same domain: discovery produces A↔B.
      const key = `https://manual-overlap-${uniq()}.example.com`;
      await addObservation(a, { name: `Overlap Left ${uniq()}`, website: key });
      await addObservation(b, { name: `Overlap Right ${uniq()}`, website: key });

      const sync = await accountedFor(a, b);
      // The relationship IS in front of a reviewer. Demanding a machine row the
      // unique-pair invariant forbids would be an alarm nothing could clear.
      expect(sync.inSync, JSON.stringify(sync)).toBe(true);
      expect(sync.discoveredNotPersisted).toHaveLength(0);
    });

    it("3. the matcher acquires NO ownership of it, on any number of runs", async () => {
      const a = await identity({ name: `No Seize Left ${uniq()}` });
      const b = await identity({ name: `No Seize Right ${uniq()}` });
      const id = await manualPair(a, b);
      const key = `https://manual-noseize-${uniq()}.example.com`;
      await addObservation(a, { name: `No Seize Left ${uniq()}`, website: key });
      await addObservation(b, { name: `No Seize Right ${uniq()}`, website: key });

      const before = await snapshot(id);
      const counts = await runMatcher();
      expect(counts.candidatesManualSkipped).toBeGreaterThanOrEqual(1);

      const after = await snapshot(id);
      expect(after).toEqual(before);
      expect(after.match_method).toBe("manual_search");
      expect(after.status).toBe("pending");
      expect(after.superseded_reason).toBeNull();

      // And still exactly one row for the pair — no shadow machine candidate.
      const rows = await adminQuery<{ n: string }>(
        `select count(*)::text n from public.source_match_candidates
          where candidate_kind = 'source_identity'
            and (source_property_identity_id = $1 or candidate_source_property_identity_id = $1)`,
        [a.identityId],
      );
      expect(rows[0]!.n).toBe("1");
    });

    it("4. when the machine evidence disappears, it is NOT superseded", async () => {
      const a = await identity({ name: `No Standdown Left ${uniq()}` });
      const b = await identity({ name: `No Standdown Right ${uniq()}` });
      const id = await manualPair(a, b);
      const key = `https://manual-nostanddown-${uniq()}.example.com`;
      await addObservation(a, { name: `No Standdown Left ${uniq()}`, website: key });
      await addObservation(b, { name: `No Standdown Right ${uniq()}`, website: key });
      await runMatcher();

      // The domain goes away again. A machine row would be stood down here.
      await addObservation(a, { name: `No Standdown Left ${uniq()}` });
      await runMatcher();

      const after = await snapshot(id);
      expect(after.status).toBe("pending");
      expect(after.match_method).toBe("manual_search");
      expect(after.superseded_reason).toBeNull();
    });

    it("5. once a human decides it, decided-pair accounting still holds", async () => {
      const a = await identity({ name: `Manual Decided Left ${uniq()}` });
      const b = await identity({ name: `Manual Decided Right ${uniq()}` });
      const id = await manualPair(a, b);
      const key = `https://manual-decided-${uniq()}.example.com`;
      await addObservation(a, { name: `Manual Decided Left ${uniq()}`, website: key });
      await addObservation(b, { name: `Manual Decided Right ${uniq()}`, website: key });
      await runMatcher();

      await adminQuery(
        `update public.source_match_candidates set status = 'accepted', resolved_at = now(),
                review_note = 'reviewer decided' where id = $1`,
        [id],
      );
      const counts = await runMatcher();
      expect(counts.candidatesDecidedSkipped).toBeGreaterThanOrEqual(1);
      expect((await snapshot(id)).status).toBe("accepted");
      expect((await accountedFor(a, b)).inSync).toBe(true);
    });

    it("6. an exact replay changes nothing", async () => {
      const a = await identity({ name: `Manual Replay Left ${uniq()}` });
      const b = await identity({ name: `Manual Replay Right ${uniq()}` });
      const id = await manualPair(a, b);
      const key = `https://manual-replay-${uniq()}.example.com`;
      await addObservation(a, { name: `Manual Replay Left ${uniq()}`, website: key });
      await addObservation(b, { name: `Manual Replay Right ${uniq()}`, website: key });
      await runMatcher();

      const before = await snapshot(id);
      const replay = await runMatcher();
      expect(replay.candidatesCreated).toBe(0);
      expect(replay.candidatesEvidenceUpdated).toBe(0);
      expect(replay.candidatesSuperseded).toBe(0);
      expect(replay.candidatesReactivated).toBe(0);
      expect(await snapshot(id)).toEqual(before);
    });

    it("generator ownership needs the KIND as well as the method", () => {
      // A canonical_hotel row is not something generateCandidates produces, and
      // a blocking-shaped match_method on one must not make it machine state.
      expect(
        isGeneratorOwned({
          candidateKind: "canonical_hotel",
          matchMethod: "blocking:exact_name_in_destination",
        }),
      ).toBe(false);
      expect(
        isGeneratorOwned({ candidateKind: "new_property", matchMethod: "blocking:exact_domain" }),
      ).toBe(false);
      expect(
        isGeneratorOwned({ candidateKind: "source_identity", matchMethod: "manual_search" }),
      ).toBe(false);
      expect(
        isGeneratorOwned({
          candidateKind: "source_identity",
          matchMethod: "blocking:exact_domain",
        }),
      ).toBe(true);
    });

    it("a canonical_hotel row with a blocking method is NOT machine state", async () => {
      const f = await identity({ name: `Synthetic Canonical ${uniq()}` });
      await adminQuery(
        `insert into public.source_match_candidates
           (source, source_environment, source_property_identity_id, candidate_hotel_id,
            candidate_kind, match_method, status,
            name_evidence, domain_evidence, address_evidence, phone_evidence, brand_evidence)
         values ($1,'evaluation',$2,$3,'canonical_hotel','blocking:exact_name_in_destination',
                 'pending','exact','unavailable','unavailable','unavailable','unavailable')`,
        [SOURCE, f.identityId, HOTEL.bali],
      );

      const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
      await client.connect();
      try {
        // The sync gate reads source↔source pairs only, so a canonical_hotel row
        // can never enter the machine set no matter how its method is spelled.
        const persisted = await loadPersistedMachinePairs(client, {
          source: SOURCE,
          environment: "evaluation",
        });
        expect(
          persisted.some(
            (p) => p.leftIdentityId === f.identityId || p.rightIdentityId === f.identityId,
          ),
        ).toBe(false);
      } finally {
        await client.end();
      }
    });
  });

  // -----------------------------------------------------------------------
  // A key seen in more than one KNOWN destination is a fact about the KEY:
  // `marriott.com` is not property-level identity evidence inside Bali just
  // because the Dubai Marriotts sit in a different bucket.
  describe("a cross-destination key contributes ZERO pairs, everywhere", () => {
    const pairOf = (d: DiscoveryResult, a: Fixture, b: Fixture) =>
      d.pairs.find(
        (p) =>
          (p.leftIdentityId === a.identityId && p.rightIdentityId === b.identityId) ||
          (p.leftIdentityId === b.identityId && p.rightIdentityId === a.identityId),
      );

    async function discover() {
      const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
      await client.connect();
      try {
        return discoverCandidates(
          await loadBlockableIdentities(client, { source: SOURCE, environment: "evaluation" }),
        );
      } finally {
        await client.end();
      }
    }

    it("1. two Bali + one Dubai on one domain → anomaly, and NO pair", async () => {
      const key = `https://veto-basic-${uniq()}.example.com`;
      const a = await identity({ website: key, destinationId: DEST.bali });
      const b = await identity({ website: key, destinationId: DEST.bali });
      await identity({ website: key, destinationId: DEST.ibiza });

      const d = await discover();
      const normalised = normalizeDomain(key);
      expect(d.crossDestinationCollisions.some((c) => c.key === normalised)).toBe(true);
      expect(pairOf(d, a, b)).toBeUndefined();
    });

    it("2. an INDEPENDENT destination-safe reason still stands on its own", async () => {
      const key = `https://veto-survivor-${uniq()}.example.com`;
      const phone = "+6236198765432";
      const a = await identity({ website: key, phone, destinationId: DEST.bali });
      const b = await identity({ website: key, phone, destinationId: DEST.bali });
      await identity({ website: key, destinationId: DEST.ibiza });

      const d = await discover();
      const pair = pairOf(d, a, b);
      expect(pair, "the phone pair must survive the domain veto").toBeDefined();
      // The vetoed REASON is gone; the pair is not.
      expect(pair!.reasons).toEqual(["exact_phone"]);
      expect(matchMethodFor(pair!.reasons)).toBe("blocking:exact_phone");
    });

    it("3. two Bali + two Dubai → no pair in EITHER destination", async () => {
      const key = `https://veto-both-${uniq()}.example.com`;
      const a = await identity({ website: key, destinationId: DEST.bali });
      const b = await identity({ website: key, destinationId: DEST.bali });
      const c = await identity({ website: key, destinationId: DEST.ibiza });
      const e = await identity({ website: key, destinationId: DEST.ibiza });

      const d = await discover();
      expect(pairOf(d, a, b)).toBeUndefined();
      expect(pairOf(d, c, e)).toBeUndefined();
      expect(d.crossDestinationCollisions.some((x) => x.key === normalizeDomain(key))).toBe(true);
    });

    it("4. three Bali + one Dubai → the CLUSTER survives, the pair never existed", async () => {
      const key = `https://veto-cluster-${uniq()}.example.com`;
      const a = await identity({ website: key, destinationId: DEST.bali });
      const b = await identity({ website: key, destinationId: DEST.bali });
      const c = await identity({ website: key, destinationId: DEST.bali });
      await identity({ website: key, destinationId: DEST.ibiza });

      const d = await discover();
      const normalised = normalizeDomain(key);
      // A cluster is not a pair, and "these three share a chain domain that also
      // appears elsewhere" is a true and useful thing to show a reviewer.
      const cluster = d.sharedKeyClusters.find((x) => x.key === normalised);
      expect(cluster, "the Bali cluster must remain").toBeDefined();
      expect(cluster!.identityIds.sort()).toEqual(
        [a.identityId, b.identityId, c.identityId].sort(),
      );
      expect(d.crossDestinationCollisions.some((x) => x.key === normalised)).toBe(true);
      expect(pairOf(d, a, b)).toBeUndefined();
    });

    it("5. exactly two in ONE destination still pairs normally", async () => {
      const key = `https://veto-none-${uniq()}.example.com`;
      const a = await identity({ website: key, destinationId: DEST.bali });
      const b = await identity({ website: key, destinationId: DEST.bali });

      const d = await discover();
      const pair = pairOf(d, a, b);
      expect(pair).toBeDefined();
      expect(pair!.reasons).toEqual(["exact_domain"]);
      expect(d.crossDestinationCollisions.some((x) => x.key === normalizeDomain(key))).toBe(false);
    });

    it("6. a NULL destination is not a second KNOWN destination, and vetoes nothing", async () => {
      const runId = (
        await adminQuery<{ id: string }>(
          `insert into public.source_runs (source, source_environment, destination_id, run_mode, started_at)
           values ($1,'evaluation',null,'evaluation', now()) returning id`,
          [SOURCE],
        )
      )[0]!.id;
      const key = `https://veto-null-${uniq()}.example.com`;
      const a = await identity({ website: key, destinationId: DEST.bali });
      const b = await identity({ website: key, destinationId: DEST.bali });
      await identity({ website: key, runId });

      const d = await discover();
      const normalised = normalizeDomain(key);
      expect(
        d.crossDestinationCollisions.some((x) => x.key === normalised),
        "unknown geography must not manufacture a cross-destination veto",
      ).toBe(false);
      const pair = pairOf(d, a, b);
      expect(pair).toBeDefined();
      expect(pair!.reasons).toEqual(["exact_domain"]);
    });
  });
});
