/**
 * Pre-publication star and location resolution (migration 0028).
 *
 * The invariants that make a resolution trustworthy: it cites a real observation
 * belonging to THIS candidate, it restates what that observation actually says,
 * it never crosses provider or environment streams, and it never invents
 * precedence between disagreeing sources.
 *
 * All fixtures synthetic. No real provider data appears here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "./harness";
import { seed, USERS, DEST } from "../rls/seed";
import { HOTELBEDS_CLASSIFICATION_POLICY } from "../../scripts/provider-classification/hotelbeds";
import {
  resolveStarFromObservations,
  resolveLocationFromObservations,
} from "../../scripts/provider-resolution/resolver";

const d = describe.skipIf(!hasTestDb);

const SOURCE = "hotelbeds";
let counter = 0;
const uniq = () => `r${Date.now().toString(36)}${(counter += 1)}`;

interface Fixture {
  identityId: string;
  runId: string;
  observationId: string;
}

/** One identity with one observation, in the evaluation environment. */
async function fixture(
  over: {
    environment?: string;
    source?: string;
    categoryCode?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    plausible?: boolean | null;
    observedAt?: string;
  } = {},
): Promise<Fixture> {
  const source = over.source ?? SOURCE;
  const environment = over.environment ?? "evaluation";
  const run = await adminQuery<{ id: string }>(
    `insert into public.source_runs (source, source_environment, destination_id, run_mode, started_at)
     values ($1, $2, $3, 'evaluation', coalesce($4::timestamptz, now())) returning id`,
    [source, environment, DEST.bali, over.observedAt ?? null],
  );
  const runId = run[0]!.id;

  const identity = await adminQuery<{ id: string }>(
    `insert into public.source_property_identities
       (source, source_environment, source_property_id, first_seen_run_id, last_seen_run_id)
     values ($1, $2, $3, $4, $4) returning id`,
    [source, environment, uniq(), runId],
  );
  const identityId = identity[0]!.id;

  const observation = await adminQuery<{ id: string }>(
    `insert into public.source_property_observations
       (source_run_id, source_property_identity_id, source, source_environment,
        observed_at, source_classification_code, source_latitude, source_longitude,
        source_coordinates_plausible)
     values ($1,$2,$3,$4, coalesce($9::timestamptz, now()), $5,$6,$7,$8) returning id`,
    [
      runId,
      identityId,
      source,
      environment,
      over.categoryCode === undefined ? "5EST" : over.categoryCode,
      over.latitude === undefined ? -8.5 : over.latitude,
      over.longitude === undefined ? 115.2 : over.longitude,
      over.plausible === undefined ? true : over.plausible,
      over.observedAt ?? null,
    ],
  );

  return { identityId, runId, observationId: observation[0]!.id };
}

/** Insert a star resolution directly, to probe the database's own guards. */
async function insertStar(
  f: Fixture,
  over: Partial<{
    evidenceObservationId: string;
    identityId: string;
    sourceValue: string | null;
    outcome: string;
    starValue: number | null;
    environment: string;
    source: string;
  }> = {},
): Promise<void> {
  await adminQuery(
    `insert into public.source_property_star_resolutions
       (source_property_identity_id, source, source_environment, evidence_observation_id,
        policy_provider, policy_version, policy_field, source_value, outcome, resolved_star_value)
     values ($1,$2,$3,$4,'hotelbeds','hotelbeds-classification/1','categoryCode',$5,$6,$7)`,
    [
      over.identityId ?? f.identityId,
      over.source ?? SOURCE,
      over.environment ?? "evaluation",
      over.evidenceObservationId ?? f.observationId,
      over.sourceValue === undefined ? "5EST" : over.sourceValue,
      over.outcome ?? "exact_five",
      over.starValue === undefined ? 5 : over.starValue,
    ],
  );
}

async function insertLocation(
  f: Fixture,
  over: Partial<{
    evidenceObservationId: string;
    outcome: string;
    lat: number | null;
    lon: number | null;
    reason: string | null;
  }> = {},
): Promise<void> {
  await adminQuery(
    `insert into public.source_property_location_resolutions
       (source_property_identity_id, source, source_environment, evidence_observation_id,
        policy_provider, policy_version, outcome, resolved_latitude, resolved_longitude,
        unresolved_reason)
     values ($1,$2,'evaluation',$3,'hotelbeds','hotelbeds-location/1',$4,$5,$6,$7)`,
    [
      f.identityId,
      SOURCE,
      over.evidenceObservationId ?? f.observationId,
      over.outcome ?? "resolved",
      over.lat === undefined ? -8.5 : over.lat,
      over.lon === undefined ? 115.2 : over.lon,
      over.reason ?? null,
    ],
  );
}

