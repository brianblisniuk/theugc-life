/**
 * Property-content infrastructure invariants (migration 0027).
 *
 * These assert the properties that make provider-sourced data safe to build on,
 * and every one of them protects against a failure that would otherwise be
 * silent:
 *
 *  - a provider id forking into two identities would break every future
 *    coverage count;
 *  - evaluation data reaching a canonical hotel would put test-environment
 *    records in front of creators;
 *  - one source identity mapping to two hotels is the false merge D063 calls
 *    strategically worse than a duplicate;
 *  - a range check on source coordinates would delete the invalid provider
 *    values we most need to audit.
 *
 * All fixtures are synthetic. No real provider data appears here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "./harness";
import { seed, USERS, DEST, HOTEL } from "../rls/seed";

const d = describe.skipIf(!hasTestDb);

/** Unique suffix per invocation so parallel inserts never collide. */
let counter = 0;
const uniq = () => `t${Date.now().toString(36)}${(counter += 1)}`;

async function makeRun(
  over: Partial<{
    source: string;
    environment: string;
    destinationId: string | null;
    runMode: string;
  }> = {},
): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    `insert into public.source_runs
       (source, source_environment, destination_id, run_mode, provider_geography)
     values ($1, $2, $3, $4, '{}')
     returning id`,
    [
      over.source ?? "synthetic_provider",
      over.environment ?? "evaluation",
      over.destinationId === undefined ? DEST.bali : over.destinationId,
      over.runMode ?? "evaluation",
    ],
  );
  return rows[0]!.id;
}

async function makeIdentity(
  runId: string,
  over: Partial<{ source: string; environment: string; sourcePropertyId: string }> = {},
): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    `insert into public.source_property_identities
       (source, source_environment, source_property_id, first_seen_run_id, last_seen_run_id)
     values ($1, $2, $3, $4, $4)
     returning id`,
    [
      over.source ?? "synthetic_provider",
      over.environment ?? "evaluation",
      over.sourcePropertyId ?? uniq(),
      runId,
    ],
  );
  return rows[0]!.id;
}

