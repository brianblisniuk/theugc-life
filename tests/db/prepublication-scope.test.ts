/**
 * Pre-publication physical-hospitality resolution (migration 0029).
 *
 * This dimension answers ONE question — is this candidate a physical hospitality
 * property? — and the suite is built around what that question is NOT.
 *
 * D060 says property type alone does not decide V1 eligibility. So there is no
 * assertion here that a `physical_hospitality` result makes anything eligible,
 * no column named `eligible`, and a deliberate test that resolving scope changes
 * no star outcome. The V1 gate is composed later, at the D062 preview.
 *
 * The integrity guarantees are 0028's, re-proved for the third dimension against
 * direct SQL rather than through the resolver: the policy must be approved and
 * frozen, the outcome must be the one that policy reaches, the evidence must
 * belong to the candidate, and the revision must be immutable afterwards.
 *
 * All fixtures synthetic. No real provider data appears here.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "./harness";
import { seed, USERS, DEST } from "../rls/seed";
import { HOTELBEDS_HOSPITALITY_SCOPE_POLICY } from "../../scripts/provider-scope/hotelbeds";
import { resolveScopeCode } from "../../scripts/provider-scope/policy";
import { resolveScopeFromObservations } from "../../scripts/provider-resolution/resolver";

const d = describe.skipIf(!hasTestDb);

const SOURCE = "hotelbeds";
const POLICY = {
  provider: "hotelbeds",
  version: "hotelbeds-hospitality-scope/1",
  field: "accommodationTypeCode",
};

/**
 * The Hotelbeds accommodations master, all 24 codes, as retrieved to exhaustion
 * in PR #21 (`exhaustionProven: true`).
 *
 * Recorded here rather than read from `.data/`, which is gitignored: this is the
 * reviewed EVIDENCE the policy rests on, so it belongs in the repository where a
 * reviewer can see what was decided against. Full reasoning per code is
 * `docs/PROPERTY_SOURCE_HOSPITALITY_SCOPE_POLICY.md`.
 */
const ACCOMMODATION_MASTER: Readonly<Record<string, string>> = {
  H: "Hotel",
  W: "Resort",
  P: "Aparthotel",
  G: "Guest house",
  K: "Bed and breakfast",
  S: "Hostel",
  M: "Motel",
  D: "Lodge",
  Z: "Rural hotel",
  X: "Historical hotel Luxurious",
  Q: "Boutique",
  U: "Cruise",
  L: "Boat",
  A: "Apartment",
  V: "Vacation home or villa",
  C: "Vacation condo or apartment",
  T: "Vacation Townhouse",
  R: "Vacation resort",
  Y: "Rural house",
  N: "Residence",
  B: "Botel",
  E: "Camping",
  I: "Riad",
  O: "Pousada",
};

/** The reviewed decision, code by code. Absent from `mappings` = `unresolved`. */
const REVIEWED = {
  physical: ["H", "W", "P", "G", "K", "S", "M", "D", "Z", "X", "Q"],
  notPhysical: ["U", "L"],
  unresolved: ["A", "V", "C", "T", "R", "Y", "N", "B", "E", "I", "O"],
} as const;

let counter = 0;
const uniq = () => `s${Date.now().toString(36)}${(counter += 1)}`;

interface Fixture {
  identityId: string;
  runId: string;
  observationId: string;
  source: string;
  environment: string;
}

async function newRun(source: string, environment: string): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    `insert into public.source_runs (source, source_environment, destination_id, run_mode, started_at)
     values ($1, $2, $3, 'evaluation', now()) returning id`,
    [source, environment, DEST.bali],
  );
  return rows[0]!.id;
}

