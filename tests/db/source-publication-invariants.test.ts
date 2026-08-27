/**
 * A05 AMENDMENT #1 — the publication invariants belong to the DATABASE.
 *
 * `tests/db/source-publication.test.ts` proves the A05 WRITER is correct. This
 * suite proves the database is correct *without* it, because 0024's ACL contract
 * deliberately gives admin/editor and `service_role` real write access to these
 * tables. "The writer checks it" is a statement about one code path reached
 * through one CLI; it is not an invariant.
 *
 * Three defects the external audit found, all reproduced on real PostgreSQL
 * before being fixed:
 *
 *   A. `resolved_eligible` WITHOUT a publication receipt committed happily.
 *      0027 accepted it (identity is production, has a promoted hotel, has an
 *      ACTIVE link) and 0034's deferred trigger returned early when no receipt
 *      existed. A canonical hotel could exist through the source-publication
 *      lifecycle with no human authorization behind it at all.
 *
 *   B. A REVOKED approval was still publishable by direct SQL. The trigger read
 *      the immutable review receipt and never asked whether that receipt is
 *      still the authorization in force — which is exactly the question A04.6
 *      exists to answer.
 *
 *   C. The canonical field policy was writer-only for name, address and country.
 *      Direct SQL could publish a name the human never affirmed, an address the
 *      human explicitly CONTRADICTED, or a fabricated country code.
 *
 * Every fixture is SYNTHETIC, and every attack below is plain SQL: no A05 writer,
 * no CLI, no application-layer refusal doing the work.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, setupDatabase, teardownDatabase } from "./harness";
import { seed, USERS } from "../rls/seed";
import { canonicalPublishedText } from "../../scripts/source-publication/publish";
import type { ReviewVerdict } from "../../scripts/human-review/pack";
import {
  approvedProperty,
  AS_OF,
  canonicalCounts,
  client,
  identityRow,
  newRun,
  pinsFor,
  preview,
  publicationItem,
  publish,
  revoke,
  SCOPE_CODE,
  setCompleteLifecycleSnapshot,
  setLocation,
  setScope,
  setStar,
  SOURCE,
  STAR_CODE,
  uniq,
  type Fixture,
  type Pins,
} from "./source-publication-fixtures";

const d = describe.skipIf(!hasTestDb);

/**
 * Direct SQL: a correctly-shaped canonical hotel and its ACTIVE link, built
 * WITHOUT the A05 writer. Overrides let each test bend exactly one field.
 */
async function directHotelAndLink(
  f: Fixture,
  over: {
    name?: string;
    address?: string | null;
    countryCode?: string | null;
    websiteUrl?: string | null;
    editorialStatus?: string;
  } = {},
): Promise<string> {
  const [dest] = await adminQuery<{ country_code: string | null }>(
    "select country_code from public.destinations where id = $1",
    [f.destinationId],
  );
  const [obs] = await adminQuery<{ source_name: string; source_address: string | null }>(
    "select source_name, source_address from public.source_property_observations where id = $1",
    [f.observationId],
  );
  const [hotel] = await adminQuery<{ id: string }>(
    `insert into public.hotels
       (name, slug, destination_id, country_code, address, latitude, longitude, star_rating,
        active_status, website_url, editorial_verification_status)
     values ($1,$2,$3,$4,$5,-8.5,115.26,4,'unknown',$6,$7) returning id`,
    [
      over.name ?? obs!.source_name,
      `direct-${f.sourcePropertyId}-${uniq()}`,
      f.destinationId,
      over.countryCode === undefined ? dest!.country_code : over.countryCode,
      over.address === undefined ? obs!.source_address : over.address,
      over.websiteUrl ?? null,
      over.editorialStatus ?? "unverified",
    ],
  );
  await adminQuery(
    `insert into public.hotel_source_identities
       (hotel_id, source_property_identity_id, source, source_environment, source_property_id,
        link_status, match_method)
     values ($1,$2,$3,'production',$4,'active','human_review:d062_approve_create')`,
    [hotel!.id, f.identityId, SOURCE, f.sourcePropertyId],
  );
  return hotel!.id;
}

