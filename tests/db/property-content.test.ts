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
 *    records in front of creators — and a denormalised label the writer chooses
 *    is not a defence, so the tests below require the INSERT to fail rather
 *    than the lie to be detectable afterwards;
 *  - a run, an identity and an observation that disagree about which provider
 *    and which environment they belong to destroy provenance while every
 *    individual row still exists;
 *  - an observation that can be edited or deleted is not evidence a future
 *    canonical star may cite;
 *  - one source identity mapping to two hotels is the false merge D063 calls
 *    strategically worse than a duplicate;
 *  - a range check on source coordinates would delete the invalid provider
 *    values we most need to audit.
 *
 * All fixtures are synthetic. No real provider data appears here.
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "./harness";
import { seed, USERS, DEST, HOTEL } from "../rls/seed";

const d = describe.skipIf(!hasTestDb);

/** Unique suffix per invocation so parallel inserts never collide. */
let counter = 0;
const uniq = () => `t${Date.now().toString(36)}${(counter += 1)}`;

const DEFAULT_SOURCE = "synthetic_provider";

async function makeRun(
  over: Partial<{
    source: string;
    environment: string;
    destinationId: string | null;
    runMode: string;
  }> = {},
): Promise<string> {
  const environment = over.environment ?? "evaluation";
  const rows = await adminQuery<{ id: string }>(
    `insert into public.source_runs
       (source, source_environment, destination_id, run_mode, provider_geography)
     values ($1, $2, $3, $4, '{}')
     returning id`,
    [
      over.source ?? DEFAULT_SOURCE,
      environment,
      over.destinationId === undefined ? DEST.bali : over.destinationId,
      over.runMode ?? (environment === "production" ? "full" : "evaluation"),
    ],
  );
  return rows[0]!.id;
}

/**
 * An identity's runs must be runs of the SAME source and environment (composite
 * FK), so by default the helper provisions a matching one. Tests that want a
 * mismatch pass `firstRunId` / `lastRunId` explicitly.
 */