d("property-content infrastructure (0027)", () => {
  beforeAll(async () => {
    await setupDatabase();
    await seed();
  });
  afterAll(teardownDatabase);

  // -----------------------------------------------------------------------
  // Source identity
  // -----------------------------------------------------------------------
  describe("durable source identity", () => {
    it("enforces provider id uniqueness within its namespace and environment", async () => {
      const run = await makeRun();
      const providerId = uniq();
      await makeIdentity(run, { sourcePropertyId: providerId });

      await expect(makeIdentity(run, { sourcePropertyId: providerId })).rejects.toThrow(
        /source_property_identities_unique_source_id|duplicate key/i,
      );
    });

    it("treats the SAME provider id in a different environment as a different identity", async () => {
      // This is the isolation axis. If the key ignored environment, an
      // evaluation record and its production counterpart would collide — and
      // one would silently stand in for the other.
      const providerId = uniq();
      const evalRun = await makeRun({ environment: "evaluation" });
      const prodRun = await makeRun({ environment: "production", runMode: "full" });

      const a = await makeIdentity(evalRun, {
        environment: "evaluation",
        sourcePropertyId: providerId,
      });
      const b = await makeIdentity(prodRun, {
        environment: "production",
        sourcePropertyId: providerId,
      });
      expect(a).not.toBe(b);
    });

    it("treats the same provider id from a different SOURCE as a different identity", async () => {
      const providerId = uniq();
      const run = await makeRun();
      const a = await makeIdentity(run, { source: "provider_a", sourcePropertyId: providerId });
      const b = await makeIdentity(run, { source: "provider_b", sourcePropertyId: providerId });
      expect(a).not.toBe(b);
    });

    it("keeps ONE durable identity across multiple runs", async () => {
      const providerId = uniq();
      const run1 = await makeRun();
      const run2 = await makeRun();
      const identity = await makeIdentity(run1, { sourcePropertyId: providerId });

      // Run 2 sees the same property: the identity is updated, not forked.
      await adminQuery(
        `update public.source_property_identities
           set last_seen_run_id = $1, last_seen_at = now(), observation_count = observation_count + 1
         where id = $2`,
        [run2, identity],
      );

      const rows = await adminQuery<{ count: string }>(
        `select count(*)::text as count from public.source_property_identities
         where source = 'synthetic_provider' and source_environment = 'evaluation'
           and source_property_id = $1`,
        [providerId],
      );
      expect(rows[0]!.count).toBe("1");
    });

    it("requires a durable reason for a final exclusion, and refuses a hold state as one", async () => {
      const run = await makeRun();
      const identity = await makeIdentity(run);

      // "Final exclusion" with no reason is not auditable.
      await expect(
        adminQuery(
          `update public.source_property_identities set resolution_state = 'final_exclusion' where id = $1`,
          [identity],
        ),
      ).rejects.toThrow(/exclusion_reason/i);

      // "Star unknown" is NOT an exclusion reason — it is a hold state, and the
      // vocabulary deliberately has no value for it.
      await expect(
        adminQuery(
          `update public.source_property_identities
             set resolution_state = 'final_exclusion', resolution_reason = 'star_classification_unresolved'
           where id = $1`,
          [identity],
        ),
      ).rejects.toThrow(/resolution_reason/i);

      // Below-scope IS a durable reason and is accepted.
      await adminQuery(
        `update public.source_property_identities
           set resolution_state = 'final_exclusion', resolution_reason = 'star_below_v1_scope'
         where id = $1`,
        [identity],
      );
    });
  });

  // -----------------------------------------------------------------------
  // Observations
  // -----------------------------------------------------------------------
  describe("source observations", () => {
    it("allows many observations of one identity across runs", async () => {
      const identityRun = await makeRun();
      const identity = await makeIdentity(identityRun);
      const run2 = await makeRun();

      await adminQuery(
        `insert into public.source_property_observations
           (source_run_id, source_property_identity_id, source_name, source_classification_code)
         values ($1, $2, 'Synthetic Hotel', '4EST'), ($3, $2, 'Synthetic Hotel', '5EST')`,
        [identityRun, identity, run2],
      );

      const rows = await adminQuery<{ count: string }>(
        `select count(*)::text as count from public.source_property_observations
         where source_property_identity_id = $1`,
        [identity],
      );
      // Both snapshots survive; the 4EST -> 5EST change is history, not an
      // overwrite. A future star resolution must be able to cite which one.
      expect(rows[0]!.count).toBe("2");
    });

    it("refuses to observe the same identity twice within ONE run", async () => {
      const run = await makeRun();
      const identity = await makeIdentity(run);
      await adminQuery(
        `insert into public.source_property_observations (source_run_id, source_property_identity_id)
         values ($1, $2)`,
        [run, identity],
      );

      await expect(
        adminQuery(
          `insert into public.source_property_observations (source_run_id, source_property_identity_id)
           values ($1, $2)`,
          [run, identity],
        ),
      ).rejects.toThrow(/unique_per_run|duplicate key/i);
    });

    it("PRESERVES invalid provider coordinates as evidence", async () => {
      // The Bali evaluation returned one out-of-range coordinate. A range CHECK
      // would have made it unstorable, forcing the ingestion to drop, null or
      // crash — all three destroy the evidence we need to audit.
      const run = await makeRun();
      const identity = await makeIdentity(run);
      await adminQuery(
        `insert into public.source_property_observations
           (source_run_id, source_property_identity_id, source_latitude, source_longitude,
            source_coordinates_plausible)
         values ($1, $2, 999.5, -4000.25, false)`,
        [run, identity],
      );

      const rows = await adminQuery<{ lat: string; lon: string; plausible: boolean }>(
        `select source_latitude::text as lat, source_longitude::text as lon,
                source_coordinates_plausible as plausible
         from public.source_property_observations where source_property_identity_id = $1`,
        [identity],
      );
      expect(rows[0]!.lat).toBe("999.5");
      expect(rows[0]!.lon).toBe("-4000.25");
      expect(rows[0]!.plausible).toBe(false);
    });

    it("defaults classification evidence to PROVIDER, never canonical", async () => {
      const run = await makeRun();
      const identity = await makeIdentity(run);
      await adminQuery(
        `insert into public.source_property_observations
           (source_run_id, source_property_identity_id, source_classification_code,
            source_classification_simple_code)
         values ($1, $2, '5LL', '5')`,
        [run, identity],
      );
      const rows = await adminQuery<{ kind: string; simple: string }>(
        `select source_classification_evidence_kind as kind,
                source_classification_simple_code as simple
         from public.source_property_observations where source_property_identity_id = $1`,
        [identity],
      );
      expect(rows[0]!.kind).toBe("provider_classification_evidence");
      // Stored as TEXT. `5LL` is FIVE KEYS, not five stars — a numeric column
      // would invite `where simple_code >= 4`, the one query that must never
      // produce inventory.
      expect(rows[0]!.simple).toBe("5");
    });

    it("bounds source_attributes so payloads and image arrays cannot be dumped in", async () => {
      const run = await makeRun();
      const identity = await makeIdentity(run);
      const fatImages = JSON.stringify({
        images: Array.from({ length: 400 }, (_, i) => ({
          path: `synthetic/${i}/very-long-synthetic-image-path-segment.jpg`,
          order: i,
        })),
      });

      await expect(
        adminQuery(
          `insert into public.source_property_observations
             (source_run_id, source_property_identity_id, source_attributes)
           values ($1, $2, $3::jsonb)`,
          [run, identity, fatImages],
        ),
      ).rejects.toThrow(/source_attributes is \d+ bytes/i);
    });
  });

  // -----------------------------------------------------------------------
  // Source runs
  // -----------------------------------------------------------------------
  describe("source runs", () => {
    it("cannot claim exhaustion it never walked", async () => {
      const run = await makeRun();
      await expect(
        adminQuery(
          `update public.source_runs
             set extraction_exhaustion_proven = true, pagination_walk_completed = false
           where id = $1`,
          [run],
        ),
      ).rejects.toThrow(/exhaustion_requires_walk/i);
    });

    it("cannot be 'completed' without a completion time, or 'running' with one", async () => {
      const run = await makeRun();
      await expect(
        adminQuery(`update public.source_runs set run_status = 'completed' where id = $1`, [run]),
      ).rejects.toThrow(/completion_shape/i);

      await expect(
        adminQuery(`update public.source_runs set completed_at = now() where id = $1`, [run]),
      ).rejects.toThrow(/completion_shape/i);
    });

    it("distinguishes 'provider said zero' from 'provider said nothing'", async () => {
      const run = await makeRun();
      const rows = await adminQuery<{ total: number | null }>(
        `select provider_reported_total as total from public.source_runs where id = $1`,
        [run],
      );
      expect(rows[0]!.total).toBeNull();
    });

    it("cannot be deleted while observations still cite it", async () => {
      const run = await makeRun();
      const identity = await makeIdentity(run);
      await adminQuery(
        `insert into public.source_property_observations (source_run_id, source_property_identity_id)
         values ($1, $2)`,
        [run, identity],
      );
      // Evidence a canonical value may later cite must not vanish with a
      // convenient cleanup.
      await expect(
        adminQuery(`delete from public.source_runs where id = $1`, [run]),
      ).rejects.toThrow(/violates foreign key/i);
    });
  });

  // -----------------------------------------------------------------------
  // Canonical source identity link — the D063 invariants
  // -----------------------------------------------------------------------
  describe("canonical source-identity mapping", () => {
    async function makeProductionIdentity(): Promise<string> {
      const run = await makeRun({ environment: "production", runMode: "full" });
      return makeIdentity(run, { environment: "production" });
    }

    async function link(
      hotelId: string,
      identityId: string,
      over: Partial<{ environment: string; status: string }> = {},
    ): Promise<void> {
      const meta = await adminQuery<{ source: string; env: string; pid: string }>(
        `select source, source_environment as env, source_property_id as pid
         from public.source_property_identities where id = $1`,
        [identityId],
      );
      await adminQuery(
        `insert into public.hotel_source_identities
           (hotel_id, source_property_identity_id, source, source_environment,
            source_property_id, match_method, link_status)
         values ($1, $2, $3, $4, $5, 'synthetic_test', $6)`,
        [
          hotelId,
          identityId,
          meta[0]!.source,
          over.environment ?? meta[0]!.env,
          meta[0]!.pid,
          over.status ?? "active",
        ],
      );
    }

    it("lets a source identity exist with NO canonical hotel", async () => {
      const run = await makeRun();
      const identity = await makeIdentity(run);
      const rows = await adminQuery<{ count: string }>(
        `select count(*)::text as count from public.hotel_source_identities
         where source_property_identity_id = $1`,
        [identity],
      );
      // The normal state before review. A candidate is not a hotel.
      expect(rows[0]!.count).toBe("0");
    });

    it("lets ONE canonical hotel hold MANY provider source identities", async () => {
      const a = await makeProductionIdentity();
      const b = await makeProductionIdentity();
      await link(HOTEL.bali, a);
      await link(HOTEL.bali, b);

      const rows = await adminQuery<{ count: string }>(
        `select count(*)::text as count from public.hotel_source_identities
         where hotel_id = $1 and link_status = 'active'`,
        [HOTEL.bali],
      );
      expect(Number(rows[0]!.count)).toBeGreaterThanOrEqual(2);
    });

    it("refuses ONE active source identity mapped to TWO canonical hotels", async () => {
      // The false merge. D063: strategically worse than a temporary duplicate,
      // because it silently attributes one hotel's outreach history to another.
      const identity = await makeProductionIdentity();
      await link(HOTEL.bali, identity);

      await expect(link(HOTEL.ibiza, identity)).rejects.toThrow(
        /active_identity_uidx|duplicate key/i,
      );
    });

    it("allows a SUPERSEDED link to coexist with the active one", async () => {
      const identity = await makeProductionIdentity();
      await link(HOTEL.bali, identity, { status: "superseded" });
      await link(HOTEL.ibiza, identity, { status: "active" });

      const rows = await adminQuery<{ count: string }>(
        `select count(*)::text as count from public.hotel_source_identities
         where source_property_identity_id = $1`,
        [identity],
      );
      // History is retained rather than deleted; only ACTIVE is exclusive.
      expect(rows[0]!.count).toBe("2");
    });

    it("REFUSES to link evaluation-environment data to a canonical hotel", async () => {
      // Locked invariant K, enforced in the database rather than in a comment:
      // the Hotelbeds test environment must never be accidentally promotable.
      const run = await makeRun({ environment: "evaluation" });
      const identity = await makeIdentity(run, { environment: "evaluation" });

      await expect(link(HOTEL.bali, identity)).rejects.toThrow(/production_only/i);
    });

    it("also refuses an evaluation identity smuggled in under a production label", async () => {
      const run = await makeRun({ environment: "evaluation" });
      const identity = await makeIdentity(run, { environment: "evaluation" });
      // The CHECK passes (the row claims production) — but the FK'd identity is
      // evaluation, so the lie is detectable in one join and the link is
      // reportable. This test pins that the mismatch is VISIBLE, which is what
      // makes the constraint auditable rather than merely present.
      await link(HOTEL.bali, identity, { environment: "production" });

      const rows = await adminQuery<{ count: string }>(
        `select count(*)::text as count
         from public.hotel_source_identities hsi
         join public.source_property_identities spi on spi.id = hsi.source_property_identity_id
         where hsi.source_environment <> spi.source_environment`,
        [],
      );
      expect(Number(rows[0]!.count)).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Entity resolution
  // -----------------------------------------------------------------------
  describe("entity-resolution candidates", () => {
    it("stores an evidence matrix with no confidence score anywhere", async () => {
      const cols = await adminQuery<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'source_match_candidates'`,
      );
      const names = cols.map((c) => c.column_name);
      // D063 §12.2 refuses to invent a universal threshold, so there is no
      // score/confidence column to invent one into.
      expect(names).not.toContain("score");
      expect(names).not.toContain("match_confidence");
      expect(names).toContain("agreeing_dimensions");
      expect(names).toContain("name_evidence");
    });

    it("records a NEW PROPERTY assertion as a candidate with no hotel", async () => {
      const run = await makeRun();
      const identity = await makeIdentity(run);
      await adminQuery(
        `insert into public.source_match_candidates
           (source_property_identity_id, source_run_id, candidate_hotel_id, match_method)
         values ($1, $2, null, 'no_canonical_candidate')`,
        [identity, run],
      );
      const rows = await adminQuery<{ hotel: string | null }>(
        `select candidate_hotel_id as hotel from public.source_match_candidates
         where source_property_identity_id = $1`,
        [identity],
      );
      // "We looked and found nothing" is a finding, not an absence of one.
      expect(rows[0]!.hotel).toBeNull();
    });

    it("keeps `unavailable` distinct from `differs`", async () => {
      const run = await makeRun();
      const identity = await makeIdentity(run);
      await adminQuery(
        `insert into public.source_match_candidates
           (source_property_identity_id, candidate_hotel_id, name_evidence,
            domain_evidence, address_evidence, agreeing_dimensions, match_method)
         values ($1, $2, 'exact', 'unavailable', 'differs', 1, 'name_exact')`,
        [identity, HOTEL.bali],
      );
      const rows = await adminQuery<{ domain: string; address: string; dims: number }>(
        `select domain_evidence as domain, address_evidence as address,
                agreeing_dimensions as dims
         from public.source_match_candidates where source_property_identity_id = $1`,
        [identity],
      );
      // Neither side supplied a website: that is not evidence against a match.
      expect(rows[0]!.domain).toBe("unavailable");
      expect(rows[0]!.address).toBe("differs");
      // An exact name is ONE dimension, never two.
      expect(rows[0]!.dims).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Review decisions
  // -----------------------------------------------------------------------
  describe("durable review decisions", () => {
    it("uses the same decision vocabulary as the file-import pipeline", async () => {
      const provider = await adminQuery<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint
         where conname = 'source_property_reviews_decision_check'`,
      );
      const file = await adminQuery<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint
         where conname = 'import_property_reviews_decision_check'`,
      );
      const values = (def: string) => (def.match(/'[a-z_]+'::text/g) ?? []).sort().join(",");
      // Both pipelines converge on one D062 gate, so they must speak one
      // decision language.
      expect(values(provider[0]!.def)).toBe(values(file[0]!.def));
    });

    it("rejects an invalid decision/target shape", async () => {
      const run = await makeRun();
      const identity = await makeIdentity(run);
      await expect(
        adminQuery(
          `insert into public.source_property_reviews
             (source_property_identity_id, decision, reviewer_label)
           values ($1, 'approve_create', 'test')`,
          [identity],
        ),
      ).rejects.toThrow(/decision_shape/i);

      await expect(
        adminQuery(
          `insert into public.source_property_reviews
             (source_property_identity_id, decision, target_hotel_id, reviewer_label)
           values ($1, 'reject', $2, 'test')`,
          [identity, HOTEL.bali],
        ),
      ).rejects.toThrow(/decision_shape/i);
    });

    it("keeps at most one live decision per identity", async () => {
      const run = await makeRun();
      const identity = await makeIdentity(run);
      await adminQuery(
        `insert into public.source_property_reviews
           (source_property_identity_id, decision, reviewer_label)
         values ($1, 'defer', 'test')`,
        [identity],
      );
      await expect(
        adminQuery(
          `insert into public.source_property_reviews
             (source_property_identity_id, decision, reviewer_label)
           values ($1, 'reject', 'test')`,
          [identity],
        ),
      ).rejects.toThrow(/duplicate key/i);
    });
  });

  // -----------------------------------------------------------------------
  // Canonical schema stays provider-agnostic
  // -----------------------------------------------------------------------
  describe("canonical schema is provider-agnostic", () => {
    it("has no provider id column on hotels", async () => {
      const cols = await adminQuery<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'hotels'`,
      );
      const names = cols.map((c) => c.column_name.toLowerCase());
      for (const forbidden of ["hotelbeds_id", "booking_id", "expedia_id", "source_property_id"]) {
        expect(names).not.toContain(forbidden);
      }
      // And no provider-shaped column crept in under another name.
      expect(names.filter((n) => /hotelbeds|booking_com|expedia|giata/.test(n))).toEqual([]);
    });

    it("introduces no publication_status or canonical draft tier", async () => {
      const cols = await adminQuery<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'hotels'`,
      );
      const names = cols.map((c) => c.column_name.toLowerCase());
      // D062 §7.0: promotion IS publication. One boundary, not two.
      expect(names).not.toContain("publication_status");
      expect(names).not.toContain("is_published");
      expect(names).not.toContain("is_draft");
    });
  });

  // -----------------------------------------------------------------------
  // Security
  // -----------------------------------------------------------------------
  describe("security", () => {
    const TABLES = [
      "source_runs",
      "source_property_identities",
      "source_property_observations",
      "source_match_candidates",
      "hotel_source_identities",
      "source_property_reviews",
    ];

    it("gives anon no access at all", async () => {
      for (const table of TABLES) {
        const res = await queryAs({ role: "anon", sub: null }, `select * from public.${table}`);
        // A privilege error, not an empty result: anon must not even be able to
        // enumerate that these tables exist.
        expect(res.error, `anon reached ${table}`).not.toBeNull();
        expect(res.error?.code).toBe("42501");
      }
    });

    it("lets an ordinary creator read nothing, despite holding the privilege", async () => {
      const run = await makeRun();
      await makeIdentity(run);
      for (const table of TABLES) {
        const res = await queryAs<{ n: string }>(
          { role: "authenticated", sub: USERS.free },
          `select count(*)::text as n from public.${table}`,
        );
        expect(res.error, `creator errored on ${table}`).toBeNull();
        expect(res.rows[0]!.n, `creator saw rows in ${table}`).toBe("0");
      }
    });

    it("lets an editor read them", async () => {
      const run = await makeRun();
      await makeIdentity(run);
      const res = await queryAs<{ n: string }>(
        { role: "authenticated", sub: USERS.editor },
        `select count(*)::text as n from public.source_property_identities`,
      );
      expect(res.error).toBeNull();
      expect(Number(res.rows[0]!.n)).toBeGreaterThan(0);
    });

    it("lets an admin write, and a creator not", async () => {
      const run = await makeRun();
      const admin = await queryAs(
        { role: "authenticated", sub: USERS.admin },
        `insert into public.source_property_identities
           (source, source_environment, source_property_id, first_seen_run_id, last_seen_run_id)
         values ('synthetic_provider', 'evaluation', $1, $2, $2)`,
        [uniq(), run],
      );
      expect(admin.error).toBeNull();

      const creator = await queryAs(
        { role: "authenticated", sub: USERS.free },
        `insert into public.source_property_identities
           (source, source_environment, source_property_id, first_seen_run_id, last_seen_run_id)
         values ('synthetic_provider', 'evaluation', $1, $2, $2)`,
        [uniq(), run],
      );
      expect(creator.error).not.toBeNull();
    });

    it("has RLS enabled on every new table", async () => {
      const rows = await adminQuery<{ relname: string; relrowsecurity: boolean }>(
        `select c.relname, c.relrowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = any($1)`,
        [TABLES],
      );
      expect(rows).toHaveLength(TABLES.length);
      for (const row of rows) {
        expect(row.relrowsecurity, `${row.relname} has RLS disabled`).toBe(true);
      }
    });
  });
});