/** Direct SQL: the publication receipt, with no writer-side checks in the way. */
function receiptSql(): string {
  return `insert into public.source_property_publication_receipts
       (source_property_identity_id, source, source_environment, source_property_id, hotel_id,
        evidence_observation_id, human_review_receipt_id, human_new_property_finding_id,
        star_revision_id, location_revision_id, scope_revision_id, preview_as_of,
        preview_schema_version, preview_fingerprint, publication_authorized_by_label,
        authorization_note, authorized_at, publication_digest)
     values ($1,$2,'production',$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12,$13,$14,$15, now(), $16)`;
}

function receiptParams(
  f: Fixture,
  hotelId: string,
  pins: Pins,
  over: { observationId?: string; reviewReceiptId?: string } = {},
): unknown[] {
  return [
    f.identityId,
    SOURCE,
    f.sourcePropertyId,
    hotelId,
    over.observationId ?? f.observationId,
    over.reviewReceiptId ?? pins.receiptId,
    pins.findingId,
    pins.starRevisionId,
    pins.locationRevisionId,
    pins.scopeRevisionId,
    AS_OF,
    "d062-prepublication-preview/1",
    "a".repeat(64),
    "direct sql",
    "bypassing the writer",
    "b".repeat(64),
  ];
}

/**
 * Run one direct-SQL attack in its own transaction on a dedicated connection and
 * report what the DATABASE decided at COMMIT. Deferred constraint triggers only
 * speak at commit time, so an attempt that "succeeds" statement by statement can
 * still be refused — which is the whole point of the two-sided invariant.
 */
async function attempt(work: (q: Client["query"]) => Promise<void>): Promise<string | null> {
  const c = await client();
  try {
    await c.query("begin");
    await work(c.query.bind(c) as Client["query"]);
    await c.query("commit");
    return null;
  } catch (error) {
    await c.query("rollback").catch(() => undefined);
    return (error as Error).message;
  } finally {
    await c.end();
  }
}

/** The full direct-SQL publication: hotel, link, receipt, terminal state. */
async function directPublish(
  f: Fixture,
  pins: Pins,
  over: Parameters<typeof directHotelAndLink>[1] &
    Parameters<typeof receiptParams>[3] & { skipReceipt?: boolean; skipPromotion?: boolean } = {},
): Promise<string | null> {
  return attempt(async (q) => {
    const [dest] = await adminQuery<{ country_code: string | null }>(
      "select country_code from public.destinations where id = $1",
      [f.destinationId],
    );
    const [obs] = await adminQuery<{ source_name: string; source_address: string | null }>(
      "select source_name, source_address from public.source_property_observations where id = $1",
      [f.observationId],
    );
    const hotel = await q(
      `insert into public.hotels
         (name, slug, destination_id, country_code, address, latitude, longitude, star_rating,
          active_status, website_url, editorial_verification_status)
       values ($1,$2,$3,$4,$5,-8.5,115.26,4,'unknown',$6,$7) returning id`,
      [
        over.name ?? obs!.source_name,
        `direct-${f.sourcePropertyId}-${uniq()}`,
        f.destinationId,
        over.countryCode === undefined ? dest!.country_code : over.countryCode,
        over.address === undefined ? obs!.source_address : over.address,
        over.websiteUrl ?? null,
        over.editorialStatus ?? "unverified",
      ],
    );
    const hotelId = (hotel.rows[0] as { id: string }).id;
    await q(
      `insert into public.hotel_source_identities
         (hotel_id, source_property_identity_id, source, source_environment, source_property_id,
          link_status, match_method)
       values ($1,$2,$3,'production',$4,'active','human_review:d062_approve_create')`,
      [hotelId, f.identityId, SOURCE, f.sourcePropertyId],
    );
    if (!over.skipReceipt) await q(receiptSql(), receiptParams(f, hotelId, pins, over));
    if (!over.skipPromotion)
      await q(
        `update public.source_property_identities
            set resolution_state = 'resolved_eligible', promoted_hotel_id = $2
          where id = $1`,
        [f.identityId, hotelId],
      );
  });
}