async function addObservation(
  f: Fixture,
  over: { typeCode?: string | null; categoryCode?: string | null; runId?: string } = {},
): Promise<string> {
  const runId = over.runId ?? (await newRun(f.source, f.environment));
  const rows = await adminQuery<{ id: string }>(
    `insert into public.source_property_observations
       (source_run_id, source_property_identity_id, source, source_environment, observed_at,
        source_property_type_code, source_property_type_label, source_classification_code)
     values ($1,$2,$3,$4, now(), $5, $6, $7) returning id`,
    [
      runId,
      f.identityId,
      f.source,
      f.environment,
      over.typeCode === undefined ? "H" : over.typeCode,
      over.typeCode === undefined ? "Hotel" : (ACCOMMODATION_MASTER[over.typeCode ?? ""] ?? null),
      over.categoryCode === undefined ? "5EST" : over.categoryCode,
    ],
  );
  return rows[0]!.id;
}

async function fixture(
  over: { typeCode?: string | null; categoryCode?: string | null; source?: string } = {},
): Promise<Fixture> {
  const source = over.source ?? SOURCE;
  const environment = "evaluation";
  const runId = await newRun(source, environment);
  const identity = await adminQuery<{ id: string }>(
    `insert into public.source_property_identities
       (source, source_environment, source_property_id, first_seen_run_id, last_seen_run_id)
     values ($1, $2, $3, $4, $4) returning id`,
    [source, environment, uniq(), runId],
  );
  const f: Fixture = {
    identityId: identity[0]!.id,
    runId,
    observationId: "",
    source,
    environment,
  };
  f.observationId = await addObservation(f, { ...over, runId });
  return f;
}

interface ScopeOverrides {
  id?: string;
  identityId?: string;
  evidenceObservationId?: string;
  policyProvider?: string;
  policyVersion?: string;
  policyField?: string;
  sourceValue?: string | null;
  outcome?: string;
  source?: string;
  environment?: string;
  supersedesRevisionId?: string | null;
}

