/**
 * Pre-publication star and location resolution (migration 0028).
 *
 * Three things have to be true for a resolution to be worth citing later, and
 * each has its own section below:
 *
 *   1. It cites a real observation BELONGING to this candidate and restates what
 *      that observation actually says.
 *   2. Its conclusion is the one the APPROVED POLICY reaches from that value —
 *      not merely a well-formed one, and not one the caller picked.
 *   3. It is IMMUTABLE. A later observation or a new policy version appends a
 *      revision and moves a pointer; it never rewrites what was already decided.
 *
 * Most of these run as direct SQL rather than through the resolver, deliberately:
 * the guarantee has to hold against psql and a service-role script, not only
 * against the one code path that happens to be careful.
 *
 * All fixtures synthetic. No real provider data appears here.
 */
import { randomUUID } from "node:crypto";

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
const POLICY = {
  provider: "hotelbeds",
  version: "hotelbeds-classification/1",
  field: "categoryCode",
};
const LOCATION_POLICY = { provider: "hotelbeds", version: "hotelbeds-location/1" };

let counter = 0;
const uniq = () => `r${Date.now().toString(36)}${(counter += 1)}`;

interface Fixture {
  identityId: string;
  runId: string;
  observationId: string;
  source: string;
  environment: string;
}

interface ObservationOverrides {
  categoryCode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  plausible?: boolean | null;
  observedAt?: string;
}

async function newRun(source: string, environment: string, startedAt?: string): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    `insert into public.source_runs (source, source_environment, destination_id, run_mode, started_at)
     values ($1, $2, $3, 'evaluation', coalesce($4::timestamptz, now())) returning id`,
    [source, environment, DEST.bali, startedAt ?? null],
  );
  return rows[0]!.id;
}

/**
 * A LATER observation of the same candidate.
 *
 * It gets its own run, because 0027 allows one observation per candidate per run
 * — a second reading is by definition a second look.
 */
async function addObservation(
  f: Fixture,
  over: ObservationOverrides & { runId?: string } = {},
): Promise<string> {
  const runId = over.runId ?? (await newRun(f.source, f.environment, over.observedAt));
  const rows = await adminQuery<{ id: string }>(
    `insert into public.source_property_observations
       (source_run_id, source_property_identity_id, source, source_environment,
        observed_at, source_classification_code, source_latitude, source_longitude,
        source_coordinates_plausible)
     values ($1,$2,$3,$4, coalesce($9::timestamptz, now()), $5,$6,$7,$8) returning id`,
    [
      runId,
      f.identityId,
      f.source,
      f.environment,
      over.categoryCode === undefined ? "5EST" : over.categoryCode,
      over.latitude === undefined ? -8.5 : over.latitude,
      over.longitude === undefined ? 115.2 : over.longitude,
      over.plausible === undefined ? true : over.plausible,
      over.observedAt ?? null,
    ],
  );
  return rows[0]!.id;
}

/** One identity with one observation, in the evaluation environment. */
async function fixture(
  over: ObservationOverrides & { environment?: string; source?: string } = {},
): Promise<Fixture> {
  const source = over.source ?? SOURCE;
  const environment = over.environment ?? "evaluation";
  const runId = await newRun(source, environment, over.observedAt);

  const identity = await adminQuery<{ id: string }>(
    `insert into public.source_property_identities
       (source, source_environment, source_property_id, first_seen_run_id, last_seen_run_id)
     values ($1, $2, $3, $4, $4) returning id`,
    [source, environment, uniq(), runId],
  );

  const partial: Fixture = {
    identityId: identity[0]!.id,
    runId,
    observationId: "",
    source,
    environment,
  };
  partial.observationId = await addObservation(partial, { ...over, runId });
  return partial;
}

interface StarOverrides {
  evidenceObservationId?: string;
  identityId?: string;
  policyProvider?: string;
  policyVersion?: string;
  policyField?: string;
  sourceValue?: string | null;
  outcome?: string;
  starValue?: number | null;
  environment?: string;
  source?: string;
  conflictState?: string;
  conflictObservationId?: string | null;
  conflictOutcome?: string | null;
  supersedesRevisionId?: string | null;
  /** Only set when a test needs to reason about the id BEFORE it exists. */
  id?: string;
}

/** Insert a star revision directly, to probe the database's own guards. */
async function insertStar(f: Fixture, over: StarOverrides = {}): Promise<string> {
  const pick = <T>(key: keyof StarOverrides, fallback: T): T =>
    key in over ? (over[key] as T) : fallback;
  const rows = await adminQuery<{ id: string }>(
    `insert into public.source_property_star_resolution_revisions
       (id, source_property_identity_id, source, source_environment, evidence_observation_id,
        policy_provider, policy_version, policy_field, source_value, outcome, resolved_star_value,
        conflict_state, conflicting_observation_id, conflicting_outcome, supersedes_revision_id)
     values (coalesce($15::uuid, gen_random_uuid()),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     returning id`,
    [
      over.identityId ?? f.identityId,
      over.source ?? f.source,
      over.environment ?? f.environment,
      over.evidenceObservationId ?? f.observationId,
      over.policyProvider ?? POLICY.provider,
      over.policyVersion ?? POLICY.version,
      over.policyField ?? POLICY.field,
      pick<string | null>("sourceValue", "5EST"),
      over.outcome ?? "exact_five",
      pick<number | null>("starValue", 5),
      over.conflictState ?? (over.conflictObservationId ? "conflict" : "none"),
      pick<string | null>("conflictObservationId", null),
      pick<string | null>("conflictOutcome", null),
      pick<string | null>("supersedesRevisionId", null),
      pick<string | null>("id", null),
    ],
  );
  return rows[0]!.id;
}

interface LocationOverrides {
  id?: string;
  evidenceObservationId?: string;
  policyProvider?: string;
  policyVersion?: string;
  outcome?: string;
  lat?: number | null;
  lon?: number | null;
  reason?: string | null;
  conflictState?: string;
  conflictObservationId?: string | null;
  supersedesRevisionId?: string | null;
}

async function insertLocation(f: Fixture, over: LocationOverrides = {}): Promise<string> {
  const pick = <T>(key: keyof LocationOverrides, fallback: T): T =>
    key in over ? (over[key] as T) : fallback;
  const rows = await adminQuery<{ id: string }>(
    `insert into public.source_property_location_resolution_revisions
       (id, source_property_identity_id, source, source_environment, evidence_observation_id,
        policy_provider, policy_version, outcome, resolved_latitude, resolved_longitude,
        unresolved_reason, conflict_state, conflicting_observation_id, supersedes_revision_id)
     values (coalesce($14::uuid, gen_random_uuid()),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     returning id`,
    [
      f.identityId,
      f.source,
      f.environment,
      over.evidenceObservationId ?? f.observationId,
      over.policyProvider ?? LOCATION_POLICY.provider,
      over.policyVersion ?? LOCATION_POLICY.version,
      over.outcome ?? "resolved",
      pick<number | null>("lat", -8.5),
      pick<number | null>("lon", 115.2),
      pick<string | null>("reason", null),
      over.conflictState ?? (over.conflictObservationId ? "conflict" : "none"),
      pick<string | null>("conflictObservationId", null),
      pick<string | null>("supersedesRevisionId", null),
      pick<string | null>("id", null),
    ],
  );
  return rows[0]!.id;
}