async function makeIdentity(
  over: Partial<{
    source: string;
    environment: string;
    sourcePropertyId: string;
    firstRunId: string;
    lastRunId: string;
  }> = {},
): Promise<string> {
  const source = over.source ?? DEFAULT_SOURCE;
  const environment = over.environment ?? "evaluation";
  const firstRunId = over.firstRunId ?? (await makeRun({ source, environment }));
  const rows = await adminQuery<{ id: string }>(
    `insert into public.source_property_identities
       (source, source_environment, source_property_id, first_seen_run_id, last_seen_run_id)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [
      source,
      environment,
      over.sourcePropertyId ?? uniq(),
      firstRunId,
      over.lastRunId ?? firstRunId,
    ],
  );
  return rows[0]!.id;
}

/** An identity plus the run that first saw it, for tests that need both. */
async function makeIdentityWithRun(
  over: Partial<{ source: string; environment: string; sourcePropertyId: string }> = {},
): Promise<{ identity: string; run: string }> {
  const source = over.source ?? DEFAULT_SOURCE;
  const environment = over.environment ?? "evaluation";
  const run = await makeRun({ source, environment });
  const identity = await makeIdentity({ ...over, source, environment, firstRunId: run });
  return { identity, run };
}

/**
 * Insert an observation. `source` / `source_environment` default to the
 * identity's own values — the aligned case. Tests that probe the alignment
 * constraints override them deliberately.
 */
async function observe(
  runId: string,
  identityId: string,
  opts: {
    source?: string;
    environment?: string;
    columns?: Record<string, unknown>;
  } = {},
): Promise<void> {
  let { source, environment } = opts;
  if (source === undefined || environment === undefined) {
    const meta = await adminQuery<{ source: string; env: string }>(
      `select source, source_environment as env
       from public.source_property_identities where id = $1`,
      [identityId],
    );
    source ??= meta[0]!.source;
    environment ??= meta[0]!.env;
  }
  const row: Record<string, unknown> = {
    source_run_id: runId,
    source_property_identity_id: identityId,
    source,
    source_environment: environment,
    ...(opts.columns ?? {}),
  };
  const names = Object.keys(row);
  await adminQuery(
    `insert into public.source_property_observations (${names.join(", ")})
     values (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
    names.map((n) => row[n]),
  );
}

async function identityMeta(
  identityId: string,
): Promise<{ source: string; env: string; pid: string }> {
  const rows = await adminQuery<{ source: string; env: string; pid: string }>(
    `select source, source_environment as env, source_property_id as pid
     from public.source_property_identities where id = $1`,
    [identityId],
  );
  return rows[0]!;
}

const makeProductionIdentity = () => makeIdentity({ environment: "production" });

/** Establish the D063 canonical link. Labels default to the identity's own. */
async function link(
  hotelId: string,
  identityId: string,
  over: Partial<{
    source: string;
    environment: string;
    sourcePropertyId: string;
    status: string;
  }> = {},
): Promise<void> {
  const meta = await identityMeta(identityId);
  await adminQuery(
    `insert into public.hotel_source_identities
       (hotel_id, source_property_identity_id, source, source_environment,
        source_property_id, match_method, link_status)
     values ($1, $2, $3, $4, $5, 'synthetic_test', $6)`,
    [
      hotelId,
      identityId,
      over.source ?? meta.source,
      over.environment ?? meta.env,
      over.sourcePropertyId ?? meta.pid,
      over.status ?? "active",
    ],
  );
}

/**
 * Link and promote an identity INSIDE one transaction, hand the open transaction
 * to `work`, and always roll back.
 *
 * `resolved_eligible` used to be commit-able on 0027's rules alone. A05's
 * migration 0034 added the other half of that invariant — a promoted identity
 * must also carry an immutable publication receipt naming the human who
 * authorized it — and that check is a DEFERRED constraint trigger, so it speaks
 * at COMMIT, not per statement. Autocommit statements therefore cannot express
 * "0027 accepts this"; a transaction can, and the tests below say explicitly
 * which layer is answering.
 */
async function withPromoted(
  identityId: string,
  hotelId: string,
  work: (q: Client["query"]) => Promise<void>,
): Promise<void> {
  const meta = await identityMeta(identityId);
  const c = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  const q = c.query.bind(c) as Client["query"];
  try {
    await q("begin");
    await q(
      `insert into public.hotel_source_identities
         (hotel_id, source_property_identity_id, source, source_environment,
          source_property_id, match_method, link_status)
       values ($1, $2, $3, $4, $5, 'synthetic_test', 'active')`,
      [hotelId, identityId, meta.source, meta.env, meta.pid],
    );
    await q(
      `update public.source_property_identities
         set resolution_state = 'resolved_eligible', promoted_hotel_id = $2
       where id = $1`,
      [identityId, hotelId],
    );
    await work(q);
  } finally {
    await q("rollback").catch(() => undefined);
    await c.end();
  }
}

/** A match candidate. `source`/`source_environment` default to the identity's. */
async function makeCandidate(
  identityIdInput: string,
  opts: {
    runId?: string;
    source?: string;
    environment?: string;
    columns?: Record<string, unknown>;
  } = {},
): Promise<void> {
  let identityId = identityIdInput;
  let columns = opts.columns ?? {};
  // 0030 requires ONE canonical orientation for a source-to-source pair, so the
  // same pair cannot be recorded as two candidates. Fixtures state the pair; the
  // helper puts it in the legal order — BEFORE reading the identity's own
  // source/environment, which the composite FK requires to belong to whichever
  // side ends up on the left.
  const target = columns.candidate_source_property_identity_id as string | undefined;
  if (columns.candidate_kind === "source_identity" && target && target < identityId) {
    columns = { ...columns, candidate_source_property_identity_id: identityId };
    identityId = target;
  }
  const meta = await identityMeta(identityId);
  // `candidate_kind` DEFAULTS to `new_property`, and 0030 requires such a row to
  // carry the finding behind it. Fixtures that do not care about the kind get a
  // note so the constraint under test is the one they meant to test.
  const impliedKind = (columns.candidate_kind as string | undefined) ?? "new_property";
  const row: Record<string, unknown> = {
    source_property_identity_id: identityId,
    source: opts.source ?? meta.source,
    source_environment: opts.environment ?? meta.env,
    match_method: "synthetic_test",
    ...(impliedKind === "new_property" ? { review_note: "synthetic explicit finding" } : {}),
    ...(opts.runId !== undefined ? { source_run_id: opts.runId } : {}),
    ...columns,
  };
  const names = Object.keys(row);
  await adminQuery(
    `insert into public.source_match_candidates (${names.join(", ")})
     values (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
    names.map((n) => row[n]),
  );
}

/** A durable review decision, with the same provenance defaults. */
async function makeReview(
  identityId: string,
  opts: {
    runId?: string;
    source?: string;
    environment?: string;
    columns?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const meta = await identityMeta(identityId);
  const row: Record<string, unknown> = {
    source_property_identity_id: identityId,
    source: opts.source ?? meta.source,
    source_environment: opts.environment ?? meta.env,
    decision: "defer",
    reviewer_label: "test",
    ...(opts.runId !== undefined ? { decided_in_run_id: opts.runId } : {}),
    ...(opts.columns ?? {}),
  };
  const names = Object.keys(row);
  await adminQuery(
    `insert into public.source_property_reviews (${names.join(", ")})
     values (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
    names.map((n) => row[n]),
  );
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
      const providerId = uniq();
      const run = await makeRun();
      await makeIdentity({ sourcePropertyId: providerId, firstRunId: run });

      await expect(makeIdentity({ sourcePropertyId: providerId, firstRunId: run })).rejects.toThrow(
        /source_property_identities_unique_source_id|duplicate key/i,
      );
    });

    it("treats the SAME provider id in a different environment as a different identity", async () => {
      // This is the isolation axis. If the key ignored environment, an
      // evaluation record and its production counterpart would collide — and
      // one would silently stand in for the other.
      const providerId = uniq();
      const a = await makeIdentity({ environment: "evaluation", sourcePropertyId: providerId });
      const b = await makeIdentity({ environment: "production", sourcePropertyId: providerId });
      expect(a).not.toBe(b);
    });

    it("treats the same provider id from a different SOURCE as a different identity", async () => {
      const providerId = uniq();
      const a = await makeIdentity({ source: "provider_a", sourcePropertyId: providerId });
      const b = await makeIdentity({ source: "provider_b", sourcePropertyId: providerId });
      expect(a).not.toBe(b);
    });

    it("keeps ONE durable identity across multiple runs", async () => {
      const providerId = uniq();
      const run1 = await makeRun();
      const run2 = await makeRun();
      const identity = await makeIdentity({ sourcePropertyId: providerId, firstRunId: run1 });

      // Run 2 sees the same property: the identity is updated, not forked.
      await adminQuery(
        `update public.source_property_identities
           set last_seen_run_id = $1, last_seen_at = now(), observation_count = observation_count + 1
         where id = $2`,
        [run2, identity],
      );

      const rows = await adminQuery<{ count: string }>(
        `select count(*)::text as count from public.source_property_identities
         where source = $1 and source_environment = 'evaluation' and source_property_id = $2`,
        [DEFAULT_SOURCE, providerId],
      );
      expect(rows[0]!.count).toBe("1");
    });

    it("requires a durable reason for a final exclusion, and refuses a hold state as one", async () => {
      const identity = await makeIdentity();

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
  // Run <-> identity provenance alignment (§2)
  // -----------------------------------------------------------------------
  describe("run/identity provenance alignment", () => {
    it("refuses an identity whose first_seen_run belongs to a DIFFERENT source", async () => {
      // Both rows exist, so plain id-only FKs would both pass and the identity
      // would claim it was discovered by a run of another provider entirely.
      const foreignRun = await makeRun({ source: "provider_b" });
      await expect(makeIdentity({ source: "provider_a", firstRunId: foreignRun })).rejects.toThrow(
        /source_property_identities_first_run_fk/i,
      );
    });

    it("refuses an identity whose first_seen_run belongs to a DIFFERENT environment", async () => {
      const evaluationRun = await makeRun({ environment: "evaluation" });
      await expect(
        makeIdentity({ environment: "production", firstRunId: evaluationRun }),
      ).rejects.toThrow(/source_property_identities_first_run_fk/i);
    });

    it("refuses a last_seen_run from a different source or environment", async () => {
      const identity = await makeIdentity({ source: "provider_a", environment: "evaluation" });
      const otherSourceRun = await makeRun({ source: "provider_b", environment: "evaluation" });
      const otherEnvRun = await makeRun({ source: "provider_a", environment: "production" });

      await expect(
        adminQuery(
          `update public.source_property_identities set last_seen_run_id = $1 where id = $2`,
          [otherSourceRun, identity],
        ),
      ).rejects.toThrow(/source_property_identities_last_run_fk/i);

      await expect(
        adminQuery(
          `update public.source_property_identities set last_seen_run_id = $1 where id = $2`,
          [otherEnvRun, identity],
        ),
      ).rejects.toThrow(/source_property_identities_last_run_fk/i);
    });

    it("accepts an aligned later run as last_seen_run", async () => {
      const identity = await makeIdentity({ source: "provider_a", environment: "production" });
      const alignedRun = await makeRun({ source: "provider_a", environment: "production" });
      await adminQuery(
        `update public.source_property_identities set last_seen_run_id = $1 where id = $2`,
        [alignedRun, identity],
      );
      const rows = await adminQuery<{ last: string }>(
        `select last_seen_run_id as last from public.source_property_identities where id = $1`,
        [identity],
      );
      expect(rows[0]!.last).toBe(alignedRun);
    });
  });

  // -----------------------------------------------------------------------
  // Observations
  // -----------------------------------------------------------------------
  describe("source observations", () => {
    it("allows many observations of one identity across runs", async () => {
      const { identity, run } = await makeIdentityWithRun();
      const run2 = await makeRun();

      await observe(run, identity, {
        columns: { source_name: "Synthetic Hotel", source_classification_code: "4EST" },
      });
      await observe(run2, identity, {
        columns: { source_name: "Synthetic Hotel", source_classification_code: "5EST" },
      });

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
      const { identity, run } = await makeIdentityWithRun();
      await observe(run, identity);

      await expect(observe(run, identity)).rejects.toThrow(/unique_per_run|duplicate key/i);
    });

    it("refuses an observation whose run and identity disagree about the SOURCE", async () => {
      const runA = await makeRun({ source: "provider_a" });
      const identityB = await makeIdentity({ source: "provider_b" });

      // Label it as the run's source: the identity FK rejects it.
      await expect(observe(runA, identityB, { source: "provider_a" })).rejects.toThrow(
        /source_property_observations_identity_fk/i,
      );
      // Label it as the identity's source: the run FK rejects it.
      await expect(observe(runA, identityB, { source: "provider_b" })).rejects.toThrow(
        /source_property_observations_run_fk/i,
      );
    });

    it("refuses an observation whose run and identity disagree about the ENVIRONMENT", async () => {
      // A production run must not be able to carry evidence about an
      // evaluation property: the environment of the evidence would be lost
      // while both rows still exist.
      const productionRun = await makeRun({ environment: "production" });
      const evaluationIdentity = await makeIdentity({ environment: "evaluation" });

      await expect(
        observe(productionRun, evaluationIdentity, { environment: "production" }),
      ).rejects.toThrow(/source_property_observations_identity_fk/i);
      await expect(
        observe(productionRun, evaluationIdentity, { environment: "evaluation" }),
      ).rejects.toThrow(/source_property_observations_run_fk/i);
    });

    it("PRESERVES invalid provider coordinates as evidence", async () => {
      // The Bali evaluation returned one out-of-range coordinate. A range CHECK
      // would have made it unstorable, forcing the ingestion to drop, null or
      // crash — all three destroy the evidence we need to audit.
      const { identity, run } = await makeIdentityWithRun();
      await observe(run, identity, {
        columns: {
          source_latitude: 999.5,
          source_longitude: -4000.25,
          source_coordinates_plausible: false,
        },
      });

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
      const { identity, run } = await makeIdentityWithRun();
      await observe(run, identity, {
        columns: {
          source_classification_code: "5LL",
          source_classification_simple_code: "5",
        },
      });
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

    it("REFUSES an arbitrary source observation labelling itself CANONICAL star evidence", async () => {
      // D060. No issuing-authority hierarchy exists yet and no registry says
      // which source may speak canonically, so an ingestion script must not be
      // able to promote its own provider to star authority.
      const { identity, run } = await makeIdentityWithRun();
      await expect(
        observe(run, identity, {
          columns: {
            source_classification_code: "5EST",
            source_classification_evidence_kind: "canonical_classification_evidence",
          },
        }),
      ).rejects.toThrow(/violates check constraint/i);

      // And there is no other spelling of the same escalation available: the
      // CHECK admits exactly one value, and it is not a canonical one.
      const def = await adminQuery<{ def: string }>(
        `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         where t.relname = 'source_property_observations'
           and c.contype = 'c'
           and pg_get_constraintdef(c.oid) ilike '%source_classification_evidence_kind%'`,
      );
      expect(def).toHaveLength(1);
      expect(def[0]!.def).toMatch(/'provider_classification_evidence'/);
      expect(def[0]!.def).not.toMatch(/canonical/i);
    });

    it("bounds source_attributes so payloads and image arrays cannot be dumped in", async () => {
      const { identity, run } = await makeIdentityWithRun();
      const fatImages = JSON.stringify({
        images: Array.from({ length: 400 }, (_, i) => ({
          path: `synthetic/${i}/very-long-synthetic-image-path-segment.jpg`,
          order: i,
        })),
      });

      await expect(
        observe(run, identity, { columns: { source_attributes: fatImages } }),
      ).rejects.toThrow(/source_attributes is \d+ bytes/i);
    });
  });

  // -----------------------------------------------------------------------
  // Append-only observations (§3)
  // -----------------------------------------------------------------------
  describe("observations are append-only", () => {
    it("refuses an UPDATE even from the table owner", async () => {
      // A future canonical star will cite an observation id as its provenance.
      // If the cited row can be edited, that provenance is a promise the
      // database does not keep — so the trigger refuses the owner too, not
      // merely the client roles.
      const { identity, run } = await makeIdentityWithRun();
      await observe(run, identity, { columns: { source_name: "Synthetic Hotel" } });

      await expect(
        adminQuery(
          `update public.source_property_observations set source_name = 'Rewritten'
           where source_property_identity_id = $1`,
          [identity],
        ),
      ).rejects.toThrow(/APPEND-ONLY/i);
    });

    it("refuses a DELETE even from the table owner", async () => {
      const { identity, run } = await makeIdentityWithRun();
      await observe(run, identity);

      await expect(
        adminQuery(
          `delete from public.source_property_observations where source_property_identity_id = $1`,
          [identity],
        ),
      ).rejects.toThrow(/APPEND-ONLY/i);
    });

    it("withholds UPDATE and DELETE privileges from every client role", async () => {
      const { identity, run } = await makeIdentityWithRun();
      await observe(run, identity);

      for (const role of ["authenticated", "service_role"] as const) {
        const sub = role === "authenticated" ? USERS.admin : null;
        const upd = await queryAs(
          { role, sub },
          `update public.source_property_observations set source_name = 'Rewritten' where source_property_identity_id = $1`,
          [identity],
        );
        // The privilege layer stops it first; the trigger above is the backstop
        // that survives a future over-broad grant.
        expect(upd.error, `${role} could update observations`).not.toBeNull();
        expect(upd.error?.code).toBe("42501");

        const del = await queryAs(
          { role, sub },
          `delete from public.source_property_observations where source_property_identity_id = $1`,
          [identity],
        );
        expect(del.error, `${role} could delete observations`).not.toBeNull();
        expect(del.error?.code).toBe("42501");
      }
    });

    it("still lets an authorized editorial actor INSERT and SELECT", async () => {
      const { identity, run } = await makeIdentityWithRun();
      const res = await queryAs(
        { role: "authenticated", sub: USERS.admin },
        `insert into public.source_property_observations
           (source_run_id, source_property_identity_id, source, source_environment, source_name)
         values ($1, $2, $3, 'evaluation', 'Synthetic Hotel')`,
        [run, identity, DEFAULT_SOURCE],
      );
      expect(res.error).toBeNull();

      const read = await queryAs(
        { role: "authenticated", sub: USERS.editor },
        `select count(*)::text as n from public.source_property_observations`,
      );
      expect(read.error).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Source runs
  // -----------------------------------------------------------------------
  describe("source runs", () => {
    it("cannot claim enumeration exhaustion it never walked", async () => {
      const run = await makeRun();
      await expect(
        adminQuery(
          `update public.source_runs
             set provider_enumeration_exhaustion_proven = true, pagination_walk_completed = false
           where id = $1`,
          [run],
        ),
      ).rejects.toThrow(/exhaustion_requires_walk/i);
    });

    it("cannot claim enumeration exhaustion while an ENUMERATION risk stands", async () => {
      const run = await makeRun();
      await expect(
        adminQuery(
          `update public.source_runs
             set pagination_walk_completed = true,
                 enumeration_risks = array['cursor_loop_detected'],
                 provider_enumeration_exhaustion_proven = true
           where id = $1`,
          [run],
        ),
      ).rejects.toThrow(/exhaustion_requires_walk/i);
    });

    it("lets a COMPLETED walk stay exhausted while non-enumeration coverage risks are open", async () => {
      // PR #21's finding: "did we read every record the provider offers?" and
      // "is this destination's coverage settled?" are different dimensions.
      // An unresolved star authority must not falsify a walk that genuinely
      // completed, or a correct enumeration reports itself as a failure.
      const run = await makeRun();
      await adminQuery(
        `update public.source_runs
           set pagination_walk_completed = true,
               provider_enumeration_exhaustion_proven = true,
               coverage_risks = array['star_authority_unresolved', 'second_source_pending']
         where id = $1`,
        [run],
      );
      const rows = await adminQuery<{ proven: boolean; risks: string[] }>(
        `select provider_enumeration_exhaustion_proven as proven, coverage_risks as risks
         from public.source_runs where id = $1`,
        [run],
      );
      expect(rows[0]!.proven).toBe(true);
      expect(rows[0]!.risks).toHaveLength(2);
    });

    it("keeps the two risk vocabularies as separate columns", async () => {
      const cols = await adminQuery<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'source_runs'`,
      );
      const names = cols.map((c) => c.column_name);
      expect(names).toContain("enumeration_risks");
      expect(names).toContain("coverage_risks");
      expect(names).toContain("pagination_walk_completed");
      expect(names).toContain("provider_enumeration_exhaustion_proven");
      // The old conflated name is gone, not aliased.
      expect(names).not.toContain("extraction_exhaustion_proven");
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
      const { identity, run } = await makeIdentityWithRun();
      await observe(run, identity);
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
    it("lets a source identity exist with NO canonical hotel", async () => {
      const identity = await makeIdentity();
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
      const identity = await makeIdentity({ environment: "evaluation" });
      await expect(link(HOTEL.bali, identity)).rejects.toThrow(/production_only/i);
    });

    it("REFUSES an evaluation identity smuggled in under a PRODUCTION label", async () => {
      // The denormalised label is the writer's assertion; the composite FK makes
      // it the IDENTITY's own value instead. Claiming production for an
      // evaluation identity now fails at INSERT — it is not merely detectable
      // afterwards, because a row that never exists cannot be missed by a report
      // nobody runs.
      const identity = await makeIdentity({ environment: "evaluation" });
      await expect(link(HOTEL.bali, identity, { environment: "production" })).rejects.toThrow(
        /hotel_source_identities_identity_fk/i,
      );

      const rows = await adminQuery<{ count: string }>(
        `select count(*)::text as count
         from public.hotel_source_identities hsi
         join public.source_property_identities spi on spi.id = hsi.source_property_identity_id
         where hsi.source_environment <> spi.source_environment
            or hsi.source <> spi.source
            or hsi.source_property_id <> spi.source_property_id`,
      );
      // Not "detectable": unrepresentable.
      expect(rows[0]!.count).toBe("0");
    });

    it("REFUSES a link that misstates the identity's SOURCE", async () => {
      const identity = await makeIdentity({ source: "provider_a", environment: "production" });
      await expect(link(HOTEL.bali, identity, { source: "provider_b" })).rejects.toThrow(
        /hotel_source_identities_identity_fk/i,
      );
    });

    it("REFUSES a link that misstates the identity's PROVIDER ID", async () => {
      const identity = await makeIdentity({ environment: "production" });
      await expect(
        link(HOTEL.bali, identity, { sourcePropertyId: `not-${uniq()}` }),
      ).rejects.toThrow(/hotel_source_identities_identity_fk/i);
    });
  });

  // -----------------------------------------------------------------------
  // Resolution state semantics (§5, §7)
  // -----------------------------------------------------------------------
  describe("resolution state cannot false-close", () => {
    it("refuses `resolved_eligible` without an actual canonical promotion", async () => {
      // D061 §15.1 A is "canonical eligible V1 property", and under D062 a
      // canonical property IS a published row in `hotels`. A directly written
      // label would make a future coverage closure count read zero unresolved
      // while nothing had been published.
      const identity = await makeIdentity({ environment: "production" });
      await expect(
        adminQuery(
          `update public.source_property_identities set resolution_state = 'resolved_eligible' where id = $1`,
          [identity],
        ),
      ).rejects.toThrow(/eligible_requires_promotion/i);
    });

    it("refuses `resolved_eligible` for evaluation data outright", async () => {
      const identity = await makeIdentity({ environment: "evaluation" });
      await expect(
        adminQuery(
          `update public.source_property_identities
             set resolution_state = 'resolved_eligible', promoted_hotel_id = $2
           where id = $1`,
          [identity, HOTEL.bali],
        ),
      ).rejects.toThrow(/eligible_is_production/i);
    });

    it("refuses a promoted_hotel_id this identity has no canonical link to", async () => {
      // The FK layer, independent of any resolution state: `promoted_hotel_id`
      // is keyed against (this identity, that hotel) in hotel_source_identities,
      // so it cannot name a hotel the identity never produced.
      const identity = await makeProductionIdentity();
      await expect(
        adminQuery(
          `update public.source_property_identities set promoted_hotel_id = $2 where id = $1`,
          [identity, HOTEL.bali],
        ),
      ).rejects.toThrow(/promotion_link_fk/i);
    });

    it("refuses `resolved_eligible` against an ARBITRARY existing hotel", async () => {
      // The hole the previous amendment left: `promoted_hotel_id is not null`
      // proved only that some canonical property existed somewhere. It did not
      // prove that THIS identity produced it, was promoted, or passed D062.
      // HOTEL.bali exists and belongs to nothing this identity did.
      const identity = await makeProductionIdentity();
      await expect(
        adminQuery(
          `update public.source_property_identities
             set resolution_state = 'resolved_eligible', promoted_hotel_id = $2
           where id = $1`,
          [identity, HOTEL.bali],
        ),
      ).rejects.toThrow(/no ACTIVE canonical link/i);
    });

    it("refuses `resolved_eligible` when the identity's link points at ANOTHER hotel", async () => {
      const identity = await makeProductionIdentity();
      await link(HOTEL.bali, identity);
      await expect(
        adminQuery(
          `update public.source_property_identities
             set resolution_state = 'resolved_eligible', promoted_hotel_id = $2
           where id = $1`,
          [identity, HOTEL.ibiza],
        ),
      ).rejects.toThrow(/no ACTIVE canonical link/i);
    });

    it("refuses `resolved_eligible` when the identity's own link is not ACTIVE", async () => {
      // A superseded or rejected link says "this identity does NOT correspond to
      // that hotel", which would make the state a lie again.
      const identity = await makeProductionIdentity();
      await link(HOTEL.bali, identity, { status: "superseded" });
      await expect(
        adminQuery(
          `update public.source_property_identities
             set resolution_state = 'resolved_eligible', promoted_hotel_id = $2
           where id = $1`,
          [identity, HOTEL.bali],
        ),
      ).rejects.toThrow(/no ACTIVE canonical link/i);
    });

    it("ACCEPTS `resolved_eligible` for the identity that actually produced the hotel", async () => {
      // The valid relationship: publish, link, then mark eligible — the order
      // A05's apply step runs inside one transaction.
      const identity = await makeProductionIdentity();
      await withPromoted(identity, HOTEL.bali, async (q) => {
        const res = await q(
          `select spi.resolution_state as state, spi.promoted_hotel_id as hotel
           from public.source_property_identities spi
           join public.hotel_source_identities hsi
             on hsi.source_property_identity_id = spi.id and hsi.hotel_id = spi.promoted_hotel_id
           where spi.id = $1 and hsi.link_status = 'active'`,
          [identity],
        );
        const rows = res.rows as { state: string; hotel: string }[];
        expect(rows).toHaveLength(1);
        expect(rows[0]!.state).toBe("resolved_eligible");
        expect(rows[0]!.hotel).toBe(HOTEL.bali);
      });
    });

    it("...but 0034 refuses to COMMIT it without a publication receipt", async () => {
      // The interaction, stated where both halves are visible. 0027 asks "does
      // this identity's own ACTIVE link produce this hotel?" and the answer above
      // is yes. A05 asks a further question 0027 never could — "which human
      // authorized publishing it, against which evidence?" — and a promotion with
      // no answer to that is refused at commit. Neither rule is weakened; the
      // second is simply added.
      const identity = await makeProductionIdentity();
      let outcome = "";
      await withPromoted(identity, HOTEL.bali, async (q) => {
        try {
          await q("set constraints all immediate");
          outcome = "accepted";
        } catch (error) {
          outcome = (error as Error).message;
        }
      });
      expect(outcome).toMatch(/NO publication receipt|nobody signed/);
    });

    it("refuses to demote the canonical link out from under a resolved identity", async () => {
      // 0027's own trigger, and it fires IMMEDIATELY — before A05's deferred
      // publication check ever gets a turn, which is why the transaction is still
      // open when this refusal arrives.
      const identity = await makeProductionIdentity();
      let message = "";
      await withPromoted(identity, HOTEL.ibiza, async (q) => {
        try {
          await q(
            `update public.hotel_source_identities set link_status = 'rejected'
             where source_property_identity_id = $1`,
            [identity],
          );
          message = "ACCEPTED";
        } catch (error) {
          message = (error as Error).message;
        }
      });
      expect(message).toMatch(/cannot leave `active`/i);
    });

    it("refuses `duplicate_matched` with no auditable match target", async () => {
      // "Matched to WHAT?" must always have an answer.
      const identity = await makeIdentity();
      await expect(
        adminQuery(
          `update public.source_property_identities set resolution_state = 'duplicate_matched' where id = $1`,
          [identity],
        ),
      ).rejects.toThrow(/duplicate_target/i);
    });

    it("accepts `duplicate_matched` ONLY against a canonical hotel", async () => {
      // D061 §15.1 B is literally "duplicate/matched to an existing canonical
      // property". Allowing another source identity as the terminal target would
      // let A point at B while B points at A: neither is `unresolved`, and no
      // published property exists anywhere. The coverage count would close on a
      // cycle. Source-to-source equivalence survives as candidate evidence, not
      // as a terminal state.
      const identity = await makeIdentity({ environment: "production" });
      await adminQuery(
        `update public.source_property_identities
           set resolution_state = 'duplicate_matched', matched_hotel_id = $2
         where id = $1`,
        [identity, HOTEL.bali],
      );
      const rows = await adminQuery<{ hotel: string }>(
        `select matched_hotel_id as hotel from public.source_property_identities where id = $1`,
        [identity],
      );
      expect(rows[0]!.hotel).toBe(HOTEL.bali);

      // And there is no source-identity terminal target column to reach for.
      const cols = await adminQuery<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'source_property_identities'`,
      );
      expect(cols.map((c) => c.column_name)).not.toContain("matched_source_property_identity_id");
    });

    it("refuses a match target on an identity that is not matched", async () => {
      const identity = await makeIdentity();
      await expect(
        adminQuery(
          `update public.source_property_identities set matched_hotel_id = $2 where id = $1`,
          [identity, HOTEL.bali],
        ),
      ).rejects.toThrow(/match_target_scope/i);
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

    it("records a NEW PROPERTY assertion as an explicit finding, not an absence", async () => {
      const { identity, run } = await makeIdentityWithRun();
      await makeCandidate(identity, {
        runId: run,
        columns: {
          candidate_kind: "new_property",
          match_method: "manual_search",
          // 0030 requires this: a `new_property` row must carry the finding
          // behind it. `match_method: 'no_canonical_candidate'` — what this
          // fixture said before — is the exact inference that rule forbids,
          // because a sweep finding nothing is a fact about the sweep.
          review_note: "Searched canonical inventory; no existing property. — editor:fixture",
        },
      });
      const rows = await adminQuery<{ kind: string; hotel: string | null; target: string | null }>(
        `select candidate_kind as kind, candidate_hotel_id as hotel,
                candidate_source_property_identity_id as target
         from public.source_match_candidates where source_property_identity_id = $1`,
        [identity],
      );
      // "We looked and found nothing" is a finding, and it says so by name
      // rather than by being the row where both target columns happen to be
      // NULL.
      expect(rows[0]!.kind).toBe("new_property");
      expect(rows[0]!.hotel).toBeNull();
      expect(rows[0]!.target).toBeNull();
    });

    it("supports SOURCE-to-SOURCE matching while BOTH identities stay unresolved", async () => {
      // Hotelbeds H123 and Nuitee N456 can be the same physical hotel long
      // before any row exists in `hotels`. Requiring one provider to be
      // published first to de-duplicate the other is exactly the coupling a
      // source-agnostic architecture exists to avoid.
      const a = await makeIdentity({ source: "provider_a" });
      const b = await makeIdentity({ source: "provider_b" });
      await makeCandidate(a, {
        columns: {
          candidate_kind: "source_identity",
          candidate_source_property_identity_id: b,
          name_evidence: "exact",
          address_evidence: "agrees",
          match_method: "cross_source_name_and_address",
        },
      });
      const rows = await adminQuery<{ kind: string; target: string; hotel: string | null }>(
        `select candidate_kind as kind, candidate_source_property_identity_id as target,
                candidate_hotel_id as hotel
         from public.source_match_candidates
         where source_property_identity_id in ($1,$2)
           and candidate_source_property_identity_id in ($1,$2)`,
        [a, b],
      );
      // The pair is recorded in ONE canonical orientation (0030), so the test
      // asserts the RELATIONSHIP rather than which side it happens to be on.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.kind).toBe("source_identity");
      expect([a, b]).toContain(rows[0]!.target);
      expect(rows[0]!.hotel).toBeNull();

      // Both remain coverage-critical. Recognising an equivalence is evidence,
      // not a resolution — nothing has been published.
      const states = await adminQuery<{ state: string }>(
        `select resolution_state as state from public.source_property_identities where id = any($1)`,
        [[a, b]],
      );
      expect(states.map((s) => s.state)).toEqual(["unresolved", "unresolved"]);
    });

    it("cannot terminally resolve either identity by ACCEPTING a source↔source candidate", async () => {
      // The cycle guard. If an accepted cross-source candidate could close a
      // candidate, A→B and B→A would both leave `unresolved` with no published
      // property anywhere, and the coverage count would close on nothing.
      const a = await makeIdentity({ source: "provider_a" });
      const b = await makeIdentity({ source: "provider_b" });
      await makeCandidate(a, {
        columns: {
          candidate_kind: "source_identity",
          candidate_source_property_identity_id: b,
          status: "accepted",
          name_evidence: "exact",
          address_evidence: "agrees",
          match_method: "cross_source",
        },
      });

      // The only terminal duplicate target is a canonical hotel, and neither
      // identity has one.
      await expect(
        adminQuery(
          `update public.source_property_identities set resolution_state = 'duplicate_matched' where id = $1`,
          [a],
        ),
      ).rejects.toThrow(/duplicate_target/i);

      const states = await adminQuery<{ state: string }>(
        `select resolution_state as state from public.source_property_identities where id = any($1)`,
        [[a, b]],
      );
      expect(states.every((s) => s.state === "unresolved")).toBe(true);
    });

    it("refuses a candidate whose kind and target disagree", async () => {
      const a = await makeIdentity({ source: "provider_a" });
      const b = await makeIdentity({ source: "provider_b" });

      // Claims a canonical match, supplies a source identity.
      await expect(
        makeCandidate(a, {
          columns: {
            candidate_kind: "canonical_hotel",
            candidate_source_property_identity_id: b,
          },
        }),
      ).rejects.toThrow(/target_shape/i);

      // Claims NEW PROPERTY while pointing at a hotel.
      await expect(
        makeCandidate(a, {
          columns: {
            candidate_kind: "new_property",
            candidate_hotel_id: HOTEL.bali,
            review_note: "explicit finding, wrong target",
          },
        }),
      ).rejects.toThrow(/target_shape/i);

      // Points at itself.
      await expect(
        makeCandidate(a, {
          columns: {
            candidate_kind: "source_identity",
            candidate_source_property_identity_id: a,
          },
        }),
      ).rejects.toThrow(/no_self_match/i);
    });

    it("refuses a candidate whose run is from another SOURCE or another ENVIRONMENT", async () => {
      // A run reference is provenance. If it can name an unrelated provider's
      // run, it is worse than absent — it reads as evidence and is not.
      const identity = await makeIdentity({ source: "provider_a", environment: "evaluation" });
      const foreignSourceRun = await makeRun({ source: "provider_b", environment: "evaluation" });
      const foreignEnvRun = await makeRun({ source: "provider_a", environment: "production" });

      await expect(makeCandidate(identity, { runId: foreignSourceRun })).rejects.toThrow(
        /source_match_candidates_run_fk/i,
      );
      await expect(makeCandidate(identity, { runId: foreignEnvRun })).rejects.toThrow(
        /source_match_candidates_run_fk/i,
      );
    });

    it("accepts an ALIGNED run, and a NULL one", async () => {
      const { identity, run } = await makeIdentityWithRun();
      await makeCandidate(identity, { runId: run, columns: { match_method: "aligned_run" } });

      // "Decided outside a run" is honest and stays representable.
      const other = await makeIdentity();
      await makeCandidate(other, { columns: { match_method: "reviewer_finding" } });

      const rows = await adminQuery<{ run: string | null }>(
        `select source_run_id as run from public.source_match_candidates
         where source_property_identity_id = any($1) order by source_run_id nulls last`,
        [[identity, other]],
      );
      expect(rows[0]!.run).toBe(run);
      expect(rows[1]!.run).toBeNull();
    });

    it("keeps `unavailable` distinct from `differs`", async () => {
      const identity = await makeIdentity();
      await makeCandidate(identity, {
        columns: {
          candidate_kind: "canonical_hotel",
          candidate_hotel_id: HOTEL.bali,
          name_evidence: "exact",
          domain_evidence: "unavailable",
          address_evidence: "differs",
          match_method: "name_exact",
        },
      });
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

    it("DERIVES agreeing_dimensions, so it cannot disagree with the evidence", async () => {
      // Previously a writer supplied this count, which meant a row could claim
      // `name=exact, domain=agrees, address=agrees` and `agreeing_dimensions=0`.
      // Duplicate truth drifts the first time a caller updates one and not the
      // other.
      const identity = await makeIdentity();
      await expect(
        makeCandidate(identity, {
          columns: {
            candidate_kind: "canonical_hotel",
            candidate_hotel_id: HOTEL.bali,
            agreeing_dimensions: 0,
          },
        }),
      ).rejects.toThrow(/generated|cannot insert a non-DEFAULT value/i);

      await makeCandidate(identity, {
        columns: {
          candidate_kind: "canonical_hotel",
          candidate_hotel_id: HOTEL.bali,
          name_evidence: "token_containment",
          domain_evidence: "agrees",
          address_evidence: "agrees",
          phone_evidence: "differs",
          brand_evidence: "unavailable",
          known_source_mapping: true,
          coordinate_distance_metres: 12.5,
          match_method: "multi_dimension",
        },
      });
      const rows = await adminQuery<{ dims: number }>(
        `select agreeing_dimensions as dims from public.source_match_candidates
         where source_property_identity_id = $1`,
        [identity],
      );
      // name + domain + address + known mapping = 4. `differs` and `unavailable`
      // count for nothing, and the coordinate distance is deliberately NOT a
      // dimension: there is no approved threshold to count it against.
      expect(rows[0]!.dims).toBe(4);
    });

    it("turns agreeing_dimensions into NO universal matching threshold", async () => {
      // The count summarises evidence; it must never become the decision. An
      // earlier draft of the spec claimed a match required "two or more
      // independent agreeing dimensions" — an invented threshold of exactly the
      // kind D063 §12.2 refuses, and an integer floor is no less invented than a
      // score. One authoritative known_source_mapping can outweigh three
      // circumstantial agreements, so no constraint may grade it.
      const constraints = await adminQuery<{ def: string }>(
        `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c join pg_class t on t.oid = c.conrelid
         where t.relname = 'source_match_candidates'`,
      );
      for (const c of constraints) {
        expect(c.def, `constraint grades the evidence: ${c.def}`).not.toMatch(
          /agreeing_dimensions\s*(>=|>|<|<=)/i,
        );
      }

      // ...and no trigger sneaks one in behind the constraints.
      const triggers = await adminQuery<{ tgname: string }>(
        `select t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
         where c.relname = 'source_match_candidates' and not t.tgisinternal`,
      );
      expect(triggers).toEqual([]);

      // A single-dimension candidate is storable, in every terminal status a
      // reviewer might give it. What one dimension is worth is their call.
      const identity = await makeIdentity();
      await makeCandidate(identity, {
        columns: {
          candidate_kind: "canonical_hotel",
          candidate_hotel_id: HOTEL.bali,
          known_source_mapping: true,
          status: "accepted",
          match_method: "confirmed_known_mapping",
        },
      });
      const rows = await adminQuery<{ dims: number; status: string }>(
        `select agreeing_dimensions as dims, status from public.source_match_candidates
         where source_property_identity_id = $1`,
        [identity],
      );
      expect(rows[0]!.dims).toBe(1);
      expect(rows[0]!.status).toBe("accepted");
    });

    it("keeps the terminal duplicate rule about the TARGET, not the signal count", async () => {
      // duplicate_matched is refused for want of a canonical hotel — never for
      // want of enough dimensions. Here the evidence is as strong as this schema
      // can express (all six dimensions) and it still cannot resolve anything,
      // because the identity names no canonical property.
      const identity = await makeIdentity({ source: "provider_a" });
      const other = await makeIdentity({ source: "provider_b" });
      await makeCandidate(identity, {
        columns: {
          candidate_kind: "source_identity",
          candidate_source_property_identity_id: other,
          name_evidence: "exact",
          domain_evidence: "agrees",
          address_evidence: "agrees",
          phone_evidence: "agrees",
          brand_evidence: "agrees",
          known_source_mapping: true,
          status: "accepted",
          match_method: "every_dimension",
        },
      });
      const dims = await adminQuery<{ dims: number }>(
        `select agreeing_dimensions as dims from public.source_match_candidates
         where source_property_identity_id in ($1,$2)
           and candidate_source_property_identity_id in ($1,$2)`,
        [identity, other],
      );
      expect(dims[0]!.dims).toBe(6);

      await expect(
        adminQuery(
          `update public.source_property_identities set resolution_state = 'duplicate_matched' where id = $1`,
          [identity],
        ),
      ).rejects.toThrow(/duplicate_target/i);
    });

    it("recomputes agreeing_dimensions when the evidence is corrected", async () => {
      const identity = await makeIdentity();
      await makeCandidate(identity, {
        columns: {
          candidate_kind: "canonical_hotel",
          candidate_hotel_id: HOTEL.bali,
          name_evidence: "exact",
          match_method: "name_only",
        },
      });
      const dims = async () =>
        (
          await adminQuery<{ dims: number }>(
            `select agreeing_dimensions as dims from public.source_match_candidates
             where source_property_identity_id = $1`,
            [identity],
          )
        )[0]!.dims;
      // A name alone is ONE dimension, whatever its strength. What that is worth
      // is the reviewer's call, not a number this schema enforces.
      expect(await dims()).toBe(1);

      await adminQuery(
        `update public.source_match_candidates
           set domain_evidence = 'agrees', phone_evidence = 'agrees'
         where source_property_identity_id = $1`,
        [identity],
      );
      expect(await dims()).toBe(3);

      // Withdrawing evidence lowers it again; the count cannot be left stale.
      await adminQuery(
        `update public.source_match_candidates
           set name_evidence = 'none', domain_evidence = 'unavailable'
         where source_property_identity_id = $1`,
        [identity],
      );
      expect(await dims()).toBe(1);
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
      const identity = await makeIdentity();
      await expect(
        makeReview(identity, { columns: { decision: "approve_create" } }),
      ).rejects.toThrow(/decision_shape/i);

      await expect(
        makeReview(identity, { columns: { decision: "reject", target_hotel_id: HOTEL.bali } }),
      ).rejects.toThrow(/decision_shape/i);
    });

    it("keeps at most one live decision per identity", async () => {
      const identity = await makeIdentity();
      await makeReview(identity);
      await expect(makeReview(identity, { columns: { decision: "reject" } })).rejects.toThrow(
        /duplicate key/i,
      );
    });

    it("refuses a decision cited against another SOURCE's or ENVIRONMENT's run", async () => {
      // Same rule as candidates: `decided_in_run_id` is the evidence the
      // reviewer looked at, so it must belong to this identity's provider and
      // environment or it is a false citation.
      const identity = await makeIdentity({ source: "provider_a", environment: "evaluation" });
      const foreignSourceRun = await makeRun({ source: "provider_b", environment: "evaluation" });
      const foreignEnvRun = await makeRun({ source: "provider_a", environment: "production" });

      await expect(makeReview(identity, { runId: foreignSourceRun })).rejects.toThrow(
        /source_property_reviews_run_fk/i,
      );
      await expect(makeReview(identity, { runId: foreignEnvRun })).rejects.toThrow(
        /source_property_reviews_run_fk/i,
      );
    });

    it("accepts a decision against an ALIGNED run", async () => {
      const { identity, run } = await makeIdentityWithRun();
      await makeReview(identity, { runId: run });
      const rows = await adminQuery<{ run: string }>(
        `select decided_in_run_id as run from public.source_property_reviews
         where source_property_identity_id = $1`,
        [identity],
      );
      expect(rows[0]!.run).toBe(run);
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
      await makeIdentity();
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
      await makeIdentity();
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
         values ($3, 'evaluation', $1, $2, $2)`,
        [uniq(), run, DEFAULT_SOURCE],
      );
      expect(admin.error).toBeNull();

      const creator = await queryAs(
        { role: "authenticated", sub: USERS.free },
        `insert into public.source_property_identities
           (source, source_environment, source_property_id, first_seen_run_id, last_seen_run_id)
         values ($3, 'evaluation', $1, $2, $2)`,
        [uniq(), run, DEFAULT_SOURCE],
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