/**
 * The pure resolver, over synthetic observation rows.
 *
 * `??` is deliberately NOT used for the value fields: an explicit `null` means
 * "the provider supplied nothing", which is exactly what several of these tests
 * are about, and a nullish default would silently replace it.
 */
function obs(over: Record<string, unknown> = {}) {
  const pick = <T>(key: string, fallback: T): T => (key in over ? (over[key] as T) : fallback);
  return {
    id: (over.id as string) ?? "obs-1",
    source_property_identity_id: (over.identity as string) ?? "identity-1",
    source: SOURCE,
    source_environment: "evaluation",
    source_classification_code: pick<string | null>("code", "5EST"),
    source_latitude: pick<string | null>("lat", "-8.5"),
    source_longitude: pick<string | null>("lon", "115.2"),
    source_coordinates_plausible: pick<boolean | null>("plausible", true),
    observed_at: (over.at as string) ?? "2026-08-01T00:00:00.000Z",
  };
}

const star = (rows: ReturnType<typeof obs>[]) =>
  resolveStarFromObservations(rows, HOTELBEDS_CLASSIFICATION_POLICY);

d("pre-publication resolution (0028)", () => {
  beforeAll(async () => {
    await setupDatabase();
    await seed();
  });
  afterAll(teardownDatabase);

  // -----------------------------------------------------------------------
  describe("star resolution outcomes", () => {
    it("1/2. resolves 4EST to exact_four and 5EST to exact_five", () => {
      expect(star([obs({ code: "4EST" })])).toMatchObject({
        outcome: "exact_four",
        resolvedStarValue: 4,
      });
      expect(star([obs({ code: "5EST" })])).toMatchObject({
        outcome: "exact_five",
        resolvedStarValue: 5,
      });
    });

    it("3. resolves 4LUX / 5LUX from their explicit categoryCode semantics", () => {
      expect(star([obs({ code: "4LUX" })])).toMatchObject({ outcome: "exact_four" });
      expect(star([obs({ code: "5LUX" })])).toMatchObject({ outcome: "exact_five" });
    });

    it("4. can never resolve from simpleCode", () => {
      // The resolver reads source_classification_code and nothing else. Feeding
      // it the aggregate value resolves nothing — and the policy names the field
      // it is contracted to read.
      for (const simple of ["1", "2", "3", "4", "5"]) {
        expect(star([obs({ code: simple })])!.outcome).toBe("unresolved");
      }
      expect(star([obs({ code: "5EST" })])!.policyField).toBe("categoryCode");
    });

    it("5. keeps H4_5 / H5_5 out of V1", () => {
      for (const code of ["H4_5", "H5_5"]) {
        const r = star([obs({ code })])!;
        expect(r.outcome).toBe("classified_not_v1_scope");
        expect(r.resolvedStarValue).toBeNull();
      }
    });

    it("6. never turns a KEY, aparthotel or apartment category into stars", () => {
      for (const code of ["5LL", "4LL", "APTH5", "APTH4", "AT1", "BB5", "HS5", "HIST"]) {
        expect(star([obs({ code })])!.outcome, `${code} resolved`).toBe("unresolved");
      }
    });

    it("7. leaves an unknown or absent code unresolved", () => {
      expect(star([obs({ code: "NOT_A_REAL_CODE" })])!.outcome).toBe("unresolved");
      expect(star([obs({ code: null })])!.outcome).toBe("unresolved");
      // …and still cites what it examined, so "we looked" stays auditable.
      expect(star([obs({ code: null })])!.evidenceObservationId).toBe("obs-1");
    });

    it("does not fall back to any other field when the code is unresolved", () => {
      // A property named "Grand 5 Star Hotel", of accommodation type H, with a
      // category group of GRUPO5 and a glowing guest score still resolves
      // nothing, because none of those is the policy's field.
      const r = star([obs({ code: "SPC" })])!;
      expect(r.outcome).toBe("unresolved");
      expect(r.resolvedStarValue).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  describe("location resolution outcomes", () => {
    it("10. resolves valid coordinates exactly as observed", () => {
      const r = resolveLocationFromObservations([obs({ lat: "-8.690705", lon: "115.2634" })])!;
      expect(r.outcome).toBe("resolved");
      // Verbatim — not rounded, not snapped.
      expect(r.latitude).toBe("-8.690705");
      expect(r.longitude).toBe("115.2634");
    });

    it("8. leaves missing coordinates unresolved, and says WHY", () => {
      const r = resolveLocationFromObservations([obs({ lat: null, lon: null, plausible: null })])!;
      expect(r.outcome).toBe("unresolved");
      expect(r.unresolvedReason).toBe("coordinates_missing");
      expect(r.latitude).toBeNull();
      expect(r.longitude).toBeNull();
    });

    it("9. leaves implausible coordinates unresolved, as a DIFFERENT reason", () => {
      // The real Bali out-of-range shape. "Not supplied" and "supplied but
      // implausible" are different facts about the provider.
      const r = resolveLocationFromObservations([
        obs({ lat: "-8.690705", lon: "-244.73644", plausible: false }),
      ])!;
      expect(r.outcome).toBe("unresolved");
      expect(r.unresolvedReason).toBe("coordinates_implausible");
      expect(r.latitude).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  describe("provenance is structural", () => {
    it("11. cites the exact observation that produced it", async () => {
      const f = await fixture({ categoryCode: "4EST" });
      await insertStar(f, { sourceValue: "4EST", outcome: "exact_four", starValue: 4 });

      const rows = await adminQuery<{ evidence: string; identity: string }>(
        `select evidence_observation_id as evidence, source_property_identity_id as identity
           from public.source_property_star_resolutions where source_property_identity_id = $1`,
        [f.identityId],
      );
      expect(rows[0]!.evidence).toBe(f.observationId);
      expect(rows[0]!.identity).toBe(f.identityId);
    });

    it("12. REFUSES another identity's observation as evidence", async () => {
      const mine = await fixture();
      const theirs = await fixture();
      // Both observations exist; a plain id-only FK would accept this.
      await expect(
        insertStar(mine, { evidenceObservationId: theirs.observationId }),
      ).rejects.toThrow(/star_resolutions_evidence_fk/i);
      await expect(
        insertLocation(mine, { evidenceObservationId: theirs.observationId }),
      ).rejects.toThrow(/location_resolutions_evidence_fk/i);
    });

    it("REFUSES a resolution that restates something the evidence never said", async () => {
      // The core guard: cite a real observation of your own, but claim a
      // different classification. The trigger reads the observation and refuses.
      const f = await fixture({ categoryCode: "SPC" });
      await expect(
        insertStar(f, { sourceValue: "5EST", outcome: "exact_five", starValue: 5 }),
      ).rejects.toThrow(/may only restate what its evidence says/i);
    });

    it("REFUSES resolved coordinates that differ from the evidence", async () => {
      const f = await fixture({ latitude: -8.5, longitude: 115.2 });
      // A "corrected" coordinate — the exact thing that must never happen
      // silently.
      await expect(insertLocation(f, { lat: -8.6, lon: 115.3 })).rejects.toThrow(
        /copied from the evidence, never adjusted/i,
      );
    });

    it("REFUSES resolving a location from implausible or missing coordinates", async () => {
      const bad = await fixture({ latitude: 999, longitude: -244.7, plausible: false });
      await expect(insertLocation(bad, { lat: 999, lon: -244.7 })).rejects.toThrow(
        /missing or implausible/i,
      );

      const none = await fixture({ latitude: null, longitude: null, plausible: null });
      await expect(insertLocation(none, { lat: null, lon: null })).rejects.toThrow();
    });

    it("REFUSES an unresolved reason the evidence contradicts", async () => {
      const hasCoords = await fixture({ latitude: -8.5, longitude: 115.2, plausible: false });
      await expect(
        insertLocation(hasCoords, {
          outcome: "unresolved",
          lat: null,
          lon: null,
          reason: "coordinates_missing",
        }),
      ).rejects.toThrow(/reports coordinates_missing, but the cited observation carries/i);
    });

    it("13. cannot cross evaluation and production streams", async () => {
      const evaluation = await fixture({ environment: "evaluation" });
      // Claim production for an evaluation identity: the identity composite FK
      // refuses, exactly as 0027 does for the canonical link.
      await expect(insertStar(evaluation, { environment: "production" })).rejects.toThrow(
        /star_resolutions_identity_fk/i,
      );
    });

    it("cannot cross providers either", async () => {
      const hb = await fixture({ source: "hotelbeds" });
      await expect(insertStar(hb, { source: "other_provider" })).rejects.toThrow(
        /star_resolutions_identity_fk/i,
      );
    });

    it("protects the cited observation from deletion", async () => {
      const f = await fixture({ categoryCode: "5EST" });
      await insertStar(f);
      // Observations are already append-only in 0027; this proves the RESOLUTION
      // also holds them, so the guarantee does not depend on that alone.
      const def = await adminQuery<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint
          where conname = 'source_property_star_resolutions_evidence_fk'`,
      );
      expect(def[0]!.def).toMatch(/ON DELETE RESTRICT/i);
    });
  });

  // -----------------------------------------------------------------------
  describe("shape constraints", () => {
    it("cannot claim a star value the outcome does not support", async () => {
      const f = await fixture({ categoryCode: "3EST" });
      await expect(
        insertStar(f, { sourceValue: "3EST", outcome: "classified_not_v1_scope", starValue: 3 }),
      ).rejects.toThrow(/value_shape/i);

      const g = await fixture({ categoryCode: "5EST" });
      await expect(
        insertStar(g, { sourceValue: "5EST", outcome: "exact_five", starValue: 4 }),
      ).rejects.toThrow(/value_shape/i);
    });

    it("cannot record a conflict without naming what it conflicts with", async () => {
      const f = await fixture();
      await expect(
        adminQuery(
          `insert into public.source_property_star_resolutions
             (source_property_identity_id, source, source_environment, evidence_observation_id,
              policy_provider, policy_version, policy_field, source_value, outcome,
              resolved_star_value, conflict_state)
           values ($1,$2,'evaluation',$3,'hotelbeds','hotelbeds-classification/1','categoryCode',
                   '5EST','exact_five',5,'conflict')`,
          [f.identityId, SOURCE, f.observationId],
        ),
      ).rejects.toThrow(/conflict_shape/i);
    });

    it("keeps at most one CURRENT resolution per candidate", async () => {
      const f = await fixture();
      await insertStar(f);
      await expect(insertStar(f)).rejects.toThrow(/duplicate key/i);
    });

    it("does not require an issuing authority", async () => {
      // D066: a registry is optional corroboration, never a gate.
      const f = await fixture({ categoryCode: "5EST" });
      await insertStar(f);
      const rows = await adminQuery<{ authority: string | null }>(
        `select issuing_authority as authority from public.source_property_star_resolutions
          where source_property_identity_id = $1`,
        [f.identityId],
      );
      expect(rows[0]!.authority).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  describe("16. no precedence, no averaging", () => {
    it("keeps the FIRST resolution and flags a later disagreement", () => {
      const r = star([
        obs({ id: "o1", code: "4EST", at: "2026-08-01T00:00:00.000Z" }),
        obs({ id: "o2", code: "5EST", at: "2026-09-01T00:00:00.000Z" }),
      ])!;
      // Not "newest wins", not 4.5, not a vote: the first stands and the
      // disagreement is recorded for a human.
      expect(r.outcome).toBe("exact_four");
      expect(r.evidenceObservationId).toBe("o1");
      expect(r.conflictObservationId).toBe("o2");
      expect(r.conflictOutcome).toBe("exact_five");
      expect(r.resolvedStarValue).toBe(4);
    });

    it("never produces a half-star from two disagreeing sources", () => {
      const r = star([obs({ id: "o1", code: "4EST" }), obs({ id: "o2", code: "5EST" })])!;
      expect([4, 5]).toContain(r.resolvedStarValue);
      expect(JSON.stringify(r)).not.toMatch(/4\.5/);
    });

    it("treats an unresolvable later observation as no news, not a conflict", () => {
      const r = star([obs({ id: "o1", code: "5EST" }), obs({ id: "o2", code: "VILLA" })])!;
      expect(r.outcome).toBe("exact_five");
      expect(r.conflictObservationId).toBeNull();
    });

    it("agrees silently when a later observation matches", () => {
      const r = star([obs({ id: "o1", code: "5EST" }), obs({ id: "o2", code: "5EST" })])!;
      expect(r.outcome).toBe("exact_five");
      expect(r.evidenceObservationId).toBe("o1");
      expect(r.conflictObservationId).toBeNull();
    });

    it("flags differing coordinates rather than choosing between them", () => {
      // Any difference at all. A tolerance would be a distance threshold, which
      // D063 §12.2 refuses to invent.
      const r = resolveLocationFromObservations([
        obs({ id: "o1", lat: "-8.5", lon: "115.2" }),
        obs({ id: "o2", lat: "-8.5001", lon: "115.2" }),
      ])!;
      expect(r.outcome).toBe("resolved");
      expect(r.latitude).toBe("-8.5");
      expect(r.conflictObservationId).toBe("o2");
    });

    it("carries no confidence score or threshold anywhere", () => {
      const r = star([obs({ code: "5EST" })])!;
      expect(Object.keys(r).join(" ")).not.toMatch(/confidence|score|threshold|weight/i);
    });
  });

  // -----------------------------------------------------------------------
  describe("15. canonical safety and security", () => {
    it("writes nothing canonical", async () => {
      const before = await adminQuery<Record<string, string>>(
        `select (select count(*) from public.hotels)::text h,
                (select count(*) from public.hotel_source_identities)::text l,
                (select count(*) from public.source_match_candidates)::text c,
                (select count(*) from public.source_property_reviews)::text r`,
      );
      const f = await fixture({ categoryCode: "5EST" });
      await insertStar(f);
      await insertLocation(f);
      const after = await adminQuery<Record<string, string>>(
        `select (select count(*) from public.hotels)::text h,
                (select count(*) from public.hotel_source_identities)::text l,
                (select count(*) from public.source_match_candidates)::text c,
                (select count(*) from public.source_property_reviews)::text r`,
      );
      expect(after[0]).toEqual(before[0]);
    });

    it("leaves the identity's terminal resolution state alone", async () => {
      const f = await fixture({ categoryCode: "5EST" });
      await insertStar(f);
      const rows = await adminQuery<{ state: string }>(
        `select resolution_state as state from public.source_property_identities where id = $1`,
        [f.identityId],
      );
      // A resolved star is a PRE-publication fact. It does not make the
      // candidate eligible, matched or excluded.
      expect(rows[0]!.state).toBe("unresolved");
    });

    it("gives anon no access to either table", async () => {
      for (const table of [
        "source_property_star_resolutions",
        "source_property_location_resolutions",
      ]) {
        const res = await queryAs({ role: "anon", sub: null }, `select * from public.${table}`);
        expect(res.error, `anon reached ${table}`).not.toBeNull();
        expect(res.error?.code).toBe("42501");
      }
    });

    it("lets an ordinary creator read nothing, despite holding the privilege", async () => {
      const f = await fixture({ categoryCode: "5EST" });
      await insertStar(f);
      for (const table of [
        "source_property_star_resolutions",
        "source_property_location_resolutions",
      ]) {
        const res = await queryAs<{ n: string }>(
          { role: "authenticated", sub: USERS.free },
          `select count(*)::text as n from public.${table}`,
        );
        expect(res.error, `creator errored on ${table}`).toBeNull();
        expect(res.rows[0]!.n, `creator saw rows in ${table}`).toBe("0");
      }
    });

    it("has RLS enabled on both new tables", async () => {
      const rows = await adminQuery<{ relname: string; relrowsecurity: boolean }>(
        `select c.relname, c.relrowsecurity from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = any($1)`,
        [["source_property_star_resolutions", "source_property_location_resolutions"]],
      );
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.relrowsecurity, row.relname).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  describe("14. idempotency", () => {
    it("re-resolving the same evidence changes nothing", async () => {
      const f = await fixture({ categoryCode: "4EST" });
      await insertStar(f, { sourceValue: "4EST", outcome: "exact_four", starValue: 4 });

      const snapshot = async () =>
        (
          await adminQuery<{ row: string }>(
            `select outcome || ':' || coalesce(source_value,'') || ':' ||
                    evidence_observation_id::text || ':' || coalesce(resolved_star_value::text,'')
                      as row
               from public.source_property_star_resolutions where source_property_identity_id = $1`,
            [f.identityId],
          )
        )[0]!.row;

      const before = await snapshot();
      // The resolver upserts; re-running writes the same values from the same
      // evidence, so nothing about the row's meaning moves.
      await adminQuery(
        `insert into public.source_property_star_resolutions
           (source_property_identity_id, source, source_environment, evidence_observation_id,
            policy_provider, policy_version, policy_field, source_value, outcome, resolved_star_value)
         values ($1,$2,'evaluation',$3,'hotelbeds','hotelbeds-classification/1','categoryCode',
                 '4EST','exact_four',4)
         on conflict (source_property_identity_id) do update set
           outcome = excluded.outcome, source_value = excluded.source_value,
           evidence_observation_id = excluded.evidence_observation_id,
           resolved_star_value = excluded.resolved_star_value`,
        [f.identityId, SOURCE, f.observationId],
      );
      expect(await snapshot()).toBe(before);

      const count = await adminQuery<{ n: string }>(
        `select count(*)::text as n from public.source_property_star_resolutions
          where source_property_identity_id = $1`,
        [f.identityId],
      );
      expect(count[0]!.n).toBe("1");
    });

    it("is deterministic: the same observations always fold the same way", () => {
      const rows = [obs({ id: "o1", code: "4EST" }), obs({ id: "o2", code: "5EST" })];
      expect(star(rows)).toEqual(star(rows));
    });
  });
});