/** Advance the identity to a fresh observation, the way ingestion does. */
async function advance(f: Fixture): Promise<Fixture> {
  const runId = await newRun(f.destinationId, "production", 3600);
  const digest = `digest-${uniq()}`;
  const [o] = await adminQuery<{ id: string }>(
    `insert into public.source_property_observations
       (source_run_id, source_property_identity_id, source, source_environment, observed_at,
        source_name, source_address, source_latitude, source_longitude,
        source_coordinates_plausible, source_classification_code, source_property_type_code,
        source_payload_digest)
     values ($1,$2,$3,'production', now() + interval '1 hour', $4, $5, -8.5, 115.26, true, $6, $7, $8)
     returning id`,
    [runId, f.identityId, SOURCE, f.name, f.address, STAR_CODE, SCOPE_CODE, digest],
  );
  await adminQuery(
    "update public.source_property_identities set last_seen_run_id = $2 where id = $1",
    [f.identityId, runId],
  );
  await setStar(f.identityId, o!.id, "production");
  await setScope(f.identityId, o!.id, "production");
  await setLocation(f.identityId, o!.id, "production");
  await setCompleteLifecycleSnapshot(f.identityId, o!.id, runId, digest, "production");
  return { ...f, observationId: o!.id, runId, digest };
}