/** Insert a scope revision directly, to probe the database's own guards. */
async function insertScope(f: Fixture, over: ScopeOverrides = {}): Promise<string> {
  const pick = <T>(key: keyof ScopeOverrides, fallback: T): T =>
    key in over ? (over[key] as T) : fallback;
  const rows = await adminQuery<{ id: string }>(
    `insert into public.source_property_scope_resolution_revisions
       (id, source_property_identity_id, source, source_environment, evidence_observation_id,
        policy_provider, policy_version, policy_field, source_value, outcome, supersedes_revision_id)
     values (coalesce($11::uuid, gen_random_uuid()),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [
      over.identityId ?? f.identityId,
      over.source ?? f.source,
      over.environment ?? f.environment,
      over.evidenceObservationId ?? f.observationId,
      over.policyProvider ?? POLICY.provider,
      over.policyVersion ?? POLICY.version,
      over.policyField ?? POLICY.field,
      pick<string | null>("sourceValue", "H"),
      over.outcome ?? "physical_hospitality",
      pick<string | null>("supersedesRevisionId", null),
      pick<string | null>("id", null),
    ],
  );
  return rows[0]!.id;
}

async function setHead(identityId: string, revisionId: string): Promise<void> {
  await adminQuery(
    `insert into public.source_property_scope_resolutions
       (source_property_identity_id, current_revision_id) values ($1,$2)
     on conflict (source_property_identity_id) do update
       set current_revision_id = excluded.current_revision_id`,
    [identityId, revisionId],
  );
}

/** A synthetic observation row for the pure fold. */
function obs(over: Record<string, unknown> = {}) {
  const pick = <T>(key: string, fallback: T): T => (key in over ? (over[key] as T) : fallback);
  return {
    id: (over.id as string) ?? "obs-1",
    source_property_identity_id: (over.identity as string) ?? "identity-1",
    source: SOURCE,
    source_environment: "evaluation",
    source_classification_code: pick<string | null>("code", "5EST"),
    source_property_type_code: pick<string | null>("typeCode", "H"),
    source_latitude: "-8.5",
    source_longitude: "115.2",
    source_coordinates_plausible: true,
    observed_at: "2026-08-01T00:00:00.000Z",
  };
}

const scope = (rows: ReturnType<typeof obs>[]) =>
  resolveScopeFromObservations(rows, HOTELBEDS_HOSPITALITY_SCOPE_POLICY);

d("pre-publication physical-hospitality scope (0029)", () => {
  beforeAll(async () => {
    await setupDatabase();
    await seed();

    // A DRAFT version — the only one whose mappings can still be written, so the
    // mapping-shape constraints are reachable — and an approved v2 for lifecycle
    // tests. Assembled then approved, the only way any version can be built.
    await adminQuery(
      `insert into public.provider_hospitality_scope_policies (provider, version, field, notes) values
         ('hotelbeds', 'hotelbeds-hospitality-scope/draft-test', 'accommodationTypeCode', 'draft fixture'),
         ('hotelbeds', 'hotelbeds-hospitality-scope/2-test', 'accommodationTypeCode', 'test fixture'),
         ('provider_b', 'provider-b-scope/1', 'accommodationTypeCode', 'test fixture')
       on conflict do nothing`,
    );
    await adminQuery(
      `insert into public.provider_hospitality_scope_policy_mappings
         (provider, version, field, source_code, outcome) values
         ('hotelbeds','hotelbeds-hospitality-scope/2-test','accommodationTypeCode','H','physical_hospitality'),
         ('provider_b','provider-b-scope/1','accommodationTypeCode','H','not_physical_hospitality')
       on conflict do nothing`,
    );
    await adminQuery(
      `update public.provider_hospitality_scope_policies set approved_at = now()
        where approved_at is null and version <> 'hotelbeds-hospitality-scope/draft-test'`,
    );
  });
  afterAll(teardownDatabase);

  // -----------------------------------------------------------------------
  describe("1. the policy matches the reviewed accommodations master", () => {
    it("accounts for all 24 master codes exactly once", () => {
      const all = [...REVIEWED.physical, ...REVIEWED.notPhysical, ...REVIEWED.unresolved];
      expect(all.length).toBe(24);
      expect(new Set(all).size).toBe(24);
      expect([...all].sort()).toEqual(Object.keys(ACCOMMODATION_MASTER).sort());
    });

    it("maps exactly the reviewed codes, and nothing else", () => {
      const mapped = HOTELBEDS_HOSPITALITY_SCOPE_POLICY.mappings;
      expect(Object.keys(mapped).sort()).toEqual(
        [...REVIEWED.physical, ...REVIEWED.notPhysical].sort(),
      );
      for (const code of REVIEWED.physical) expect(mapped[code], code).toBe("physical_hospitality");
      for (const code of REVIEWED.notPhysical) {
        expect(mapped[code], code).toBe("not_physical_hospitality");
      }
    });

    it("resolves every unreviewed master code to `unresolved`, never to not_physical", () => {
      // The distinction that matters: "we have not established this" is not the
      // same finding as "this is not a hospitality property".
      for (const code of REVIEWED.unresolved) {
        expect(resolveScopeCode(HOTELBEDS_HOSPITALITY_SCOPE_POLICY, code), code).toBe("unresolved");
      }
    });

    it("keeps Hostel IN scope — type and star eligibility are independent", () => {
      // D060: property type alone does not decide eligibility. Excluding `S`
      // here because the product sells 4/5 inventory would smuggle a
      // classification judgement into a type resolver.
      expect(resolveScopeCode(HOTELBEDS_HOSPITALITY_SCOPE_POLICY, "S")).toBe(
        "physical_hospitality",
      );
    });

    it("2. leaves an unknown or absent type code unresolved", () => {
      for (const code of ["ZZZ", "hotel", "", "  ", null, undefined]) {
        expect(resolveScopeCode(HOTELBEDS_HOSPITALITY_SCOPE_POLICY, code), String(code)).toBe(
          "unresolved",
        );
      }
      // …and still cites what it examined.
      expect(scope([obs({ typeCode: "ZZZ" })])).toMatchObject({
        outcome: "unresolved",
        evidenceObservationId: "obs-1",
        sourceValue: "ZZZ",
      });
    });

    it("the DB policy and the TypeScript policy cannot drift", async () => {
      const ts = HOTELBEDS_HOSPITALITY_SCOPE_POLICY;
      const policy = await adminQuery<{ field: string; approved: string | null }>(
        `select field, approved_at::text as approved
           from public.provider_hospitality_scope_policies
          where provider = $1 and version = $2`,
        [ts.provider, ts.version],
      );
      expect(policy, "the TypeScript policy has no row in the database").toHaveLength(1);
      expect(policy[0]!.field).toBe(ts.field);
      expect(policy[0]!.approved, "the shipped policy is not frozen").not.toBeNull();

      const rows = await adminQuery<{ source_code: string; outcome: string }>(
        `select source_code, outcome from public.provider_hospitality_scope_policy_mappings
          where provider = $1 and version = $2 and field = $3`,
        [ts.provider, ts.version, ts.field],
      );
      const fromDb = Object.fromEntries(rows.map((r) => [r.source_code, r.outcome]));
      // Both directions: a code added to one and not the other fails here.
      expect(fromDb).toEqual({ ...ts.mappings });
    });
  });

  // -----------------------------------------------------------------------
  describe("policy semantics are structural", () => {
    it("ACCEPTS the outcome the approved policy actually reaches", async () => {
      const hotel = await fixture({ typeCode: "H" });
      await expect(insertScope(hotel)).resolves.toBeTruthy();

      const boat = await fixture({ typeCode: "L" });
      await expect(
        insertScope(boat, { sourceValue: "L", outcome: "not_physical_hospitality" }),
      ).resolves.toBeTruthy();

      const villa = await fixture({ typeCode: "V" });
      await expect(
        insertScope(villa, { sourceValue: "V", outcome: "unresolved" }),
      ).resolves.toBeTruthy();
    });

    it("3. REFUSES a mapped code claimed as the wrong outcome", async () => {
      const hotel = await fixture({ typeCode: "H" });
      for (const outcome of ["not_physical_hospitality", "unresolved"]) {
        await expect(insertScope(hotel, { outcome }), outcome).rejects.toThrow(
          /approved policy decides the outcome, not the caller/i,
        );
      }
      const boat = await fixture({ typeCode: "L" });
      await expect(
        insertScope(boat, { sourceValue: "L", outcome: "physical_hospitality" }),
      ).rejects.toThrow(/approved policy decides the outcome, not the caller/i);
    });

    it("REFUSES an UNMAPPED code claimed as anything but unresolved", async () => {
      // A villa is not adjudicated as non-hospitality by our silence.
      for (const outcome of ["physical_hospitality", "not_physical_hospitality"]) {
        const f = await fixture({ typeCode: "V" });
        await expect(insertScope(f, { sourceValue: "V", outcome }), outcome).rejects.toThrow(
          /never acquires a meaning by accident/i,
        );
      }
    });

    it("4. REFUSES another provider's policy", async () => {
      // `provider_b`'s fixture policy maps H to not_physical_hospitality. If a
      // Hotelbeds observation could run through it, the scope fact would come
      // from a provider that never said it.
      const f = await fixture({ typeCode: "H" });
      await expect(
        insertScope(f, {
          policyProvider: "provider_b",
          policyVersion: "provider-b-scope/1",
          outcome: "not_physical_hospitality",
        }),
      ).rejects.toThrow(/policy_source_ck/i);
    });

    it("REFUSES a policy version or field that was never approved", async () => {
      const f = await fixture({ typeCode: "H" });
      await expect(
        insertScope(f, { policyVersion: "hotelbeds-hospitality-scope/99" }),
      ).rejects.toThrow(/not an APPROVED hospitality-scope policy \(no such policy\)/i);
      await expect(insertScope(f, { policyField: "hotelType" })).rejects.toThrow(
        /not an APPROVED hospitality-scope policy/i,
      );
    });

    it("5. REFUSES a policy version that exists but is still a DRAFT", async () => {
      const f = await fixture({ typeCode: "H" });
      await expect(
        insertScope(f, { policyVersion: "hotelbeds-hospitality-scope/draft-test" }),
      ).rejects.toThrow(/not an APPROVED hospitality-scope policy \(still a draft\)/i);
    });

    it("`unresolved` is not a storable mapping — absence IS the answer", async () => {
      await expect(
        adminQuery(
          `insert into public.provider_hospitality_scope_policy_mappings
             (provider, version, field, source_code, outcome)
           values ('hotelbeds','hotelbeds-hospitality-scope/draft-test','accommodationTypeCode','I','unresolved')`,
        ),
      ).rejects.toThrow(/outcome_check|violates check constraint/i);
      expect(HOTELBEDS_HOSPITALITY_SCOPE_POLICY.mappings.I).toBeUndefined();
    });

    it("a mapping cannot be attached to a policy that does not exist", async () => {
      await expect(
        adminQuery(
          `insert into public.provider_hospitality_scope_policy_mappings
             (provider, version, field, source_code, outcome)
           values ('provider_z','provider-z/1','accommodationTypeCode','H','physical_hospitality')`,
        ),
      ).rejects.toThrow(/policy_fk/i);
    });
  });

  // -----------------------------------------------------------------------
  describe("6. approved policy versions are immutable", () => {
    const V1 = "hotelbeds-hospitality-scope/1";

    it("REFUSES changing, deleting or adding a mapping", async () => {
      const attempts: [string, unknown[]][] = [
        [
          `update public.provider_hospitality_scope_policy_mappings
              set outcome = 'not_physical_hospitality'
            where provider='hotelbeds' and version=$1 and source_code='H'`,
          [V1],
        ],
        [
          `delete from public.provider_hospitality_scope_policy_mappings
            where provider='hotelbeds' and version=$1 and source_code='S'`,
          [V1],
        ],
        [
          // Nothing existing changes, and yet `V` would silently acquire a
          // meaning inside a version revisions already cite.
          `insert into public.provider_hospitality_scope_policy_mappings
             (provider, version, field, source_code, outcome)
           values ('hotelbeds',$1,'accommodationTypeCode','V','physical_hospitality')`,
          [V1],
        ],
        [
          // Moving a code OUT of a frozen version changes its meaning by removal.
          `update public.provider_hospitality_scope_policy_mappings
              set version = 'hotelbeds-hospitality-scope/draft-test'
            where provider='hotelbeds' and version=$1 and source_code='Q'`,
          [V1],
        ],
      ];
      for (const [sql, params] of attempts) {
        await expect(adminQuery(sql, params), sql).rejects.toThrow(/mapping set is IMMUTABLE/i);
      }
    });

    it("REFUSES changing the policy's field, un-approving it, or deleting it", async () => {
      for (const sql of [
        `update public.provider_hospitality_scope_policies set field = 'hotelType'
          where provider='hotelbeds' and version=$1`,
        `update public.provider_hospitality_scope_policies set approved_at = null
          where provider='hotelbeds' and version=$1`,
        `delete from public.provider_hospitality_scope_policies
          where provider='hotelbeds' and version=$1`,
      ]) {
        await expect(adminQuery(sql, [V1]), sql).rejects.toThrow(/is IMMUTABLE/i);
      }
    });

    it("the mapping set is unchanged after all of that", async () => {
      const rows = await adminQuery<{ n: string }>(
        `select count(*)::text as n from public.provider_hospitality_scope_policy_mappings
          where provider='hotelbeds' and version=$1`,
        [V1],
      );
      expect(rows[0]!.n).toBe("13");
    });

    it("a NEW version can still be assembled, approved and used normally", async () => {
      const version = `hotelbeds-hospitality-scope/${uniq()}`;
      await adminQuery(
        `insert into public.provider_hospitality_scope_policies (provider, version, field, notes)
         values ('hotelbeds', $1, 'accommodationTypeCode', 'a later review')`,
        [version],
      );
      // The obvious v2 candidate: `N` Residence, left unresolved in v1.
      await adminQuery(
        `insert into public.provider_hospitality_scope_policy_mappings
           (provider, version, field, source_code, outcome)
         values ('hotelbeds', $1, 'accommodationTypeCode', 'N', 'physical_hospitality')`,
        [version],
      );
      const draft = await fixture({ typeCode: "N" });
      await expect(
        insertScope(draft, { policyVersion: version, sourceValue: "N" }),
      ).rejects.toThrow(/still a draft/i);

      await adminQuery(
        `update public.provider_hospitality_scope_policies set approved_at = now()
          where provider='hotelbeds' and version=$1`,
        [version],
      );
      const f = await fixture({ typeCode: "N" });
      await expect(
        insertScope(f, { policyVersion: version, sourceValue: "N" }),
      ).resolves.toBeTruthy();

      await expect(
        adminQuery(
          `insert into public.provider_hospitality_scope_policy_mappings
             (provider, version, field, source_code, outcome)
           values ('hotelbeds', $1, 'accommodationTypeCode', 'I', 'physical_hospitality')`,
          [version],
        ),
      ).rejects.toThrow(/mapping set is IMMUTABLE/i);
    });
  });

  // -----------------------------------------------------------------------
  describe("provenance is structural", () => {
    it("7. REFUSES another identity's observation as evidence", async () => {
      const mine = await fixture();
      const theirs = await fixture();
      await expect(
        insertScope(mine, { evidenceObservationId: theirs.observationId }),
      ).rejects.toThrow(/scope_resolution_revisions_evidence_fk/i);
    });

    it("8. REFUSES a value the cited observation never carried", async () => {
      const villa = await fixture({ typeCode: "V" });
      await expect(insertScope(villa, { sourceValue: "H" })).rejects.toThrow(
        /may only restate what its evidence says/i,
      );
    });

    it("cannot cross environment or provider streams", async () => {
      const f = await fixture();
      await expect(insertScope(f, { environment: "production" })).rejects.toThrow(
        /scope_resolution_revisions_identity_fk/i,
      );
      await expect(insertScope(f, { source: "other_provider" })).rejects.toThrow(
        /policy_source_ck|identity_fk/i,
      );
    });

    it("protects the cited observation from deletion", async () => {
      const def = await adminQuery<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint
          where conname = 'source_property_scope_resolution_revisions_evidence_fk'`,
      );
      expect(def[0]!.def).toMatch(/ON DELETE RESTRICT/i);
    });
  });

  // -----------------------------------------------------------------------
  describe("9-13. immutable revisions, lineage and a moving head", () => {
    it("9. REFUSES updating or deleting a revision", async () => {
      const f = await fixture({ typeCode: "H" });
      const id = await insertScope(f);
      await expect(
        adminQuery(
          `update public.source_property_scope_resolution_revisions
              set outcome = 'unresolved' where id = $1`,
          [id],
        ),
      ).rejects.toThrow(/IMMUTABLE/i);
      await expect(
        adminQuery(`delete from public.source_property_scope_resolution_revisions where id = $1`, [
          id,
        ]),
      ).rejects.toThrow(/IMMUTABLE/i);
    });

    it("holds no UPDATE or DELETE privilege for any client role", async () => {
      const rows = await adminQuery<{ privilege_type: string; grantee: string }>(
        `select privilege_type, grantee from information_schema.role_table_grants
          where table_schema = 'public'
            and table_name = 'source_property_scope_resolution_revisions'
            and privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE')
            and grantee in ('anon', 'authenticated', 'service_role')`,
      );
      expect(rows, JSON.stringify(rows)).toHaveLength(0);
    });

    it("10. REFUSES lineage pointing at ANOTHER candidate's revision", async () => {
      const mine = await fixture({ typeCode: "H" });
      const theirs = await fixture({ typeCode: "H" });
      const theirRevision = await insertScope(theirs);
      await expect(insertScope(mine, { supersedesRevisionId: theirRevision })).rejects.toThrow(
        /scope_resolution_revisions_supersedes_fk/i,
      );
    });

    it("11. REFUSES a revision that supersedes ITSELF", async () => {
      const f = await fixture({ typeCode: "H" });
      const id = randomUUID();
      await expect(insertScope(f, { id, supersedesRevisionId: id })).rejects.toThrow(
        /supersedes_self/i,
      );
    });

    it("ACCEPTS lineage within the SAME candidate, and moves the head", async () => {
      const f = await fixture({ typeCode: "H" });
      const first = await insertScope(f);
      await setHead(f.identityId, first);
      const second = await insertScope(f, {
        policyVersion: "hotelbeds-hospitality-scope/2-test",
        supersedesRevisionId: first,
      });
      await setHead(f.identityId, second);

      const rows = await adminQuery<{ current: string; total: string }>(
        `select h.current_revision_id as current,
                (select count(*)::text from public.source_property_scope_resolution_revisions
                  where source_property_identity_id = $1) as total
           from public.source_property_scope_resolutions h
          where h.source_property_identity_id = $1`,
        [f.identityId],
      );
      expect(rows[0]!.current).toBe(second);
      expect(rows[0]!.total).toBe("2");

      const view = await adminQuery<{ id: string }>(
        `select id from public.source_property_current_scope_resolutions
          where source_property_identity_id = $1`,
        [f.identityId],
      );
      expect(view).toHaveLength(1);
      expect(view[0]!.id).toBe(second);
    });

    it("12. a head cannot point at another candidate's revision", async () => {
      const mine = await fixture({ typeCode: "H" });
      const theirs = await fixture({ typeCode: "H" });
      const theirRevision = await insertScope(theirs);
      await expect(setHead(mine.identityId, theirRevision)).rejects.toThrow(
        /scope_resolutions_revision_fk/i,
      );
    });

    it("13. an identical replay creates NO new revision", async () => {
      const f = await fixture({ typeCode: "H" });
      const id = await insertScope(f);
      await setHead(f.identityId, id);
      await expect(insertScope(f)).rejects.toThrow(/digest_uk|duplicate key/i);
      const rows = await adminQuery<{ n: string }>(
        `select count(*)::text as n from public.source_property_scope_resolution_revisions
          where source_property_identity_id = $1`,
        [f.identityId],
      );
      expect(rows[0]!.n).toBe("1");
    });
  });

  // -----------------------------------------------------------------------
  // SCOPE IS NOT ELIGIBILITY
  // -----------------------------------------------------------------------
  describe("14. the two dimensions are independent", () => {
    it("resolving scope changes no star outcome", async () => {
      const f = await fixture({ typeCode: "H", categoryCode: "3EST" });
      await adminQuery(
        `insert into public.source_property_star_resolution_revisions
           (source_property_identity_id, source, source_environment, evidence_observation_id,
            policy_provider, policy_version, policy_field, source_value, outcome, resolved_star_value)
         values ($1,$2,'evaluation',$3,'hotelbeds','hotelbeds-classification/1','categoryCode',
                 '3EST','classified_not_v1_scope',null)`,
        [f.identityId, SOURCE, f.observationId],
      );
      const before = await adminQuery<{ row: string }>(
        `select outcome || ':' || coalesce(resolved_star_value::text,'') as row
           from public.source_property_star_resolution_revisions
          where source_property_identity_id = $1`,
        [f.identityId],
      );

      // A 3-star hotel is physical hospitality. It is still not eligible, and
      // nothing about its classification moves.
      await insertScope(f);
      const after = await adminQuery<{ row: string }>(
        `select outcome || ':' || coalesce(resolved_star_value::text,'') as row
           from public.source_property_star_resolution_revisions
          where source_property_identity_id = $1`,
        [f.identityId],
      );
      expect(after).toEqual(before);
      expect(after[0]!.row).toBe("classified_not_v1_scope:");
    });

    it("a 5-star candidate with an UNRESOLVED type is a hold, not an exclusion", () => {
      // The real shape of the 20 such candidates in the Bali/Dubai evaluation.
      const r = scope([obs({ typeCode: "V", code: "5EST" })])!;
      expect(r.outcome).toBe("unresolved");
      expect(r.outcome).not.toBe("not_physical_hospitality");
    });

    it("says nothing about eligibility anywhere in its vocabulary", async () => {
      const columns = await adminQuery<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public'
            and table_name in ('source_property_scope_resolution_revisions',
                               'source_property_scope_resolutions',
                               'provider_hospitality_scope_policies',
                               'provider_hospitality_scope_policy_mappings')`,
      );
      const names = columns.map((c) => c.column_name).join(" ");
      expect(names).not.toMatch(/eligib|publish|promot|approved_for|in_scope/i);
      // …and no confidence, score or threshold either.
      expect(names).not.toMatch(/confidence|score|threshold|weight|rank/i);
    });
  });

  // -----------------------------------------------------------------------
  describe("15-16. canonical safety and security", () => {
    it("15. writes nothing canonical and moves no terminal state", async () => {
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
      const f = await fixture({ typeCode: "H" });
      const id = await insertScope(f);
      await setHead(f.identityId, id);
      expect(await snapshot()).toEqual(before);

      const state = await adminQuery<{ state: string }>(
        `select resolution_state as state from public.source_property_identities where id = $1`,
        [f.identityId],
      );
      expect(state[0]!.state).toBe("unresolved");
    });

    it("gives anon no access to any 0029 relation", async () => {
      for (const relation of [
        "provider_hospitality_scope_policies",
        "provider_hospitality_scope_policy_mappings",
        "source_property_scope_resolution_revisions",
        "source_property_scope_resolutions",
        "source_property_current_scope_resolutions",
      ]) {
        const res = await queryAs({ role: "anon", sub: null }, `select * from public.${relation}`);
        expect(res.error, `anon reached ${relation}`).not.toBeNull();
        expect(res.error?.code).toBe("42501");
      }
    });

    it("16. an ordinary creator sees zero scope-resolution rows", async () => {
      const f = await fixture({ typeCode: "H" });
      const id = await insertScope(f);
      await setHead(f.identityId, id);
      for (const relation of [
        "source_property_scope_resolution_revisions",
        "source_property_scope_resolutions",
        "source_property_current_scope_resolutions",
        "provider_hospitality_scope_policy_mappings",
      ]) {
        const res = await queryAs<{ n: string }>(
          { role: "authenticated", sub: USERS.free },
          `select count(*)::text as n from public.${relation}`,
        );
        expect(res.error, `creator errored on ${relation}`).toBeNull();
        expect(res.rows[0]!.n, `creator saw rows in ${relation}`).toBe("0");
      }
    });

    it("has RLS enabled on every 0029 table", async () => {
      const names = [
        "provider_hospitality_scope_policies",
        "provider_hospitality_scope_policy_mappings",
        "source_property_scope_resolution_revisions",
        "source_property_scope_resolutions",
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

  // -----------------------------------------------------------------------
  describe("the fold itself", () => {
    it("cites the first MAPPED observation and ignores unmapped ones", () => {
      const r = scope([obs({ id: "o1", typeCode: "V" }), obs({ id: "o2", typeCode: "H" })])!;
      expect(r.outcome).toBe("physical_hospitality");
      expect(r.evidenceObservationId).toBe("o2");
    });

    it("a later mapped observation does not displace the first", () => {
      const r = scope([obs({ id: "o1", typeCode: "H" }), obs({ id: "o2", typeCode: "L" })])!;
      expect(r.outcome).toBe("physical_hospitality");
      expect(r.evidenceObservationId).toBe("o1");
    });

    it("is deterministic", () => {
      const rows = [obs({ id: "o1", typeCode: "V" }), obs({ id: "o2", typeCode: "H" })];
      expect(scope(rows)).toEqual(scope(rows));
    });
  });
});