async function setStarHead(identityId: string, revisionId: string): Promise<void> {
  await adminQuery(
    `insert into public.source_property_star_resolutions
       (source_property_identity_id, current_revision_id) values ($1,$2)
     on conflict (source_property_identity_id) do update
       set current_revision_id = excluded.current_revision_id`,
    [identityId, revisionId],
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
    source_property_type_code: pick<string | null>("typeCode", "H"),
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

    // Fixture policy versions. Each is assembled as a draft and then frozen,
    // because that is the only way any version can be built — including the
    // shipped one.
    //
    //   * `test-empty`  approved, maps nothing — proves what refuses a bad
    //                   outcome is the MAPPING, not merely a policy row existing;
    //   * `2-test`      approved, maps 5EST as v1 does, at a different version;
    //   * `draft-test`  NEVER approved — the only version whose mappings can
    //                   still be written, so the mapping-shape constraints are
    //                   reachable at all;
    //   * `provider-b/1` approved, and deliberately maps 5EST DIFFERENTLY, so the
    //                   cross-provider tests aim at a real contradicting policy
    //                   rather than a nonexistent one.
    await adminQuery(
      `insert into public.provider_classification_policies (provider, version, field, notes) values
         ('hotelbeds', 'hotelbeds-classification/test-empty', 'categoryCode', 'test fixture'),
         ('hotelbeds', 'hotelbeds-classification/2-test', 'categoryCode', 'test fixture'),
         ('hotelbeds', 'hotelbeds-classification/draft-test', 'categoryCode', 'draft fixture'),
         ('provider_b', 'provider-b/1', 'categoryCode', 'test fixture')
       on conflict do nothing`,
    );
    await adminQuery(
      `insert into public.provider_classification_policy_mappings
         (provider, version, field, source_code, outcome, resolved_star_value) values
         ('hotelbeds','hotelbeds-classification/2-test','categoryCode','5EST','exact_five',5),
         ('provider_b','provider-b/1','categoryCode','5EST','exact_four',4)
       on conflict do nothing`,
    );
    await adminQuery(
      `update public.provider_classification_policies set approved_at = now()
        where approved_at is null and version <> 'hotelbeds-classification/draft-test'`,
    );
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

    it("matches provider codes EXACTLY — no trimming, no normalisation", () => {
      // 0028's trigger compares `mapping.source_code = revision.source_value`
      // against the stored observation verbatim. If TypeScript trimmed, `'5EST '`
      // would resolve exact_five in a preview and unresolved in Postgres — two
      // different truths for one candidate, one of them publishable.
      expect(star([obs({ code: "5EST" })])!.outcome).toBe("exact_five");
      for (const malformed of [" 5EST", "5EST ", " 5EST ", "\t5EST", "5est", "", "   "]) {
        expect(star([obs({ code: malformed })])!.outcome, JSON.stringify(malformed)).toBe(
          "unresolved",
        );
      }
      expect(star([obs({ code: null })])!.outcome).toBe("unresolved");
    });

    it("a malformed code PERSISTED in the evidence can only resolve to unresolved", async () => {
      const f = await fixture({ categoryCode: "5EST " });
      await expect(
        insertStar(f, { sourceValue: "5EST ", outcome: "exact_five", starValue: 5 }),
      ).rejects.toThrow(/never acquires a meaning by accident/i);
      const id = await insertStar(f, {
        sourceValue: "5EST ",
        outcome: "unresolved",
        starValue: null,
      });
      // The evidence string is preserved exactly as the provider gave it.
      const rows = await adminQuery<{ v: string }>(
        `select source_value as v from public.source_property_star_resolution_revisions
          where id = $1`,
        [id],
      );
      expect(rows[0]!.v).toBe("5EST ");
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

    it("leaves an UNJUDGED coordinate unresolved, as its own third reason", () => {
      // `source_coordinates_plausible` is nullable: the audit can have reached no
      // verdict. That is UNKNOWN, not FALSE, and calling it implausible would
      // report data as wrong that nobody ever examined.
      const r = resolveLocationFromObservations([obs({ plausible: null })])!;
      expect(r.outcome).toBe("unresolved");
      expect(r.unresolvedReason).toBe("coordinates_plausibility_unknown");
      expect(r.latitude).toBeNull();
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
  // THE APPROVED POLICY DECIDES THE OUTCOME
  // -----------------------------------------------------------------------
  // Restating the observation's code faithfully is not enough: `5EST` +
  // `exact_four` cites real evidence, passes every FK and every shape check, and
  // is still a classification the reviewed policy never sanctioned. These probe
  // the database directly, because the guarantee must not depend on the resolver.
  describe("policy semantics are structural", () => {
    it("ACCEPTS the mapping the approved policy actually reaches", async () => {
      const five = await fixture({ categoryCode: "5EST" });
      await expect(
        insertStar(five, { sourceValue: "5EST", outcome: "exact_five", starValue: 5 }),
      ).resolves.toBeTruthy();

      const four = await fixture({ categoryCode: "4LUX" });
      await expect(
        insertStar(four, { sourceValue: "4LUX", outcome: "exact_four", starValue: 4 }),
      ).resolves.toBeTruthy();

      const half = await fixture({ categoryCode: "H4_5" });
      await expect(
        insertStar(half, {
          sourceValue: "H4_5",
          outcome: "classified_not_v1_scope",
          starValue: null,
        }),
      ).resolves.toBeTruthy();
    });

    it("REFUSES 5EST claimed as exact_four", async () => {
      const f = await fixture({ categoryCode: "5EST" });
      await expect(
        insertStar(f, { sourceValue: "5EST", outcome: "exact_four", starValue: 4 }),
      ).rejects.toThrow(/approved policy decides the outcome, not the caller/i);
    });

    it("REFUSES 4EST claimed as exact_five", async () => {
      const f = await fixture({ categoryCode: "4EST" });
      await expect(
        insertStar(f, { sourceValue: "4EST", outcome: "exact_five", starValue: 5 }),
      ).rejects.toThrow(/approved policy decides the outcome, not the caller/i);
    });

    it("REFUSES resolving one provider's observation through another's policy", async () => {
      // The `provider_b` fixture policy maps 5EST to exact_four. If a Hotelbeds
      // observation could be run through it, the classification would come from a
      // provider that never said it — with every FK and the mapping check
      // passing.
      const f = await fixture({ categoryCode: "5EST" });
      await expect(
        insertStar(f, {
          policyProvider: "provider_b",
          policyVersion: "provider-b/1",
          outcome: "exact_four",
          starValue: 4,
        }),
      ).rejects.toThrow(/policy_source_ck/i);
      await expect(
        insertLocation(f, { policyProvider: "provider_b", policyVersion: "provider-b/1" }),
      ).rejects.toThrow(/policy_source_ck/i);
    });

    it("REFUSES an UNMAPPED code claimed as anything but unresolved", async () => {
      // `SPC` is "absent/unknown category" in the provider's own master. It is
      // not in the allow-list, so it has exactly one available outcome.
      for (const outcome of ["exact_five", "exact_four", "classified_not_v1_scope"]) {
        const f = await fixture({ categoryCode: "SPC" });
        await expect(
          insertStar(f, {
            sourceValue: "SPC",
            outcome,
            starValue: outcome === "exact_five" ? 5 : outcome === "exact_four" ? 4 : null,
          }),
        ).rejects.toThrow(/never acquires a meaning by accident/i);
      }
    });

    it("ACCEPTS an unmapped code resolved to unresolved", async () => {
      const f = await fixture({ categoryCode: "SPC" });
      await expect(
        insertStar(f, { sourceValue: "SPC", outcome: "unresolved", starValue: null }),
      ).resolves.toBeTruthy();
    });

    // A resolution may cite only a policy that was reviewed AND frozen. The
    // approval check runs before the mapping lookup, because a draft version's
    // mappings can still change and resolving through one would let this
    // revision's meaning move after the fact.
    it("REFUSES a policy VERSION that was never approved", async () => {
      const f = await fixture({ categoryCode: "5EST" });
      for (const outcome of ["exact_five", "unresolved"]) {
        await expect(
          insertStar(f, {
            policyVersion: "hotelbeds-classification/99",
            outcome,
            starValue: outcome === "exact_five" ? 5 : null,
          }),
        ).rejects.toThrow(/not an APPROVED classification policy \(no such policy\)/i);
      }
      // …and the FK is real independently of the trigger.
      const def = await adminQuery<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint
          where conname = 'source_property_star_resolution_revisions_policy_fk'`,
      );
      expect(def[0]!.def).toMatch(/provider_classification_policies/i);
    });

    it("REFUSES a policy version that exists but is still a DRAFT", async () => {
      const f = await fixture({ categoryCode: "5EST" });
      await expect(
        insertStar(f, { policyVersion: "hotelbeds-classification/draft-test" }),
      ).rejects.toThrow(/not an APPROVED classification policy \(still a draft\)/i);
    });

    it("REFUSES a policy FIELD the approved policy does not read", async () => {
      const f = await fixture({ categoryCode: "5EST" });
      await expect(insertStar(f, { policyField: "simpleCode" })).rejects.toThrow(
        /on field 'simpleCode' is not an APPROVED classification policy/i,
      );
    });

    it("REFUSES a provider with no approved policy at all", async () => {
      const f = await fixture({ categoryCode: "5EST" });
      await expect(insertStar(f, { policyProvider: "provider_z" })).rejects.toThrow(
        /not an APPROVED classification policy/i,
      );
    });

    it("a version that EXISTS but does not map the code can only say unresolved", async () => {
      // The sharper case: the policy row is real, so the FK passes. What refuses
      // is the mapping lookup — which is the point of keeping them separate.
      const f = await fixture({ categoryCode: "5EST" });
      await expect(
        insertStar(f, { policyVersion: "hotelbeds-classification/test-empty" }),
      ).rejects.toThrow(/has no mapping for/i);
      await expect(
        insertStar(f, {
          policyVersion: "hotelbeds-classification/test-empty",
          outcome: "unresolved",
          starValue: null,
        }),
      ).resolves.toBeTruthy();
    });

    it("the mapping table itself cannot hold an incoherent outcome", async () => {
      // Against the DRAFT version, because a frozen one refuses the write before
      // the shape is ever evaluated.
      await expect(
        adminQuery(
          `insert into public.provider_classification_policy_mappings
             (provider, version, field, source_code, outcome, resolved_star_value)
           values ('hotelbeds','hotelbeds-classification/draft-test','categoryCode','ZZTOP','exact_five',4)`,
        ),
      ).rejects.toThrow(/value_shape/i);
    });

    it("a mapping cannot be attached to a policy that does not exist", async () => {
      await expect(
        adminQuery(
          `insert into public.provider_classification_policy_mappings
             (provider, version, field, source_code, outcome, resolved_star_value)
           values ('provider_z','provider-z/1','stars','5','exact_five',5)`,
        ),
      ).rejects.toThrow(/policy_fk/i);
    });
  });

  // -----------------------------------------------------------------------
  // AN APPROVED POLICY VERSION IS FROZEN
  // -----------------------------------------------------------------------
  // Immutable revisions are worth nothing if the policy they cite can change
  // meaning underneath them. A revision reading `hotelbeds-classification/1` +
  // `5EST` -> `exact_five` stays byte-identical while somebody edits that
  // version's mapping to `exact_four`: the row is untouched and its provenance
  // is now false. D066 says a mapping change is a NEW VERSION; these make that
  // structural rather than a convention.
  describe("approved policy versions are immutable", () => {
    const V1 = "hotelbeds-classification/1";

    it("the shipped Hotelbeds policy is approved, and so frozen", async () => {
      const rows = await adminQuery<{ approved: string | null }>(
        `select approved_at::text as approved from public.provider_classification_policies
          where provider = 'hotelbeds' and version = $1`,
        [V1],
      );
      expect(rows[0]!.approved).not.toBeNull();
    });

    it("REFUSES changing a mapping's outcome or star value", async () => {
      await expect(
        adminQuery(
          `update public.provider_classification_policy_mappings
              set outcome = 'exact_four', resolved_star_value = 4
            where provider='hotelbeds' and version=$1 and source_code='5EST'`,
          [V1],
        ),
      ).rejects.toThrow(/mapping set is IMMUTABLE/i);
    });

    it("REFUSES deleting a mapping", async () => {
      await expect(
        adminQuery(
          `delete from public.provider_classification_policy_mappings
            where provider='hotelbeds' and version=$1 and source_code='4EST'`,
          [V1],
        ),
      ).rejects.toThrow(/mapping set is IMMUTABLE/i);
    });

    it("REFUSES adding a NEW mapping to a frozen version", async () => {
      // The subtlest of the three: nothing existing changes, and yet `SUP` would
      // silently acquire a meaning inside a version already cited by revisions.
      await expect(
        adminQuery(
          `insert into public.provider_classification_policy_mappings
             (provider, version, field, source_code, outcome, resolved_star_value)
           values ('hotelbeds',$1,'categoryCode','SUP','exact_four',4)`,
          [V1],
        ),
      ).rejects.toThrow(/mapping set is IMMUTABLE/i);
    });

    it("REFUSES moving a mapping OUT of a frozen version", async () => {
      // Checking only the destination would let a code be lifted out of a frozen
      // version into the draft, changing the frozen version's meaning by removal.
      await expect(
        adminQuery(
          `update public.provider_classification_policy_mappings
              set version = 'hotelbeds-classification/draft-test'
            where provider='hotelbeds' and version=$1 and source_code='5LUX'`,
          [V1],
        ),
      ).rejects.toThrow(/mapping set is IMMUTABLE/i);
    });

    it("REFUSES changing the policy's field, or deleting or un-approving it", async () => {
      for (const sql of [
        `update public.provider_classification_policies set field = 'simpleCode'
          where provider='hotelbeds' and version=$1`,
        `update public.provider_classification_policies set approved_at = null
          where provider='hotelbeds' and version=$1`,
        `update public.provider_classification_policies set notes = 'rewritten'
          where provider='hotelbeds' and version=$1`,
        `delete from public.provider_classification_policies
          where provider='hotelbeds' and version=$1`,
      ]) {
        await expect(adminQuery(sql, [V1]), sql).rejects.toThrow(/is IMMUTABLE/i);
      }
    });

    it("the mapping set is unchanged after all of that", async () => {
      const rows = await adminQuery<{ n: string }>(
        `select count(*)::text as n from public.provider_classification_policy_mappings
          where provider='hotelbeds' and version=$1`,
        [V1],
      );
      expect(rows[0]!.n).toBe("14");
    });

    it("a NEW version can still be assembled, approved and used normally", async () => {
      const version = `hotelbeds-classification/${uniq()}`;
      await adminQuery(
        `insert into public.provider_classification_policies (provider, version, field, notes)
         values ('hotelbeds', $1, 'categoryCode', 'a later review')`,
        [version],
      );
      // Draft: mappings are writable, and a resolution may not cite it yet.
      await adminQuery(
        `insert into public.provider_classification_policy_mappings
           (provider, version, field, source_code, outcome, resolved_star_value)
         values ('hotelbeds', $1, 'categoryCode', '5EST', 'exact_five', 5)`,
        [version],
      );
      const draftCandidate = await fixture({ categoryCode: "5EST" });
      await expect(insertStar(draftCandidate, { policyVersion: version })).rejects.toThrow(
        /still a draft/i,
      );

      await adminQuery(
        `update public.provider_classification_policies set approved_at = now()
          where provider='hotelbeds' and version=$1`,
        [version],
      );
      const f = await fixture({ categoryCode: "5EST" });
      await expect(insertStar(f, { policyVersion: version })).resolves.toBeTruthy();

      // …and it is frozen the moment it is approved.
      await expect(
        adminQuery(
          `insert into public.provider_classification_policy_mappings
             (provider, version, field, source_code, outcome, resolved_star_value)
           values ('hotelbeds', $1, 'categoryCode', '4EST', 'exact_four', 4)`,
          [version],
        ),
      ).rejects.toThrow(/mapping set is IMMUTABLE/i);
    });
  });

  // -----------------------------------------------------------------------
  describe("the DB policy and the TypeScript policy cannot drift", () => {
    it("hold exactly the same provider, version, field and mappings", async () => {
      const ts = HOTELBEDS_CLASSIFICATION_POLICY;

      const policy = await adminQuery<{ provider: string; version: string; field: string }>(
        `select provider, version, field from public.provider_classification_policies
          where provider = $1 and version = $2`,
        [ts.provider, ts.version],
      );
      expect(policy, "the TypeScript policy has no row in the database").toHaveLength(1);
      expect(policy[0]!.field).toBe(ts.field);

      const rows = await adminQuery<{ source_code: string; outcome: string }>(
        `select source_code, outcome from public.provider_classification_policy_mappings
          where provider = $1 and version = $2 and field = $3 order by source_code`,
        [ts.provider, ts.version, ts.field],
      );
      const fromDb = Object.fromEntries(rows.map((r) => [r.source_code, r.outcome]));
      const fromTs = Object.fromEntries(
        Object.entries(ts.mappings).sort(([a], [b]) => a.localeCompare(b)),
      );
      // Both directions: a code added to one and not the other fails here, which
      // is the only thing keeping two copies of the same decision honest.
      expect(fromDb).toEqual(fromTs);
    });

    it("agree on the star VALUE each outcome carries", async () => {
      const rows = await adminQuery<{ source_code: string; value: string | null }>(
        `select source_code, resolved_star_value::text as value
           from public.provider_classification_policy_mappings
          where provider = $1 and version = $2`,
        [HOTELBEDS_CLASSIFICATION_POLICY.provider, HOTELBEDS_CLASSIFICATION_POLICY.version],
      );
      for (const row of rows) {
        const outcome = HOTELBEDS_CLASSIFICATION_POLICY.mappings[row.source_code];
        const expected = outcome === "exact_four" ? "4" : outcome === "exact_five" ? "5" : null;
        expect(row.value, `${row.source_code} star value`).toBe(expected);
      }
    });

    it("`unresolved` is not a storable mapping — absence IS the answer", async () => {
      await expect(
        adminQuery(
          `insert into public.provider_classification_policy_mappings
             (provider, version, field, source_code, outcome, resolved_star_value)
           values ('hotelbeds','hotelbeds-classification/draft-test','categoryCode','SUP','unresolved',null)`,
        ),
      ).rejects.toThrow(/outcome_check|violates check constraint/i);
      expect(HOTELBEDS_CLASSIFICATION_POLICY.mappings.SUP).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  describe("provenance is structural", () => {
    it("11. cites the exact observation that produced it", async () => {
      const f = await fixture({ categoryCode: "4EST" });
      const id = await insertStar(f, {
        sourceValue: "4EST",
        outcome: "exact_four",
        starValue: 4,
      });

      const rows = await adminQuery<{ evidence: string; identity: string }>(
        `select evidence_observation_id as evidence, source_property_identity_id as identity
           from public.source_property_star_resolution_revisions where id = $1`,
        [id],
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
      ).rejects.toThrow(/star_resolution_revisions_evidence_fk/i);
      await expect(
        insertLocation(mine, { evidenceObservationId: theirs.observationId }),
      ).rejects.toThrow(/location_resolution_revisions_evidence_fk/i);
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

    it("13. cannot cross evaluation and production streams", async () => {
      const evaluation = await fixture({ environment: "evaluation" });
      // Claim production for an evaluation identity: the identity composite FK
      // refuses, exactly as 0027 does for the canonical link.
      await expect(insertStar(evaluation, { environment: "production" })).rejects.toThrow(
        /star_resolution_revisions_identity_fk/i,
      );
    });

    it("cannot cross providers either", async () => {
      const hb = await fixture({ source: "hotelbeds" });
      // Two independent guards refuse this, and whichever fires first is fine:
      // the policy must belong to the observation's provider, and the identity
      // composite FK must match on `source`.
      await expect(insertStar(hb, { source: "other_provider" })).rejects.toThrow(
        /policy_source_ck|identity_fk/i,
      );
      const def = await adminQuery<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint
          where conname = 'source_property_star_resolution_revisions_identity_fk'`,
      );
      expect(def[0]!.def).toMatch(/source_property_identity_id, source, source_environment/i);
    });

    it("protects the cited observation from deletion", async () => {
      // Observations are already append-only in 0027; this proves the REVISION
      // also holds them, so the guarantee does not depend on that alone.
      const defs = await adminQuery<{ conname: string; def: string }>(
        `select conname, pg_get_constraintdef(oid) as def from pg_constraint
          where conname in ('source_property_star_resolution_revisions_evidence_fk',
                            'source_property_star_resolution_revisions_conflict_obs_fk',
                            'source_property_location_resolution_revisions_evidence_fk',
                            'source_property_location_resolution_revisions_conflict_obs_fk')`,
      );
      expect(defs).toHaveLength(4);
      for (const row of defs) expect(row.def, row.conname).toMatch(/ON DELETE RESTRICT/i);
    });
  });

  // -----------------------------------------------------------------------
  // LOCATION EVIDENCE INTEGRITY
  // -----------------------------------------------------------------------
  // `coordinates_missing` and `coordinates_implausible` are claims ABOUT THE
  // PROVIDER, and a wrong one is a defamation of the data. Each is checked
  // against what the cited observation actually carries, in both directions.
  describe("location evidence integrity", () => {
    it("REFUSES resolving a location from implausible coordinates", async () => {
      const bad = await fixture({ latitude: 999, longitude: -244.7, plausible: false });
      await expect(insertLocation(bad, { lat: 999, lon: -244.7 })).rejects.toThrow(
        /missing or implausible/i,
      );
    });

    it("REFUSES resolving a location from absent coordinates", async () => {
      const none = await fixture({ latitude: null, longitude: null, plausible: null });
      await expect(insertLocation(none, { lat: null, lon: null })).rejects.toThrow(
        /outcome_shape|missing or implausible/i,
      );
    });

    it("REFUSES coordinates_missing when the evidence supplies BOTH", async () => {
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

    it("ACCEPTS coordinates_missing when EITHER coordinate is absent", async () => {
      for (const partial of [
        { latitude: -8.5, longitude: null },
        { latitude: null, longitude: 115.2 },
        { latitude: null, longitude: null },
      ]) {
        const f = await fixture({ ...partial, plausible: null });
        await expect(
          insertLocation(f, {
            outcome: "unresolved",
            lat: null,
            lon: null,
            reason: "coordinates_missing",
          }),
          `lat=${partial.latitude} lon=${partial.longitude}`,
        ).resolves.toBeTruthy();
      }
    });

    it("REFUSES coordinates_implausible when NO coordinates were supplied", async () => {
      // "The provider gave us nothing" and "the provider gave us something wrong"
      // are different findings about the source, and collapsing them would make
      // the coverage numbers lie.
      const none = await fixture({ latitude: null, longitude: null, plausible: null });
      await expect(
        insertLocation(none, {
          outcome: "unresolved",
          lat: null,
          lon: null,
          reason: "coordinates_implausible",
        }),
      ).rejects.toThrow(/supplies no coordinates at all/i);
    });

    it("REFUSES coordinates_implausible for coordinates audited as PLAUSIBLE", async () => {
      const good = await fixture({ latitude: -8.5, longitude: 115.2, plausible: true });
      await expect(
        insertLocation(good, {
          outcome: "unresolved",
          lat: null,
          lon: null,
          reason: "coordinates_implausible",
        }),
      ).rejects.toThrow(/plausibility verdict is true/i);
    });

    it("ACCEPTS coordinates_implausible for supplied-but-implausible coordinates", async () => {
      const bad = await fixture({ latitude: -8.69, longitude: -244.73, plausible: false });
      await expect(
        insertLocation(bad, {
          outcome: "unresolved",
          lat: null,
          lon: null,
          reason: "coordinates_implausible",
        }),
      ).resolves.toBeTruthy();
    });

    // UNKNOWN is not FALSE. `source_coordinates_plausible` is nullable, so an
    // observation can carry coordinates the ingestion audit never judged;
    // reporting those as `coordinates_implausible` accuses the provider of
    // supplying bad data on evidence that says nothing at all.
    it("REFUSES coordinates_implausible when the plausibility verdict is UNKNOWN", async () => {
      const unknown = await fixture({ latitude: -8.5, longitude: 115.2, plausible: null });
      await expect(
        insertLocation(unknown, {
          outcome: "unresolved",
          lat: null,
          lon: null,
          reason: "coordinates_implausible",
        }),
      ).rejects.toThrow(/plausibility verdict is UNKNOWN/i);
    });

    it("ACCEPTS coordinates_plausibility_unknown for exactly that case", async () => {
      const unknown = await fixture({ latitude: -8.5, longitude: 115.2, plausible: null });
      await expect(
        insertLocation(unknown, {
          outcome: "unresolved",
          lat: null,
          lon: null,
          reason: "coordinates_plausibility_unknown",
        }),
      ).resolves.toBeTruthy();
    });

    it("REFUSES coordinates_plausibility_unknown when a verdict EXISTS", async () => {
      for (const plausible of [true, false]) {
        const f = await fixture({ latitude: -8.5, longitude: 115.2, plausible });
        await expect(
          insertLocation(f, {
            outcome: "unresolved",
            lat: null,
            lon: null,
            reason: "coordinates_plausibility_unknown",
          }),
          `plausible=${plausible}`,
        ).rejects.toThrow(/carries an explicit plausibility verdict/i);
      }
    });

    it("REFUSES coordinates_plausibility_unknown when no coordinates were supplied", async () => {
      const none = await fixture({ latitude: null, longitude: null, plausible: null });
      await expect(
        insertLocation(none, {
          outcome: "unresolved",
          lat: null,
          lon: null,
          reason: "coordinates_plausibility_unknown",
        }),
      ).rejects.toThrow(/supplies no coordinates at all/i);
    });

    it("REFUSES a location policy version that was never approved", async () => {
      // The location twin of the star policy FK. Before this, a resolution could
      // carry correct coordinates while citing `hotelbeds-location/999`.
      const f = await fixture({ latitude: -8.5, longitude: 115.2 });
      await expect(insertLocation(f, { policyVersion: "hotelbeds-location/999" })).rejects.toThrow(
        /location_resolution_revisions_policy_fk/i,
      );
      // The approved one is a row, not a schema constant.
      const rows = await adminQuery<{ provider: string; version: string }>(
        `select provider, version from public.provider_location_policies order by provider, version`,
      );
      expect(rows).toEqual([{ provider: "hotelbeds", version: "hotelbeds-location/1" }]);
    });
  });

  // -----------------------------------------------------------------------
  // CONFLICT EVIDENCE INTEGRITY
  // -----------------------------------------------------------------------
  // A conflict sends a candidate to human review. Manufacturing one from an
  // observation that does not actually disagree is as damaging as missing a real
  // one, so the citation is checked the same way the resolution's own is.
  describe("star conflict evidence integrity", () => {
    it("ACCEPTS a genuine disagreement between two mapped observations", async () => {
      const f = await fixture({ categoryCode: "4EST" });
      const other = await addObservation(f, { categoryCode: "5EST" });
      await expect(
        insertStar(f, {
          sourceValue: "4EST",
          outcome: "exact_four",
          starValue: 4,
          conflictObservationId: other,
          conflictOutcome: "exact_five",
        }),
      ).resolves.toBeTruthy();
    });

    it("REFUSES a conflicting_outcome the policy does not reach from that observation", async () => {
      const f = await fixture({ categoryCode: "4EST" });
      const other = await addObservation(f, { categoryCode: "3EST" });
      await expect(
        insertStar(f, {
          sourceValue: "4EST",
          outcome: "exact_four",
          starValue: 4,
          conflictObservationId: other,
          // 3EST maps to classified_not_v1_scope, not exact_five.
          conflictOutcome: "exact_five",
        }),
      ).rejects.toThrow(/conflicting_outcome says/i);
    });

    it("REFUSES a conflict cited from an UNRESOLVED observation", async () => {
      const f = await fixture({ categoryCode: "5EST" });
      const other = await addObservation(f, { categoryCode: "VILLA" });
      await expect(
        insertStar(f, {
          conflictObservationId: other,
          conflictOutcome: "exact_four",
        }),
      ).rejects.toThrow(/not a competing claim and cannot manufacture a conflict/i);
    });

    it("REFUSES a conflict that agrees with the resolution", async () => {
      const f = await fixture({ categoryCode: "5EST" });
      const other = await addObservation(f, { categoryCode: "5LUX" });
      await expect(
        insertStar(f, { conflictObservationId: other, conflictOutcome: "exact_five" }),
      ).rejects.toThrow(/conflict_differs/i);
    });

    it("REFUSES an observation conflicting with itself", async () => {
      // Necessarily also an agreement — one observation maps to one outcome — so
      // the same constraint catches both halves of "this is not a disagreement".
      const f = await fixture({ categoryCode: "5EST" });
      await expect(
        insertStar(f, { conflictObservationId: f.observationId, conflictOutcome: "exact_five" }),
      ).rejects.toThrow(/conflict_differs/i);
    });

    it("REFUSES a conflict on an UNRESOLVED resolution", async () => {
      // Nothing was decided, so there is nothing for a second reading to
      // contradict. This would otherwise queue reviews for candidates that have
      // no classification to review.
      const f = await fixture({ categoryCode: "SPC" });
      const other = await addObservation(f, { categoryCode: "5EST" });
      await expect(
        insertStar(f, {
          sourceValue: "SPC",
          outcome: "unresolved",
          starValue: null,
          conflictObservationId: other,
          conflictOutcome: "exact_five",
        }),
      ).rejects.toThrow(/conflict_differs/i);
    });

    it("cannot record a conflict without naming what it conflicts with", async () => {
      const f = await fixture();
      await expect(insertStar(f, { conflictState: "conflict" })).rejects.toThrow(
        /conflict_shape|not a competing claim/i,
      );
      // …nor cite conflict evidence while declaring no conflict, which would
      // leave a disagreement recorded and invisible.
      const other = await addObservation(f, { categoryCode: "4EST" });
      await expect(
        insertStar(f, {
          conflictState: "none",
          conflictObservationId: other,
          conflictOutcome: "exact_four",
        }),
      ).rejects.toThrow(/conflict_shape/i);
    });

    it("cannot cite another candidate's observation as the conflict", async () => {
      const mine = await fixture({ categoryCode: "5EST" });
      const theirs = await fixture({ categoryCode: "4EST" });
      await expect(
        insertStar(mine, {
          conflictObservationId: theirs.observationId,
          conflictOutcome: "exact_four",
        }),
      ).rejects.toThrow(/conflict_obs_fk/i);
    });
  });

  describe("location conflict evidence integrity", () => {
    it("ACCEPTS a genuinely different coordinate pair", async () => {
      const f = await fixture({ latitude: -8.5, longitude: 115.2 });
      const other = await addObservation(f, { latitude: -8.5001, longitude: 115.2 });
      await expect(insertLocation(f, { conflictObservationId: other })).resolves.toBeTruthy();
    });

    it("REFUSES a conflict from an IDENTICAL coordinate pair", async () => {
      const f = await fixture({ latitude: -8.5, longitude: 115.2 });
      const same = await addObservation(f, { latitude: -8.5, longitude: 115.2 });
      await expect(insertLocation(f, { conflictObservationId: same })).rejects.toThrow(
        /Agreement is not a conflict/i,
      );
    });

    it("REFUSES a conflict from an observation with no coordinates", async () => {
      const f = await fixture({ latitude: -8.5, longitude: 115.2 });
      const none = await addObservation(f, {
        latitude: null,
        longitude: null,
        plausible: null,
      });
      await expect(insertLocation(f, { conflictObservationId: none })).rejects.toThrow(
        /no usable coordinates/i,
      );
    });

    it("REFUSES a conflict from an IMPLAUSIBLE observation", async () => {
      const f = await fixture({ latitude: -8.5, longitude: 115.2 });
      const bad = await addObservation(f, {
        latitude: -8.69,
        longitude: -244.73,
        plausible: false,
      });
      await expect(insertLocation(f, { conflictObservationId: bad })).rejects.toThrow(
        /no usable coordinates/i,
      );
    });

    it("REFUSES a conflict on an UNRESOLVED location", async () => {
      const f = await fixture({ latitude: null, longitude: null, plausible: null });
      const other = await addObservation(f, { latitude: -8.5, longitude: 115.2 });
      await expect(
        insertLocation(f, {
          outcome: "unresolved",
          lat: null,
          lon: null,
          reason: "coordinates_missing",
          conflictObservationId: other,
        }),
      ).rejects.toThrow(/conflict_differs/i);
    });

    it("REFUSES an observation conflicting with itself", async () => {
      // Its coordinates are trivially identical to the resolved pair, so the
      // "agreement is not a conflict" guard reaches it first.
      const f = await fixture({ latitude: -8.5, longitude: 115.2 });
      await expect(insertLocation(f, { conflictObservationId: f.observationId })).rejects.toThrow(
        /Agreement is not a conflict|conflict_differs/i,
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("shape constraints", () => {
    it("cannot claim a star value the outcome does not support", async () => {
      // For a MAPPED code the policy trigger reaches these first, which is the
      // stronger check. The shape constraint is what catches the case the policy
      // has no opinion on: an unresolved outcome carrying a star value anyway.
      const f = await fixture({ categoryCode: "SPC" });
      await expect(
        insertStar(f, { sourceValue: "SPC", outcome: "unresolved", starValue: 5 }),
      ).rejects.toThrow(/value_shape/i);

      const g = await fixture({ categoryCode: "5EST" });
      await expect(
        insertStar(g, { sourceValue: "5EST", outcome: "exact_five", starValue: 4 }),
      ).rejects.toThrow(/value_shape|approved policy decides/i);
    });

    it("does not require an issuing authority", async () => {
      // D066: a registry is optional corroboration, never a gate.
      const f = await fixture({ categoryCode: "5EST" });
      const id = await insertStar(f);
      const rows = await adminQuery<{ authority: string | null }>(
        `select issuing_authority as authority
           from public.source_property_star_resolution_revisions where id = $1`,
        [id],
      );
      expect(rows[0]!.authority).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // IMMUTABLE REVISIONS + A MOVING HEAD
  // -----------------------------------------------------------------------
  // The reason for the whole split: a future D062 publication cites a revision
  // as the evidence that authorised it. If that row can be rewritten, the
  // citation is a promise the database does not keep.
  describe("resolution history is immutable", () => {
    it("REFUSES to update a revision's semantic fields", async () => {
      const f = await fixture({ categoryCode: "5EST" });
      const id = await insertStar(f);
      await expect(
        adminQuery(
          `update public.source_property_star_resolution_revisions
              set outcome = 'exact_four', resolved_star_value = 4 where id = $1`,
          [id],
        ),
      ).rejects.toThrow(/IMMUTABLE/i);
    });

    it("REFUSES to update the observation a revision cites", async () => {
      const f = await fixture({ categoryCode: "5EST" });
      const id = await insertStar(f);
      const other = await addObservation(f, { categoryCode: "4EST" });
      await expect(
        adminQuery(
          `update public.source_property_star_resolution_revisions
              set evidence_observation_id = $2 where id = $1`,
          [id, other],
        ),
      ).rejects.toThrow(/IMMUTABLE/i);
    });

    // Lineage is provenance too. `supersedes` says "this replaced that", and a
    // pointer into another candidate's history is a false statement about both
    // of them — the superseded candidate acquires a successor it never had.
    it("REFUSES lineage pointing at ANOTHER candidate's revision", async () => {
      const mine = await fixture({ categoryCode: "5EST" });
      const theirs = await fixture({ categoryCode: "5EST" });
      const theirRevision = await insertStar(theirs);
      await expect(insertStar(mine, { supersedesRevisionId: theirRevision })).rejects.toThrow(
        /star_resolution_revisions_supersedes_fk/i,
      );

      const mineLoc = await fixture({ latitude: -8.5, longitude: 115.2 });
      const theirsLoc = await fixture({ latitude: -8.5, longitude: 115.2 });
      const theirLocRevision = await insertLocation(theirsLoc);
      await expect(
        insertLocation(mineLoc, { supersedesRevisionId: theirLocRevision }),
      ).rejects.toThrow(/location_resolution_revisions_supersedes_fk/i);
    });

    it("REFUSES a revision that supersedes ITSELF", async () => {
      const f = await fixture({ categoryCode: "5EST" });
      const id = randomUUID();
      await expect(insertStar(f, { id, supersedesRevisionId: id })).rejects.toThrow(
        /supersedes_self/i,
      );

      const g = await fixture({ latitude: -8.5, longitude: 115.2 });
      const locId = randomUUID();
      await expect(insertLocation(g, { id: locId, supersedesRevisionId: locId })).rejects.toThrow(
        /supersedes_self/i,
      );
    });

    it("ACCEPTS lineage within the SAME candidate", async () => {
      const f = await fixture({ categoryCode: "5EST" });
      const first = await insertStar(f);
      const second = await insertStar(f, {
        policyVersion: "hotelbeds-classification/2-test",
        supersedesRevisionId: first,
      });
      const rows = await adminQuery<{ supersedes: string }>(
        `select supersedes_revision_id as supersedes
           from public.source_property_star_resolution_revisions where id = $1`,
        [second],
      );
      expect(rows[0]!.supersedes).toBe(first);
    });

    it("REFUSES to delete a revision", async () => {
      const f = await fixture({ categoryCode: "5EST" });
      const id = await insertStar(f);
      await expect(
        adminQuery(`delete from public.source_property_star_resolution_revisions where id = $1`, [
          id,
        ]),
      ).rejects.toThrow(/IMMUTABLE/i);
      await expect(
        adminQuery(
          `delete from public.source_property_location_resolution_revisions where id is not null`,
        ),
      ).rejects.toThrow(/IMMUTABLE/i);
    });

    it("holds no UPDATE or DELETE privilege for any client role", async () => {
      const rows = await adminQuery<{
        table_name: string;
        privilege_type: string;
        grantee: string;
      }>(
        `select table_name, privilege_type, grantee
           from information_schema.role_table_grants
          where table_schema = 'public'
            and table_name in ('source_property_star_resolution_revisions',
                               'source_property_location_resolution_revisions')
            and privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE')
            and grantee in ('anon', 'authenticated', 'service_role')`,
      );
      expect(rows, JSON.stringify(rows)).toHaveLength(0);
    });

    it("an identical replay creates NO new revision and moves NO pointer", async () => {
      const f = await fixture({ categoryCode: "5EST" });
      const id = await insertStar(f);
      await setStarHead(f.identityId, id);

      // Byte-identical conclusion from byte-identical evidence: the digest is the
      // same, so the append is refused rather than duplicated.
      await expect(insertStar(f)).rejects.toThrow(/digest_uk|duplicate key/i);

      const rows = await adminQuery<{ n: string }>(
        `select count(*)::text as n from public.source_property_star_resolution_revisions
          where source_property_identity_id = $1`,
        [f.identityId],
      );
      expect(rows[0]!.n).toBe("1");
    });

    it("a NEW conclusion appends a revision, leaves the old one untouched, and moves the head", async () => {
      const f = await fixture({ categoryCode: "4EST" });
      const first = await insertStar(f, {
        sourceValue: "4EST",
        outcome: "exact_four",
        starValue: 4,
      });
      await setStarHead(f.identityId, first);

      const snapshot = async (id: string) =>
        (
          await adminQuery<{ row: string }>(
            `select outcome || ':' || coalesce(source_value,'') || ':' ||
                    evidence_observation_id::text || ':' || conflict_state || ':' ||
                    coalesce(resolved_star_value::text,'') || ':' || revision_digest as row
               from public.source_property_star_resolution_revisions where id = $1`,
            [id],
          )
        )[0]!.row;
      const before = await snapshot(first);

      // A later observation disagrees. The candidate goes to conflict — as a NEW
      // revision that supersedes the pre-conflict one.
      const other = await addObservation(f, { categoryCode: "5EST" });
      const second = await insertStar(f, {
        sourceValue: "4EST",
        outcome: "exact_four",
        starValue: 4,
        conflictObservationId: other,
        conflictOutcome: "exact_five",
        // Lineage is recorded at insert time, because it can never be added later.
        supersedesRevisionId: first,
      });
      await setStarHead(f.identityId, second);

      expect(second).not.toBe(first);
      expect(await snapshot(first), "the pre-conflict revision was rewritten").toBe(before);

      const head = await adminQuery<{ current: string; total: string }>(
        `select h.current_revision_id as current,
                (select count(*)::text from public.source_property_star_resolution_revisions
                  where source_property_identity_id = $1) as total
           from public.source_property_star_resolutions h
          where h.source_property_identity_id = $1`,
        [f.identityId],
      );
      expect(head[0]!.current).toBe(second);
      expect(head[0]!.total).toBe("2");

      const lineage = await adminQuery<{ supersedes: string | null }>(
        `select supersedes_revision_id as supersedes
           from public.source_property_star_resolution_revisions where id = $1`,
        [second],
      );
      expect(lineage[0]!.supersedes).toBe(first);
    });

    it("a POLICY VERSION change appends a revision rather than overwriting one", async () => {
      const f = await fixture({ categoryCode: "5EST" });
      const v1 = await insertStar(f);
      const v2 = await insertStar(f, { policyVersion: "hotelbeds-classification/2-test" });
      expect(v2).not.toBe(v1);

      const rows = await adminQuery<{ id: string; policy_version: string }>(
        `select id, policy_version from public.source_property_star_resolution_revisions
          where source_property_identity_id = $1 order by created_at`,
        [f.identityId],
      );
      expect(rows.map((r) => r.policy_version)).toEqual([
        "hotelbeds-classification/1",
        "hotelbeds-classification/2-test",
      ]);
    });

    it("has exactly one unambiguous CURRENT resolution per candidate", async () => {
      const f = await fixture({ categoryCode: "5EST" });
      const a = await insertStar(f);
      const b = await insertStar(f, { policyVersion: "hotelbeds-classification/2-test" });
      await setStarHead(f.identityId, a);
      await setStarHead(f.identityId, b);

      const heads = await adminQuery<{ n: string }>(
        `select count(*)::text as n from public.source_property_star_resolutions
          where source_property_identity_id = $1`,
        [f.identityId],
      );
      expect(heads[0]!.n).toBe("1");

      const view = await adminQuery<{ id: string }>(
        `select id from public.source_property_current_star_resolutions
          where source_property_identity_id = $1`,
        [f.identityId],
      );
      expect(view).toHaveLength(1);
      expect(view[0]!.id).toBe(b);
    });

    it("a head can only ever name a revision of its OWN candidate", async () => {
      const mine = await fixture({ categoryCode: "5EST" });
      const theirs = await fixture({ categoryCode: "5EST" });
      const theirRevision = await insertStar(theirs);
      await expect(setStarHead(mine.identityId, theirRevision)).rejects.toThrow(
        /star_resolutions_revision_fk/i,
      );
    });

    it("a revision that a head points at cannot be deleted out from under it", async () => {
      const def = await adminQuery<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint
          where conname = 'source_property_star_resolutions_revision_fk'`,
      );
      expect(def[0]!.def).toMatch(/ON DELETE RESTRICT/i);
    });

    it("the current view reads state without replaying history", async () => {
      // One join from the head, not an aggregate over every revision — invariant
      // 8, and the reason the head table exists at all.
      const def = await adminQuery<{ definition: string }>(
        `select pg_get_viewdef('public.source_property_current_star_resolutions'::regclass, true)
                  as definition`,
      );
      expect(def[0]!.definition).not.toMatch(/order by|row_number|distinct on|max\(/i);
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

    it("does not mistake a different NUMBER OF DECIMALS for a different place", () => {
      // `numeric` preserves the scale it was given, so the same point can come
      // back as `-8.5` and `-8.5000`. Comparing the strings would queue this for
      // human review — and the database, which compares as numeric, would then
      // refuse the conflict as agreement and abort the transaction.
      for (const [a, b] of [
        ["-8.5", "-8.5000"],
        ["115.2", "115.200000"],
        ["0.0", "-0"],
        ["-8.50", "-08.5"],
      ]) {
        const r = resolveLocationFromObservations([
          obs({ id: "o1", lat: a, lon: "115.2" }),
          obs({ id: "o2", lat: b, lon: "115.200" }),
        ])!;
        expect(r.outcome, `${a} vs ${b}`).toBe("resolved");
        expect(r.conflictObservationId, `${a} vs ${b} manufactured a conflict`).toBeNull();
        // The evidence is preserved exactly as the provider gave it.
        expect(r.latitude).toBe(a);
      }
    });

    it("still calls a REAL difference a conflict, at any magnitude", () => {
      for (const [a, b] of [
        ["-8.5", "-8.5001"],
        ["-8.5", "-8.50001"],
        ["115.2", "115.2000001"],
      ]) {
        const r = resolveLocationFromObservations([
          obs({ id: "o1", lat: a, lon: "115.2" }),
          obs({ id: "o2", lat: b, lon: "115.2" }),
        ])!;
        expect(r.conflictObservationId, `${a} vs ${b} was not flagged`).toBe("o2");
      }
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

    it("is deterministic: the same observations always fold the same way", () => {
      const rows = [obs({ id: "o1", code: "4EST" }), obs({ id: "o2", code: "5EST" })];
      expect(star(rows)).toEqual(star(rows));
    });
  });

  // -----------------------------------------------------------------------
  describe("15. canonical safety and security", () => {
    it("writes nothing canonical", async () => {
      const snapshot = async () =>
        (
          await adminQuery<Record<string, string>>(
            `select (select count(*) from public.hotels)::text h,
                    (select count(*) from public.hotel_source_identities)::text l,
                    (select count(*) from public.hotel_contacts)::text ct,
                    (select count(*) from public.source_match_candidates)::text c,
                    (select count(*) from public.source_property_reviews)::text r,
                    (select count(*) from public.editorial_evidence)::text e`,
          )
        )[0];
      const before = await snapshot();
      const f = await fixture({ categoryCode: "5EST" });
      const starId = await insertStar(f);
      const locationId = await insertLocation(f);
      await setStarHead(f.identityId, starId);
      expect(locationId).toBeTruthy();
      expect(await snapshot()).toEqual(before);
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

    it("gives anon no access to any 0028 relation", async () => {
      for (const relation of [
        "provider_classification_policies",
        "provider_classification_policy_mappings",
        "provider_location_policies",
        "source_property_star_resolution_revisions",
        "source_property_location_resolution_revisions",
        "source_property_star_resolutions",
        "source_property_location_resolutions",
        "source_property_current_star_resolutions",
        "source_property_current_location_resolutions",
      ]) {
        const res = await queryAs({ role: "anon", sub: null }, `select * from public.${relation}`);
        expect(res.error, `anon reached ${relation}`).not.toBeNull();
        expect(res.error?.code).toBe("42501");
      }
    });

    it("lets an ordinary creator read nothing, despite holding the privilege", async () => {
      const f = await fixture({ categoryCode: "5EST" });
      const id = await insertStar(f);
      await setStarHead(f.identityId, id);
      await insertLocation(f);
      for (const relation of [
        "source_property_star_resolution_revisions",
        "source_property_location_resolution_revisions",
        "source_property_star_resolutions",
        "source_property_location_resolutions",
        "provider_classification_policy_mappings",
        "provider_location_policies",
        // The views are `security_invoker`, so RLS reaches through them. A
        // definer view here would have handed the creator the whole table.
        "source_property_current_star_resolutions",
        "source_property_current_location_resolutions",
      ]) {
        const res = await queryAs<{ n: string }>(
          { role: "authenticated", sub: USERS.free },
          `select count(*)::text as n from public.${relation}`,
        );
        expect(res.error, `creator errored on ${relation}`).toBeNull();
        expect(res.rows[0]!.n, `creator saw rows in ${relation}`).toBe("0");
      }
    });

    it("has RLS enabled on every 0028 table", async () => {
      const names = [
        "provider_classification_policies",
        "provider_classification_policy_mappings",
        "provider_location_policies",
        "source_property_star_resolution_revisions",
        "source_property_location_resolution_revisions",
        "source_property_star_resolutions",
        "source_property_location_resolutions",
      ];
      const rows = await adminQuery<{ relname: string; relrowsecurity: boolean }>(
        `select c.relname, c.relrowsecurity from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = any($1)`,
        [names],
      );
      expect(rows).toHaveLength(names.length);
      for (const row of rows) expect(row.relrowsecurity, row.relname).toBe(true);
    });
  });
});