d("A05 publication invariants belong to the database (0034, amendment #1)", () => {
  beforeAll(async () => {
    await setupDatabase();
    await seed();
  });
  afterAll(teardownDatabase);

  // =====================================================================
  // A. THE TRUE TWO-SIDED IFF
  // =====================================================================
  describe("A. receipt exists IFF the identity is resolved_eligible against that hotel", () => {
    it("1. hotel + ACTIVE link + resolved_eligible with NO receipt is REFUSED at commit", async () => {
      const f = await approvedProperty();
      const pins = await pinsFor(f);
      const before = await canonicalCounts();

      // The reproduced defect: every one of 0027's own requirements is met, so
      // 0027 has nothing to object to. What is missing is the human.
      const error = await directPublish(f, pins, { skipReceipt: true });
      expect(error).toMatch(/`resolved_eligible`.*NO publication receipt|nobody signed/s);

      expect(await canonicalCounts()).toEqual(before);
      expect((await identityRow(f.identityId)).resolution_state).toBe("unresolved");
    });

    it("2. a receipt WITHOUT the terminal promotion is REFUSED at commit", async () => {
      const f = await approvedProperty();
      const pins = await pinsFor(f);
      const before = await canonicalCounts();

      const error = await directPublish(f, pins, { skipPromotion: true });
      expect(error).toMatch(/publication receipt .* but its terminal state is/s);

      expect(await canonicalCounts()).toEqual(before);
    });

    it("3. the normal A05 writer transaction still commits", async () => {
      const f = await approvedProperty();
      const report = await publish([await publicationItem(f)], { apply: true });
      const o = report.outcomes[0]!;
      expect(o.state).toBe("published");
      if (o.state === "refused") throw new Error(o.detail);
      const identity = await identityRow(f.identityId);
      expect(identity.resolution_state).toBe("resolved_eligible");
      expect(identity.promoted_hotel_id).toBe(o.hotelId);
    });

    it("4. an exact replay is unchanged and still coherent", async () => {
      const f = await approvedProperty();
      const item = await publicationItem(f);
      const first = await publish([item], { apply: true });
      const a = first.outcomes[0]!;
      if (a.state === "refused") throw new Error(a.detail);
      const after = await canonicalCounts();

      const second = await publish([item], { apply: true });
      const b = second.outcomes[0]!;
      expect(b.state).toBe("already_published");
      if (b.state === "refused") throw new Error(b.detail);
      expect(b.hotelId).toBe(a.hotelId);
      expect(await canonicalCounts()).toEqual(after);
    });

    it("a later DEMOTION cannot leave a receipt behind", async () => {
      const f = await approvedProperty();
      const report = await publish([await publicationItem(f)], { apply: true });
      if (report.outcomes[0]!.state === "refused") throw new Error("expected a publication");
      await expect(
        adminQuery(
          `update public.source_property_identities
              set resolution_state = 'unresolved', promoted_hotel_id = null
            where id = $1`,
          [f.identityId],
        ),
      ).rejects.toThrow(/publication receipt|resolved_eligible/i);
    });

    it("ordinary ingestion is untouched by the identity-side trigger", async () => {
      // The WHEN clauses keep it off the hot path: a run advances
      // `last_seen_run_id` and `observation_count`, never the three columns the
      // invariant is about.
      const f = await approvedProperty();
      await expect(
        adminQuery(
          "update public.source_property_identities set observation_count = observation_count + 1 where id = $1",
          [f.identityId],
        ),
      ).resolves.toBeDefined();
    });
  });

  // =====================================================================
  // B. THE APPROVAL MUST STILL BE IN FORCE
  // =====================================================================
  describe("B. a withdrawn or superseded approval cannot authorize publication", () => {
    it("5. approve A -> revoke A -> direct receipt citing A is REFUSED", async () => {
      const f = await approvedProperty();
      const pins = await pinsFor(f);
      await revoke(f);

      const p = await preview(f.sourcePropertyId, "production");
      expect(p.conditions.find((c) => c.number === 1)!.reason).toBe("human_review_revoked");

      const before = await canonicalCounts();
      const error = await directPublish(f, pins);
      expect(error).toMatch(/not authorized: review_status=revoked|revocation=/);
      expect(await canonicalCounts()).toEqual(before);
    });

    it("6. approve A -> fresh observation -> approve B: publishing HISTORICAL A is REFUSED", async () => {
      const f = await approvedProperty();
      const a = await pinsFor(f);
      const advanced = await advance(f);
      // A fresh human review of the fresh evidence, through the real A04.5 path.
      const report = await publish([], { apply: false });
      expect(report.outcomes).toHaveLength(0);
      await approveAgain(advanced);
      const b = await pinsFor(advanced);
      expect(b.receiptId).not.toBe(a.receiptId);

      const before = await canonicalCounts();
      // Cite A: A's own observation, A's receipt id.
      const error = await directPublish({ ...advanced, observationId: f.observationId }, a, {
        reviewReceiptId: a.receiptId,
        observationId: f.observationId,
      });
      expect(error).toMatch(
        /the current human projection represents|no longer that identity's current observation/,
      );
      expect(await canonicalCounts()).toEqual(before);
    });

    it("7. publishing the CURRENT active approval B succeeds", async () => {
      const f = await approvedProperty();
      const advanced = await advance(f);
      await approveAgain(advanced);
      const report = await publish([await publicationItem(advanced)], { apply: true });
      expect(report.outcomes[0]!.state).toBe("published");
    });

    it("8. status says `active` while an immutable revocation exists: still REFUSED", async () => {
      // The corruption A04.6 amendment #2 exists for, seen from A05: the mutable
      // column is repaired, the append-only event is not. The event dominates.
      const f = await approvedProperty();
      const pins = await pinsFor(f);
      await revoke(f);
      await adminQuery(
        `update public.source_property_reviews set review_status = 'active'
          where source_property_identity_id = $1`,
        [f.identityId],
      ).catch(() => undefined);

      const [row] = await adminQuery<{ review_status: string; revocations: string }>(
        `select rv.review_status,
                (select count(*)::text from public.source_property_review_revocations k
                  where k.revoked_receipt_id = rv.current_receipt_id) revocations
           from public.source_property_reviews rv
          where rv.source_property_identity_id = $1`,
        [f.identityId],
      );
      expect(Number(row!.revocations)).toBe(1);

      const before = await canonicalCounts();
      const error = await directPublish(f, pins);
      expect(error).toMatch(/not authorized|review_revocation_state_incoherent|revocation=/);
      expect(await canonicalCounts()).toEqual(before);
    });
  });

  // =====================================================================
  // C. CURRENT OBSERVATION
  // =====================================================================
  describe("C. the reviewed observation must still be the current one", () => {
    it("9. the approval cites observation A, the identity advanced to B: REFUSED", async () => {
      const f = await approvedProperty();
      const pins = await pinsFor(f);
      // Ingestion advances; NO fresh review, so the projection still points at
      // the approval about the superseded observation.
      await advance(f);

      const before = await canonicalCounts();
      const error = await directPublish(f, pins);
      expect(error).toMatch(/no longer that identity's current observation|CURRENT head revision/);
      expect(await canonicalCounts()).toEqual(before);
    });
  });

  // =====================================================================
  // D. THE CANONICAL FIELD POLICY
  // =====================================================================
  describe("D. name, address and country are database invariants", () => {
    it("10. a hotel name that is not the affirmed provider name is REFUSED", async () => {
      const f = await approvedProperty();
      const pins = await pinsFor(f);
      const error = await directPublish(f, pins, { name: "Completely Wrong Name" });
      expect(error).toMatch(/published the name .* while the affirmed provider name is/s);
    });

    it("11/12. a name the human did not affirm is REFUSED", async () => {
      for (const verdict of ["unavailable", "contradicts"] as const) {
        const f = await approvedProperty(undefined, { name: verdict as ReviewVerdict });
        const pins = await pinsFor(f);
        const error = await directPublish(f, pins);
        expect(error, verdict).toMatch(new RegExp(`records name = ${verdict}`));
      }
    });

    it("13/14. address `supports`: the exact provider address succeeds, a different one is REFUSED", async () => {
      const ok = await approvedProperty();
      expect(await directPublish(ok, await pinsFor(ok))).toBeNull();

      const bad = await approvedProperty();
      const error = await directPublish(bad, await pinsFor(bad), {
        address: "Somewhere else entirely",
      });
      expect(error).toMatch(/published the address .* while the affirmed provider address is/s);
    });

    it("15/16. address `unavailable`: NULL succeeds, the provider address is REFUSED", async () => {
      const ok = await approvedProperty(undefined, { address: "unavailable" });
      expect(await directPublish(ok, await pinsFor(ok), { address: null })).toBeNull();

      const bad = await approvedProperty(undefined, { address: "unavailable" });
      const error = await directPublish(bad, await pinsFor(bad));
      expect(error).toMatch(
        /published an address while the human review records address = unavailable/,
      );
    });

    it("17/18. address `contradicts`: NULL succeeds, any value is REFUSED", async () => {
      const ok = await approvedProperty(undefined, { address: "contradicts" });
      expect(await directPublish(ok, await pinsFor(ok), { address: null })).toBeNull();

      // A human contradiction may never be normalized away, by the writer or by
      // direct SQL. This is the case the A04.7 pilot made real.
      const bad = await approvedProperty(undefined, { address: "contradicts" });
      const error = await directPublish(bad, await pinsFor(bad));
      expect(error).toMatch(
        /published an address while the human review records address = contradicts/,
      );
      expect(error).toMatch(/never normalized away/);
    });

    it("19/20. country_code must be the canonical destination's, exactly", async () => {
      const bad = await approvedProperty();
      const error = await directPublish(bad, await pinsFor(bad), { countryCode: "ZZ" });
      expect(error).toMatch(/published country_code ZZ while canonical destination/);

      const ok = await approvedProperty();
      expect(await directPublish(ok, await pinsFor(ok))).toBeNull();
    });

    it("21/22. a destination with NO country: NULL succeeds, a fabricated code is REFUSED", async () => {
      const ok = await approvedProperty({ slug: "no-country-dest", countryCode: null });
      expect(await directPublish(ok, await pinsFor(ok), { countryCode: null })).toBeNull();

      const bad = await approvedProperty({ slug: "no-country-dest", countryCode: null });
      const error = await directPublish(bad, await pinsFor(bad), { countryCode: "ID" });
      expect(error).toMatch(
        /published country_code ID while canonical destination .* records null/s,
      );
    });

    it("enrichment A05 does not own cannot be published with it", async () => {
      const f = await approvedProperty();
      const error = await directPublish(f, await pinsFor(f), {
        websiteUrl: "https://example.invalid",
      });
      expect(error).toMatch(/published enrichment A05 does not own/);
    });

    it("a fabricated editorial verification is REFUSED", async () => {
      const f = await approvedProperty();
      const error = await directPublish(f, await pinsFor(f), { editorialStatus: "verified" });
      expect(error).toMatch(/published editorial_verification_status=verified/);
    });

    it("the database and the writer trim provider text identically", async () => {
      // `canonical_published_text()` in 0034 and `canonicalPublishedText()` in
      // the writer must agree character for character, or the database would
      // refuse publications the writer considers correct.
      for (const value of ["  Padded Name  ", "Tabbed\t", "\n\rWrapped\n", "   ", "", "Plain"]) {
        const [row] = await adminQuery<{ v: string | null }>(
          "select public.canonical_published_text($1) v",
          [value],
        );
        expect(row!.v, JSON.stringify(value)).toBe(canonicalPublishedText(value));
      }
      const [nullRow] = await adminQuery<{ v: string | null }>(
        "select public.canonical_published_text(null) v",
      );
      expect(nullRow!.v).toBe(canonicalPublishedText(null));
    });
  });

  // =====================================================================
  // E. SUPPORTED WRITER ROLES CANNOT BYPASS ANY OF IT
  // =====================================================================
  describe("E. the invariants hold for the roles that legitimately write here", () => {
    it("23. an admin/editor through RLS cannot publish without a receipt", async () => {
      const f = await approvedProperty();
      const [hotel] = await adminQuery<{ id: string }>(
        `insert into public.hotels (name, slug, destination_id, active_status)
         values ($1,$2,$3,'unknown') returning id`,
        [f.name, `editor-${f.sourcePropertyId}`, f.destinationId],
      );
      await adminQuery(
        `insert into public.hotel_source_identities
           (hotel_id, source_property_identity_id, source, source_environment, source_property_id,
            link_status, match_method)
         values ($1,$2,$3,'production',$4,'active','human_review:d062_approve_create')`,
        [hotel!.id, f.identityId, SOURCE, f.sourcePropertyId],
      );

      // 0024 gives `authenticated` SIUD on source_property_identities and RLS
      // narrows it to admin/editor — a real, supported writer, not a
      // hypothetical schema-owner attack. A raw connection is used rather than
      // the harness helper because the proof needs several statements in ONE
      // transaction: `set constraints all immediate` is what forces the deferred
      // trigger to speak exactly as COMMIT would.
      const raw = await client();
      let message = "";
      try {
        await raw.query("begin");
        await raw.query("set local role authenticated");
        await raw.query("select set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: USERS.admin }),
        ]);
        await raw.query(
          `update public.source_property_identities
              set resolution_state = 'resolved_eligible', promoted_hotel_id = $2
            where id = $1`,
          [f.identityId, hotel!.id],
        );
        await raw.query("set constraints all immediate");
        message = "COMMITTED";
      } catch (error) {
        message = (error as Error).message;
      } finally {
        await raw.query("rollback").catch(() => undefined);
        await raw.end();
      }
      expect(message).toMatch(/NO publication receipt|nobody signed/);
      expect((await identityRow(f.identityId)).resolution_state).toBe("unresolved");
    });

    it("24. the same holds for the table owner, which no grant can relax", async () => {
      // `adminQuery` runs as the superuser/owner connection — the strongest
      // writer there is. A constraint trigger is not a privilege check.
      const f = await approvedProperty();
      const pins = await pinsFor(f);
      const error = await directPublish(f, pins, { skipReceipt: true });
      expect(error).toMatch(/NO publication receipt|nobody signed/);
    });
  });
});

/** A fresh human approval of the identity's CURRENT observation. */
async function approveAgain(f: Fixture): Promise<void> {
  const { applyReview } = await import("./source-publication-fixtures");
  const report = await applyReview(f);
  expect(report.outcomes[0]!.state).toBe("applied");
}
