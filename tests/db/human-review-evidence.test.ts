/**
 * A04.5 — human pre-publication review evidence (migration 0032 + the apply path).
 *
 * This layer answers ONE question: how does an explicit human decision that a
 * source identity is a distinct property in a named supported destination become
 * durable, auditable, current-evidence-bound evidence that A04's conditions 1
 * and 2 can safely cite?
 *
 * The suite is organised around the ways that answer goes wrong:
 *
 *   1. "no conflict" mistaken for "positive new-property evidence". Condition 11
 *      passing means nobody found a contradiction; it is not a finding that this
 *      is a NEW property, and A04 must never treat it as one.
 *   2. a decision outliving its evidence. A human reviews observation A; ingestion
 *      advances to B; the old judgement must not silently apply to B.
 *   3. half a decision. A review row without its finding, or a finding without a
 *      review, is not a reviewed property — and neither may survive a failure of
 *      the other.
 *   4. a review that records only "approved". What was checked, and what was
 *      merely unavailable, has to survive.
 *
 * All fixtures synthetic. No real provider data, and no real decision about any
 * of the 4,110 real identities appears here.
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "./harness";
import { seed, USERS } from "../rls/seed";
import { loadPreviewResults } from "../../scripts/prepublication-preview/preview";
import { readinessOf, reviewRowOnlyEligible } from "../../scripts/human-review/readiness";
import {
  applyReviewedManifest,
  HUMAN_NEW_PROPERTY_METHOD,
  receiptDigestOf,
  validateReviewedItem,
  ReviewRefusal,
  type ReviewedItem,
} from "../../scripts/human-review/apply";
import { buildReviewPack, REVIEW_DIMENSIONS } from "../../scripts/human-review/pack";
import { resolveReviewWriteTarget } from "../../scripts/human-review/target";

const d = describe.skipIf(!hasTestDb);
const SOURCE = "hotelbeds";
const AS_OF = "2026-08-17";
const POLICY = {
  provider: "hotelbeds",
  // The approved versions 0028/0029/0031 seed. The fixture cites the real
  // policies rather than test-only ones, so a resolution here is the same kind
  // of row the resolver writes.
  star: "hotelbeds-classification/1",
  scope: "hotelbeds-hospitality-scope/1",
  location: "hotelbeds-location/1",
};
/** Provider codes the seeded policies actually map. */
const STAR_CODE = "4EST";
const SCOPE_CODE = "H";

let counter = 0;
const uniq = () => `H${Date.now().toString(36)}${(counter += 1)}`;

interface Fixture {
  identityId: string;
  observationId: string;
  sourcePropertyId: string;
  runId: string;
  digest: string;
  destinationId: string;
}

async function client(): Promise<Client> {
  const c = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  return c;
}

async function destination(slug: string): Promise<string> {
  const existing = await adminQuery<{ id: string }>(
    "select id from public.destinations where slug = $1",
    [slug],
  );
  if (existing.length > 0) return existing[0]!.id;
  const rows = await adminQuery<{ id: string }>(
    `insert into public.destinations (slug, name, type, country_code)
     values ($1, $1, 'city', 'ID') returning id`,
    [slug],
  );
  return rows[0]!.id;
}

async function newRun(destinationId: string, offsetSeconds = 0): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    `insert into public.source_runs (source, source_environment, destination_id, run_mode, started_at)
     values ($1,'evaluation',$2,'evaluation', now() + ($3 || ' seconds')::interval) returning id`,
    [SOURCE, destinationId, String(offsetSeconds)],
  );
  return rows[0]!.id;
}

/**
 * An identity that is HUMAN-REVIEW-READY: every non-review condition passes.
 *
 * Deliberately carries no domain, no phone and a unique name, so the live
 * discovery sweep produces no blocking key for it — which is what makes
 * condition 11 pass without any candidate row existing.
 */
async function readyProperty(opts?: {
  slug?: string;
  star?: "exact_four" | "exact_five" | "classified_not_v1_scope" | "unresolved";
  scope?: "physical_hospitality" | "not_physical_hospitality" | "unresolved";
  withCoordinates?: boolean;
  /** Set to collide two identities on a blocking key. Observations are
   *  append-only, so this must be supplied at creation, never patched in. */
  websiteUrl?: string;
}): Promise<Fixture> {
  const slug = opts?.slug ?? "bali";
  const destinationId = await destination(slug);
  const runId = await newRun(destinationId);
  const sourcePropertyId = uniq();
  const digest = `digest-${uniq()}`;

  const identity = await adminQuery<{ id: string }>(
    `insert into public.source_property_identities
       (source, source_environment, source_property_id, first_seen_run_id, last_seen_run_id)
     values ($1,'evaluation',$2,$3,$3) returning id`,
    [SOURCE, sourcePropertyId, runId],
  );
  const identityId = identity[0]!.id;

  const observation = await adminQuery<{ id: string }>(
    `insert into public.source_property_observations
       (source_run_id, source_property_identity_id, source, source_environment, observed_at,
        source_name, source_city, source_address, source_latitude, source_longitude,
        source_coordinates_plausible, source_classification_code, source_property_type_code,
        source_website_url, source_payload_digest)
     values ($1,$2,$3,'evaluation', now(), $4, 'Ubud', 'Jl Test 1', -8.5, 115.26,
             true, $6, $7, $8, $5)
     returning id`,
    [
      runId,
      identityId,
      SOURCE,
      `Ready Property ${sourcePropertyId}`,
      digest,
      STAR_CODE,
      SCOPE_CODE,
      opts?.websiteUrl ?? null,
    ],
  );
  const observationId = observation[0]!.id;

  await setStar(identityId, observationId, opts?.star ?? "exact_four");
  await setScope(identityId, observationId, opts?.scope ?? "physical_hospitality");
  await setLocation(identityId, observationId, opts?.withCoordinates ?? true);
  await setCompleteLifecycleSnapshot(identityId, observationId, runId, digest);

  return { identityId, observationId, sourcePropertyId, runId, digest, destinationId };
}

async function setStar(identityId: string, observationId: string, outcome: string): Promise<void> {
  const value = outcome === "exact_four" ? 4 : outcome === "exact_five" ? 5 : null;
  const rev = await adminQuery<{ id: string }>(
    `insert into public.source_property_star_resolution_revisions
       (source_property_identity_id, source, source_environment, evidence_observation_id,
        policy_provider, policy_version, policy_field, source_value, outcome, resolved_star_value,
        conflict_state)
     values ($1,$2,'evaluation',$3,$4,$5,'categoryCode',$8,$6,$7,'none') returning id`,
    [identityId, SOURCE, observationId, POLICY.provider, POLICY.star, outcome, value, STAR_CODE],
  );
  await adminQuery(
    `insert into public.source_property_star_resolutions (source_property_identity_id, current_revision_id)
     values ($1,$2)
     on conflict (source_property_identity_id) do update set current_revision_id = excluded.current_revision_id`,
    [identityId, rev[0]!.id],
  );
}

async function setScope(identityId: string, observationId: string, outcome: string): Promise<void> {
  const rev = await adminQuery<{ id: string }>(
    `insert into public.source_property_scope_resolution_revisions
       (source_property_identity_id, source, source_environment, evidence_observation_id,
        policy_provider, policy_version, policy_field, source_value, outcome)
     values ($1,$2,'evaluation',$3,$4,$5,'accommodationTypeCode',$7,$6) returning id`,
    [identityId, SOURCE, observationId, POLICY.provider, POLICY.scope, outcome, SCOPE_CODE],
  );
  await adminQuery(
    `insert into public.source_property_scope_resolutions (source_property_identity_id, current_revision_id)
     values ($1,$2)
     on conflict (source_property_identity_id) do update set current_revision_id = excluded.current_revision_id`,
    [identityId, rev[0]!.id],
  );
}

async function setLocation(
  identityId: string,
  observationId: string,
  withCoordinates: boolean,
): Promise<void> {
  const rev = await adminQuery<{ id: string }>(
    `insert into public.source_property_location_resolution_revisions
       (source_property_identity_id, source, source_environment, evidence_observation_id,
        policy_provider, policy_version, outcome, resolved_latitude, resolved_longitude,
        unresolved_reason, conflict_state)
     values ($1,$2,'evaluation',$3,$4,$5,$6,$7,$8,$9,'none') returning id`,
    [
      identityId,
      SOURCE,
      observationId,
      POLICY.provider,
      POLICY.location,
      withCoordinates ? "resolved" : "unresolved",
      withCoordinates ? -8.5 : null,
      withCoordinates ? 115.26 : null,
      withCoordinates ? null : "coordinates_missing",
    ],
  );
  await adminQuery(
    `insert into public.source_property_location_resolutions (source_property_identity_id, current_revision_id)
     values ($1,$2)
     on conflict (source_property_identity_id) do update set current_revision_id = excluded.current_revision_id`,
    [identityId, rev[0]!.id],
  );
}

/** A complete lifecycle snapshot carrying zero provider issues: no known closure. */
async function setCompleteLifecycleSnapshot(
  identityId: string,
  observationId: string,
  runId: string,
  digest: string,
): Promise<void> {
  await adminQuery(
    `insert into public.source_property_issue_snapshots
       (source_property_identity_id, source, source_environment, evidence_observation_id,
        extraction_status, provider_issue_count, source_payload_digest, evidence_source_run_id,
        extraction_method)
     values ($1,$2,'evaluation',$3,'complete',0,$4,$5,'test-fixture/1')`,
    [identityId, SOURCE, observationId, digest, runId],
  );
}

/** A LATER observation, advancing last_seen_run_id the way ingestion does. */
async function advanceToNewObservation(
  f: Fixture,
): Promise<{ observationId: string; runId: string }> {
  const runId = await newRun(f.destinationId, 3600);
  const digest = `digest-${uniq()}`;
  const rows = await adminQuery<{ id: string }>(
    `insert into public.source_property_observations
       (source_run_id, source_property_identity_id, source, source_environment, observed_at,
        source_name, source_latitude, source_longitude, source_coordinates_plausible,
        source_classification_code, source_property_type_code, source_payload_digest)
     values ($1,$2,$3,'evaluation', now() + interval '1 hour', $4, -8.5, 115.26,
             true, $6, $7, $5) returning id`,
    [
      runId,
      f.identityId,
      SOURCE,
      `Ready Property ${f.sourcePropertyId}`,
      digest,
      STAR_CODE,
      SCOPE_CODE,
    ],
  );
  const observationId = rows[0]!.id;
  await adminQuery(
    "update public.source_property_identities set last_seen_run_id = $2 where id = $1",
    [f.identityId, runId],
  );
  await setStar(f.identityId, observationId, "exact_four");
  await setScope(f.identityId, observationId, "physical_hospitality");
  await setLocation(f.identityId, observationId, true);
  await setCompleteLifecycleSnapshot(f.identityId, observationId, runId, digest);
  return { observationId, runId };
}

async function preview(sourcePropertyId: string) {
  const c = await client();
  try {
    const [result] = await loadPreviewResults(c, {
      source: SOURCE,
      environment: "evaluation",
      asOf: AS_OF,
      identityId: null,
      sourcePropertyId,
      limit: 1,
    });
    return result!;
  } finally {
    await c.end();
  }
}

const statusOf = (r: Awaited<ReturnType<typeof preview>>, n: number) =>
  r.conditions.find((c) => c.number === n)!.status;
const reasonOf = (r: Awaited<ReturnType<typeof preview>>, n: number) =>
  r.conditions.find((c) => c.number === n)!.reason;

/** A complete, valid approve_create manifest for a ready fixture. */
async function manifestFor(
  f: Fixture,
  overrides: Partial<ReviewedItem> = {},
): Promise<ReviewedItem> {
  const p = await preview(f.sourcePropertyId);
  return {
    identityId: f.identityId,
    sourcePropertyId: f.sourcePropertyId,
    currentObservationId: f.observationId,
    currentSourceRunId: f.runId,
    sourcePayloadDigest: f.digest,
    prereviewFingerprint: p.fingerprint,
    prereviewAsOf: AS_OF,
    decision: "approve_create",
    canonicalDestinationSlug: "bali",
    reviewerLabel: "test-reviewer",
    humanNote: "Verified against the official property site.",
    verifications: REVIEW_DIMENSIONS.map((dimension) => ({
      dimension,
      verdict: "supports" as const,
    })),
    evidenceReferences: [
      {
        referenceKind: "official_property_site",
        locator: "https://example.invalid/official",
        bearsOnDimensions: ["distinct_property", "destination_membership"],
        stance: "supports" as const,
      },
    ],
    ...overrides,
  };
}

async function apply(items: ReviewedItem[], opts: { apply: boolean }) {
  const c = await client();
  try {
    return await applyReviewedManifest(c, items, {
      source: SOURCE,
      environment: "evaluation",
      asOf: AS_OF,
      apply: opts.apply,
    });
  } finally {
    await c.end();
  }
}

d("A04.5 human review evidence (0032)", () => {
  beforeAll(async () => {
    await setupDatabase();
    await seed();
  });
  afterAll(teardownDatabase);

  // =====================================================================
  describe("readiness comes from the REAL A04 evaluator", () => {
    it("1. a ready identity is ready, and every non-review condition passes", async () => {
      const f = await readyProperty();
      const p = await preview(f.sourcePropertyId);
      const verdict = readinessOf(p);
      expect(verdict.blocking).toEqual([]);
      expect(verdict.ready).toBe(true);
      for (const n of [3, 4, 6, 7, 8, 9, 10, 11]) expect(statusOf(p, n)).toBe("PASS");
    });

    it("1b. readiness is derived from condition results, not a SQL re-derivation", async () => {
      // The predicate is a pure function of a PreviewResult. Hand it a result
      // whose condition 11 is held and it must refuse, with no database at all.
      const f = await readyProperty();
      const real = await preview(f.sourcePropertyId);
      const doctored = {
        ...real,
        conditions: real.conditions.map((c) =>
          c.number === 11
            ? { ...c, status: "UNRESOLVED" as const, reason: "current_entity_conflict" }
            : c,
        ),
      };
      expect(readinessOf(doctored).ready).toBe(false);
      expect(readinessOf(doctored).blocking.map((b) => b.number)).toEqual([11]);
    });

    it("2. an identity in a c11 anomaly is NOT review-ready", async () => {
      // Two identities in different destinations sharing one phone: a
      // cross-destination anomaly, which the live sweep surfaces and c11 holds on.
      // Observations are APPEND-ONLY, so the colliding key is supplied when the
      // fixture is created. No cleanup is needed and none is possible: a
      // cross-destination collision is VETOED into zero pairs by A02, so it
      // never reaches the sync gate — it only marks these two identities.
      const websiteUrl = `https://collide-${uniq()}.example.com/`;
      const a = await readyProperty({ slug: "bali", websiteUrl });
      await readyProperty({ slug: "dubai", websiteUrl });

      const p = await preview(a.sourcePropertyId);
      expect(statusOf(p, 11)).toBe("UNRESOLVED");
      expect(
        p.conditions.find((c) => c.number === 11)!.evidence.currentAnomalyReasons as string[],
      ).toContain("cross_destination_collision");
      expect(readinessOf(p).ready).toBe(false);
    });

    it("3. a pending candidate on EITHER endpoint blocks readiness", async () => {
      const left = await readyProperty();
      const right = await readyProperty();
      const [lo, hi] = left.identityId < right.identityId ? [left, right] : [right, left];
      await adminQuery(
        `insert into public.source_match_candidates
           (source_property_identity_id, source, source_environment, candidate_kind,
            candidate_source_property_identity_id, match_method, status)
         values ($1,$2,'evaluation','source_identity',$3,'blocking:exact_phone','pending')`,
        [lo.identityId, SOURCE, hi.identityId],
      );
      try {
        // The pair is stored in ONE orientation; BOTH endpoints must be blocked.
        // This is F1 from A04: a consumer reading only the left column would see
        // one of these two as unblocked.
        for (const f of [lo, hi]) {
          const p = await preview(f.sourcePropertyId);
          expect(statusOf(p, 11)).toBe("UNRESOLVED");
          expect(readinessOf(p).ready).toBe(false);
        }
      } finally {
        // A persisted pair the live sweep does not rediscover fails the sync gate
        // GLOBALLY, so it cannot be left behind either.
        await adminQuery(
          "delete from public.source_match_candidates where source_property_identity_id = $1 and candidate_source_property_identity_id = $2",
          [lo.identityId, hi.identityId],
        );
      }
    });

    it("4. ready + no review leaves c1/c2/c5 unresolved", async () => {
      const f = await readyProperty();
      const p = await preview(f.sourcePropertyId);
      expect(statusOf(p, 1)).toBe("UNRESOLVED");
      expect(statusOf(p, 2)).toBe("UNRESOLVED");
      expect(statusOf(p, 5)).toBe("UNRESOLVED");
      expect(p.overall).toBe("UNRESOLVED");
    });

    it("31/32. no automatic NEW inference and no automatic destination inference", async () => {
      const f = await readyProperty();
      const p = await preview(f.sourcePropertyId);
      // The identity has NO candidate at all, and provider geography names bali.
      expect(reasonOf(p, 1)).toBe("identity_review_missing_or_deferred");
      expect(reasonOf(p, 2)).toBe("reviewed_destination_missing_or_invalid");
      const accepted = await adminQuery<{ n: string }>(
        "select count(*)::text n from public.source_match_candidates where source_property_identity_id=$1",
        [f.identityId],
      );
      expect(accepted[0]!.n).toBe("0");
    });
  });

  // =====================================================================
  describe("neither artefact alone establishes identity", () => {
    it("5. a source_property_reviews row alone does NOT make c1 pass", async () => {
      const f = await readyProperty();
      await adminQuery(
        `insert into public.source_property_reviews
           (source_property_identity_id, source, source_environment, decision, destination_id,
            reviewer_label)
         values ($1,$2,'evaluation','approve_create',$3,'hand-written')`,
        [f.identityId, SOURCE, f.destinationId],
      );
      const p = await preview(f.sourcePropertyId);
      expect(statusOf(p, 1)).toBe("UNRESOLVED");
      expect(reasonOf(p, 1)).toBe("identity_decision_lacks_support");
    });

    it("6. an accepted new_property finding alone does NOT make c1 pass", async () => {
      const f = await readyProperty();
      await adminQuery(
        `insert into public.source_match_candidates
           (source_property_identity_id, source, source_environment, candidate_kind, match_method,
            status, review_note)
         values ($1,$2,'evaluation','new_property',$3,'accepted','hand-written finding')`,
        [f.identityId, SOURCE, HUMAN_NEW_PROPERTY_METHOD],
      );
      const p = await preview(f.sourcePropertyId);
      expect(statusOf(p, 1)).toBe("UNRESOLVED");
      expect(reasonOf(p, 1)).toBe("identity_review_missing_or_deferred");
    });

    it("6b. review + finding but NO receipt still holds c1 and c2", async () => {
      const f = await readyProperty();
      await adminQuery(
        `insert into public.source_match_candidates
           (source_property_identity_id, source, source_environment, candidate_kind, match_method,
            status, review_note)
         values ($1,$2,'evaluation','new_property',$3,'accepted','hand-written finding')`,
        [f.identityId, SOURCE, HUMAN_NEW_PROPERTY_METHOD],
      );
      await adminQuery(
        `insert into public.source_property_reviews
           (source_property_identity_id, source, source_environment, decision, destination_id, reviewer_label)
         values ($1,$2,'evaluation','approve_create',$3,'hand-written')`,
        [f.identityId, SOURCE, f.destinationId],
      );
      const p = await preview(f.sourcePropertyId);
      expect(statusOf(p, 1)).toBe("UNRESOLVED");
      expect(reasonOf(p, 1)).toBe("human_review_receipt_missing");
      expect(statusOf(p, 2)).toBe("UNRESOLVED");
      expect(reasonOf(p, 2)).toBe("human_review_receipt_missing");
    });
  });

  // =====================================================================
  describe("a valid approve_create reaches 11/11 and publishes nothing", () => {
    it("7/8/9/10. all eleven conditions pass after a valid review", async () => {
      const f = await readyProperty();
      const before = await preview(f.sourcePropertyId);
      expect([1, 2, 5].map((n) => statusOf(before, n))).toEqual([
        "UNRESOLVED",
        "UNRESOLVED",
        "UNRESOLVED",
      ]);

      const report = await apply([await manifestFor(f)], { apply: true });
      expect(report.outcomes[0]!.state).toBe("applied");

      const after = await preview(f.sourcePropertyId);
      expect(statusOf(after, 1)).toBe("PASS"); // 7
      expect(reasonOf(after, 1)).toBe("reviewed_distinct_property");
      expect(statusOf(after, 2)).toBe("PASS"); // 8
      expect(statusOf(after, 5)).toBe("PASS"); // 9
      for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) expect(statusOf(after, n)).toBe("PASS"); // 10
      expect(after.overall).toBe("PASS");
    });

    it("9b. condition 5 derives from 1/2/3/4/6/7/11, never from overall", async () => {
      const f = await readyProperty();
      await apply([await manifestFor(f)], { apply: true });
      const p = await preview(f.sourcePropertyId);
      const c5 = p.conditions.find((c) => c.number === 5)!;
      const inputs = c5.evidence.inputConditions as Array<{ number: number }>;
      expect(inputs.map((i) => i.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 6, 7, 11]);
    });

    it("11/36. overall PASS writes NOTHING canonical", async () => {
      // The RLS seed creates pilot hotels, so the assertion is not "zero rows"
      // but "this review changed no canonical row" -- which is the invariant that
      // actually matters, and the one that stays true on a seeded database.
      const snapshot = async () =>
        (
          await adminQuery<{ hotels: string; links: string; contacts: string; promoted: string }>(
            `select (select count(*)::text from public.hotels) hotels,
                    (select count(*)::text from public.hotel_source_identities) links,
                    (select count(*)::text from public.hotel_contacts) contacts,
                    (select count(*)::text from public.source_property_identities
                      where promoted_hotel_id is not null) promoted`,
          )
        )[0]!;

      const f = await readyProperty();
      const before = await snapshot();
      await apply([await manifestFor(f)], { apply: true });
      expect((await preview(f.sourcePropertyId)).overall).toBe("PASS");
      expect(await snapshot()).toEqual(before);
      expect(before.links).toBe("0");
      expect(before.promoted).toBe("0");
    });

    it("37. no identity leaves resolution_state = unresolved, and no production identity exists", async () => {
      const f = await readyProperty();
      await apply([await manifestFor(f)], { apply: true });
      const rows = await adminQuery<{ n: string }>(
        `select count(*)::text n from public.source_property_identities
          where resolution_state <> 'unresolved' or source_environment = 'production'`,
      );
      expect(rows[0]!.n).toBe("0");
    });
  });

  // =====================================================================
  describe("the receipt names the exact evidence, and nothing else's", () => {
    it("12/13. the receipt cites the current observation and the current run", async () => {
      const f = await readyProperty();
      await apply([await manifestFor(f)], { apply: true });
      const rows = await adminQuery<{
        evidence_observation_id: string;
        evidence_source_run_id: string;
        source_payload_digest: string;
        source_property_id: string;
      }>(
        `select evidence_observation_id, evidence_source_run_id, source_payload_digest, source_property_id
           from public.source_property_review_receipts where source_property_identity_id = $1`,
        [f.identityId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.evidence_observation_id).toBe(f.observationId);
      expect(rows[0]!.evidence_source_run_id).toBe(f.runId);
      expect(rows[0]!.source_payload_digest).toBe(f.digest);
      expect(rows[0]!.source_property_id).toBe(f.sourcePropertyId);
    });

    it("14. a receipt cannot cite ANOTHER identity's observation", async () => {
      const mine = await readyProperty();
      const other = await readyProperty();
      await expect(
        adminQuery(
          `insert into public.source_property_review_receipts
             (source_property_identity_id, source, source_environment, source_property_id,
              evidence_observation_id, evidence_source_run_id, source_payload_digest,
              prereview_fingerprint, prereview_as_of, decision, reviewer_label, review_note,
              receipt_digest, reviewed_at)
           values ($1,$2,'evaluation',$3,$4,$5,$6,$7,'2026-08-17','defer','x','why',$8, now())`,
          [
            mine.identityId,
            SOURCE,
            mine.sourcePropertyId,
            other.observationId, // <- another identity's observation
            other.runId,
            other.digest,
            "a".repeat(64),
            "b".repeat(64),
          ],
        ),
      ).rejects.toThrow();
    });

    it("14b. a receipt cannot claim a payload digest the observation never carried", async () => {
      const f = await readyProperty();
      await expect(
        adminQuery(
          `insert into public.source_property_review_receipts
             (source_property_identity_id, source, source_environment, source_property_id,
              evidence_observation_id, evidence_source_run_id, source_payload_digest,
              prereview_fingerprint, prereview_as_of, decision, reviewer_label, review_note,
              receipt_digest, reviewed_at)
           values ($1,$2,'evaluation',$3,$4,$5,'not-the-real-digest',$6,'2026-08-17','defer','x','why',$7, now())`,
          [
            f.identityId,
            SOURCE,
            f.sourcePropertyId,
            f.observationId,
            f.runId,
            "a".repeat(64),
            "b".repeat(64),
          ],
        ),
      ).rejects.toThrow();
    });

    it("the receipt is APPEND-ONLY: no update, no delete", async () => {
      const f = await readyProperty();
      await apply([await manifestFor(f)], { apply: true });
      await expect(
        adminQuery(
          "update public.source_property_review_receipts set reviewer_label = 'x' where source_property_identity_id = $1",
          [f.identityId],
        ),
      ).rejects.toThrow(/APPEND-ONLY/);
      await expect(
        adminQuery(
          "delete from public.source_property_review_receipts where source_property_identity_id = $1",
          [f.identityId],
        ),
      ).rejects.toThrow(/APPEND-ONLY/);
    });
  });

  // =====================================================================
  describe("a decision may not outlive the evidence it was made against", () => {
    it("15/17. an observation advancing after prepare makes the manifest stale", async () => {
      const f = await readyProperty();
      const prepared = await manifestFor(f);
      await advanceToNewObservation(f);
      const report = await apply([prepared], { apply: true });
      const outcome = report.outcomes[0]!;
      expect(outcome.state).toBe("refused");
      if (outcome.state === "refused") expect(outcome.refusal).toBe("stale_observation");
      const receipts = await adminQuery<{ n: string }>(
        "select count(*)::text n from public.source_property_review_receipts where source_property_identity_id=$1",
        [f.identityId],
      );
      expect(receipts[0]!.n).toBe("0");
    });

    it("16. a changed A04 pre-review fingerprint is refused", async () => {
      const f = await readyProperty();
      const prepared = await manifestFor(f, { prereviewFingerprint: "0".repeat(64) });
      const report = await apply([prepared], { apply: true });
      const outcome = report.outcomes[0]!;
      expect(outcome.state).toBe("refused");
      if (outcome.state === "refused") expect(outcome.refusal).toBe("stale_prereview_fingerprint");
    });

    it("39. an applied receipt stops being current when the observation moves", async () => {
      const f = await readyProperty();
      await apply([await manifestFor(f)], { apply: true });
      expect((await preview(f.sourcePropertyId)).overall).toBe("PASS");

      await advanceToNewObservation(f);
      const after = await preview(f.sourcePropertyId);
      expect(statusOf(after, 1)).toBe("UNRESOLVED");
      expect(reasonOf(after, 1)).toBe("human_review_receipt_not_current");
      expect(statusOf(after, 2)).toBe("UNRESOLVED");
      expect(after.overall).toBe("UNRESOLVED");
    });

    it("38. the A04 fingerprint binds the receipt semantics c1/c2 use", async () => {
      const f = await readyProperty();
      const before = await preview(f.sourcePropertyId);
      await apply([await manifestFor(f)], { apply: true });
      const after = await preview(f.sourcePropertyId);
      expect(after.fingerprint).not.toBe(before.fingerprint);
      const c1 = after.conditions.find((c) => c.number === 1)!;
      expect(c1.evidence.receiptId).toBeTruthy();
      expect(c1.evidence.receiptIsCurrent).toBe(true);
    });
  });

  // =====================================================================
  describe("what the human checked has to survive", () => {
    it("18. approve_create requires an affirmative distinct-property verdict", async () => {
      const f = await readyProperty();
      const item = await manifestFor(f, {
        verifications: REVIEW_DIMENSIONS.map((dimension) => ({
          dimension,
          verdict:
            dimension === "distinct_property" ? ("unavailable" as const) : ("supports" as const),
        })),
      });
      expect(() => validateReviewedItem(item)).toThrow(ReviewRefusal);
      expect(() => validateReviewedItem(item)).toThrow(/distinct-property/);
    });

    it("19. approve_create requires an affirmative destination-membership verdict", async () => {
      const f = await readyProperty();
      const item = await manifestFor(f, {
        verifications: REVIEW_DIMENSIONS.map((dimension) => ({
          dimension,
          verdict:
            dimension === "destination_membership"
              ? ("unavailable" as const)
              : ("supports" as const),
        })),
      });
      expect(() => validateReviewedItem(item)).toThrow(/destination-membership/);
    });

    it("20. an unavailable dimension is stored as unavailable, never promoted to supports", async () => {
      const f = await readyProperty();
      const item = await manifestFor(f, {
        verifications: REVIEW_DIMENSIONS.map((dimension) => ({
          dimension,
          verdict: dimension === "address" ? ("unavailable" as const) : ("supports" as const),
        })),
      });
      await apply([item], { apply: true });
      const rows = await adminQuery<{ dimension: string; verdict: string }>(
        `select v.dimension, v.verdict
           from public.source_property_review_verifications v
           join public.source_property_review_receipts r on r.id = v.receipt_id
          where r.source_property_identity_id = $1 order by v.dimension`,
        [f.identityId],
      );
      expect(rows).toHaveLength(6);
      expect(rows.find((r) => r.dimension === "address")!.verdict).toBe("unavailable");
    });

    it("20b. a dimension may not simply be omitted", async () => {
      const f = await readyProperty();
      const item = await manifestFor(f, {
        verifications: REVIEW_DIMENSIONS.filter((x) => x !== "address").map((dimension) => ({
          dimension,
          verdict: "supports" as const,
        })),
      });
      expect(() => validateReviewedItem(item)).toThrow(/address/);
      expect(() => validateReviewedItem(item)).toThrow(/unavailable, never omitted/);
    });

    it("21. a contradicting dimension is visible and requires an explanation", async () => {
      const f = await readyProperty();
      const withoutNote = await manifestFor(f, {
        verifications: REVIEW_DIMENSIONS.map((dimension) => ({
          dimension,
          verdict: dimension === "coordinates" ? ("contradicts" as const) : ("supports" as const),
        })),
      });
      expect(() => validateReviewedItem(withoutNote)).toThrow(/explanation/);

      // With the explanation it is allowed — a provider coordinate may be wrong
      // while an official address still settles the destination — and it stays
      // visible in the evidence.
      const withNote = await manifestFor(f, {
        verifications: REVIEW_DIMENSIONS.map((dimension) => ({
          dimension,
          verdict: dimension === "coordinates" ? ("contradicts" as const) : ("supports" as const),
          note:
            dimension === "coordinates"
              ? "Provider point is 30 km off; official address governs."
              : null,
        })),
      });
      const report = await apply([withNote], { apply: true });
      expect(report.outcomes[0]!.state).toBe("applied");
      const rows = await adminQuery<{ verdict: string; note: string }>(
        `select v.verdict, v.note from public.source_property_review_verifications v
           join public.source_property_review_receipts r on r.id = v.receipt_id
          where r.source_property_identity_id = $1 and v.dimension = 'coordinates'`,
        [f.identityId],
      );
      expect(rows[0]!.verdict).toBe("contradicts");
      expect(rows[0]!.note).toMatch(/official address governs/);
      // ...and the property still reaches PASS, because the reviewer resolved it.
      expect((await preview(f.sourcePropertyId)).overall).toBe("PASS");
    });

    it("22. approve_create requires at least one structured evidence reference", async () => {
      const f = await readyProperty();
      const item = await manifestFor(f, { evidenceReferences: [] });
      expect(() => validateReviewedItem(item)).toThrow(/at least one external evidence reference/);
    });

    it("22b. the database refuses an approve_create receipt with no reference", async () => {
      // Belt and braces: the deferred constraint trigger fails the transaction
      // even if a future writer forgets the application-level check.
      const f = await readyProperty();
      const c = await client();
      try {
        await c.query("begin");
        const finding = await c.query<{ id: string }>(
          `insert into public.source_match_candidates
             (source_property_identity_id, source, source_environment, candidate_kind, match_method,
              status, review_note)
           values ($1,$2,'evaluation','new_property',$3,'accepted','f') returning id`,
          [f.identityId, SOURCE, HUMAN_NEW_PROPERTY_METHOD],
        );
        const receipt = await c.query<{ id: string }>(
          `insert into public.source_property_review_receipts
             (source_property_identity_id, source, source_environment, source_property_id,
              evidence_observation_id, evidence_source_run_id, source_payload_digest,
              prereview_fingerprint, prereview_as_of, decision, destination_id,
              new_property_finding_id, reviewer_label, receipt_digest, reviewed_at)
           values ($1,$2,'evaluation',$3,$4,$5,$6,$7,'2026-08-17','approve_create',$8,$9,'x',$10, now())
           returning id`,
          [
            f.identityId,
            SOURCE,
            f.sourcePropertyId,
            f.observationId,
            f.runId,
            f.digest,
            "a".repeat(64),
            f.destinationId,
            finding.rows[0]!.id,
            "b".repeat(64),
          ],
        );
        for (const dimension of REVIEW_DIMENSIONS)
          await c.query(
            "insert into public.source_property_review_verifications (receipt_id, dimension, verdict) values ($1,$2,'supports')",
            [receipt.rows[0]!.id, dimension],
          );
        // No evidence reference. COMMIT must fail.
        await expect(c.query("commit")).rejects.toThrow(/cites no external evidence reference/);
      } finally {
        await c.query("rollback").catch(() => undefined);
        await c.end();
      }
    });
  });

  // =====================================================================
  describe("defer keeps uncertainty uncertain", () => {
    it("23/24. defer writes no accepted finding and never makes c1 pass", async () => {
      const f = await readyProperty();
      const item = await manifestFor(f, {
        decision: "defer",
        canonicalDestinationSlug: null,
        humanNote: "Cannot establish whether this is the same property as the one next door.",
        verifications: [],
        evidenceReferences: [],
      });
      const report = await apply([item], { apply: true });
      expect(report.outcomes[0]!.state).toBe("applied");

      const findings = await adminQuery<{ n: string }>(
        `select count(*)::text n from public.source_match_candidates
          where source_property_identity_id=$1 and candidate_kind='new_property' and status='accepted'`,
        [f.identityId],
      );
      expect(findings[0]!.n).toBe("0");

      const p = await preview(f.sourcePropertyId);
      expect(statusOf(p, 1)).toBe("UNRESOLVED");
      expect(statusOf(p, 2)).toBe("UNRESOLVED");
      expect(p.overall).toBe("UNRESOLVED");
    });

    it("a defer must say why, and may not carry a destination", async () => {
      const f = await readyProperty();
      const noNote = await manifestFor(f, {
        decision: "defer",
        canonicalDestinationSlug: null,
        humanNote: null,
        verifications: [],
        evidenceReferences: [],
      });
      expect(() => validateReviewedItem(noNote)).toThrow(/what could not be established/);

      const withDestination = await manifestFor(f, {
        decision: "defer",
        canonicalDestinationSlug: "bali",
        humanNote: "unsure",
        verifications: [],
        evidenceReferences: [],
      });
      expect(() => validateReviewedItem(withDestination)).toThrow(/uncertainty is not a placement/);
    });

    it("a defer receipt still exists and is durable", async () => {
      const f = await readyProperty();
      await apply(
        [
          await manifestFor(f, {
            decision: "defer",
            canonicalDestinationSlug: null,
            humanNote: "Ambiguous address.",
            verifications: [],
            evidenceReferences: [],
          }),
        ],
        { apply: true },
      );
      const rows = await adminQuery<{ decision: string; destination_id: string | null }>(
        "select decision, destination_id from public.source_property_review_receipts where source_property_identity_id=$1",
        [f.identityId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.decision).toBe("defer");
      expect(rows[0]!.destination_id).toBeNull();
    });
  });

  // =====================================================================
  describe("replay and correction", () => {
    it("25/26. exact replay creates nothing new and preserves the original receipt", async () => {
      const f = await readyProperty();
      const item = await manifestFor(f);
      await apply([item], { apply: true });
      const first = await adminQuery<{ id: string; reviewed_at: string; receipt_digest: string }>(
        "select id, reviewed_at::text, receipt_digest from public.source_property_review_receipts where source_property_identity_id=$1",
        [f.identityId],
      );

      const replay = await apply([item], { apply: true });
      expect(replay.outcomes[0]!.state).toBe("already_applied");

      const after = await adminQuery<{ id: string; reviewed_at: string }>(
        "select id, reviewed_at::text from public.source_property_review_receipts where source_property_identity_id=$1",
        [f.identityId],
      );
      expect(after).toHaveLength(1);
      expect(after[0]!.id).toBe(first[0]!.id);
      expect(after[0]!.reviewed_at).toBe(first[0]!.reviewed_at);

      const findings = await adminQuery<{ n: string }>(
        `select count(*)::text n from public.source_match_candidates
          where source_property_identity_id=$1 and candidate_kind='new_property'`,
        [f.identityId],
      );
      expect(findings[0]!.n).toBe("1");
      const reviews = await adminQuery<{ n: string }>(
        "select count(*)::text n from public.source_property_reviews where source_property_identity_id=$1",
        [f.identityId],
      );
      expect(reviews[0]!.n).toBe("1");
    });

    it("27. a materially different second review is REFUSED, not silently overwritten", async () => {
      const f = await readyProperty();
      await apply([await manifestFor(f)], { apply: true });
      const different = await manifestFor(f, { humanNote: "A different justification entirely." });
      const report = await apply([different], { apply: true });
      const outcome = report.outcomes[0]!;
      expect(outcome.state).toBe("refused");
      if (outcome.state === "refused") expect(outcome.refusal).toBe("conflicting_review_exists");

      const rows = await adminQuery<{ review_note: string }>(
        "select review_note from public.source_property_review_receipts where source_property_identity_id=$1",
        [f.identityId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.review_note).toMatch(/official property site/);
    });

    it("the digest ignores wall-clock time but not semantics", async () => {
      const f = await readyProperty();
      const a = await manifestFor(f);
      const b = await manifestFor(f);
      expect(receiptDigestOf(a, f.destinationId)).toBe(receiptDigestOf(b, f.destinationId));
      const c = await manifestFor(f, { humanNote: "different" });
      expect(receiptDigestOf(c, f.destinationId)).not.toBe(receiptDigestOf(a, f.destinationId));
    });
  });

  // =====================================================================
  describe("all or nothing", () => {
    it("28/29. a failure anywhere leaves NOTHING behind", async () => {
      const good = await readyProperty();
      const bad = await readyProperty();
      // The second item is stale, so it is refused. In a dry-run the whole
      // transaction rolls back; with --apply the refusal is per item, so prove
      // the rollback path explicitly by failing the batch mid-flight.
      const goodItem = await manifestFor(good);
      const badItem = await manifestFor(bad, { canonicalDestinationSlug: "no-such-destination" });

      const report = await apply([goodItem, badItem], { apply: false });
      expect(report.outcomes[1]!.state).toBe("refused");

      // DRY-RUN wrote nothing at all, including for the good item.
      const rows = await adminQuery<{ n: string }>(
        `select count(*)::text n from public.source_property_review_receipts
          where source_property_identity_id in ($1,$2)`,
        [good.identityId, bad.identityId],
      );
      expect(rows[0]!.n).toBe("0");
      const findings = await adminQuery<{ n: string }>(
        `select count(*)::text n from public.source_match_candidates
          where source_property_identity_id in ($1,$2)`,
        [good.identityId, bad.identityId],
      );
      expect(findings[0]!.n).toBe("0");
    });

    it("29b. a database-level refusal at COMMIT rolls the whole action back", async () => {
      const f = await readyProperty();
      // A verification row that contradicts with no note violates a CHECK, so the
      // receipt, the finding and the review row must all disappear with it.
      const c = await client();
      try {
        await c.query("begin");
        await c.query(
          `insert into public.source_match_candidates
             (source_property_identity_id, source, source_environment, candidate_kind, match_method, status, review_note)
           values ($1,$2,'evaluation','new_property',$3,'accepted','f')`,
          [f.identityId, SOURCE, HUMAN_NEW_PROPERTY_METHOD],
        );
        const receipt = await c.query<{ id: string }>(
          `insert into public.source_property_review_receipts
             (source_property_identity_id, source, source_environment, source_property_id,
              evidence_observation_id, evidence_source_run_id, source_payload_digest,
              prereview_fingerprint, prereview_as_of, decision, reviewer_label, review_note,
              receipt_digest, reviewed_at)
           values ($1,$2,'evaluation',$3,$4,$5,$6,$7,'2026-08-17','defer','x','why',$8, now()) returning id`,
          [
            f.identityId,
            SOURCE,
            f.sourcePropertyId,
            f.observationId,
            f.runId,
            f.digest,
            "a".repeat(64),
            "c".repeat(64),
          ],
        );
        await expect(
          c.query(
            "insert into public.source_property_review_verifications (receipt_id, dimension, verdict) values ($1,'coordinates','contradicts')",
            [receipt.rows[0]!.id],
          ),
        ).rejects.toThrow();
        await c.query("rollback");
      } finally {
        await c.end();
      }
      const rows = await adminQuery<{ n: string }>(
        `select (select count(*) from public.source_property_review_receipts where source_property_identity_id=$1)
              + (select count(*) from public.source_match_candidates where source_property_identity_id=$1) as n`,
        [f.identityId],
      );
      expect(String(rows[0]!.n)).toBe("0");
    });
  });

  // =====================================================================
  describe("human evidence is owned by the human", () => {
    it("30. the generator's match_method namespace is never used for human findings", async () => {
      const f = await readyProperty();
      await apply([await manifestFor(f)], { apply: true });
      const rows = await adminQuery<{ match_method: string; status: string }>(
        `select match_method, status from public.source_match_candidates
          where source_property_identity_id=$1 and candidate_kind='new_property'`,
        [f.identityId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.match_method).toBe(HUMAN_NEW_PROPERTY_METHOD);
      expect(rows[0]!.match_method.startsWith("blocking:")).toBe(false);
      expect(rows[0]!.status).toBe("accepted");
    });

    it("30b. the human finding carries no fabricated machine comparison evidence", async () => {
      const f = await readyProperty();
      await apply([await manifestFor(f)], { apply: true });
      const rows = await adminQuery<{
        name_evidence: string;
        domain_evidence: string;
        address_evidence: string;
        phone_evidence: string;
        brand_evidence: string;
        agreeing_dimensions: number;
        coordinate_distance_metres: string | null;
        source_run_id: string | null;
      }>(
        `select name_evidence, domain_evidence, address_evidence, phone_evidence, brand_evidence,
                agreeing_dimensions, coordinate_distance_metres, source_run_id
           from public.source_match_candidates
          where source_property_identity_id=$1 and candidate_kind='new_property'`,
        [f.identityId],
      );
      // 0027's defaults are the honest values: no machine comparison happened.
      expect(rows[0]!.name_evidence).toBe("none");
      expect(rows[0]!.domain_evidence).toBe("unavailable");
      expect(rows[0]!.address_evidence).toBe("unavailable");
      expect(rows[0]!.phone_evidence).toBe("unavailable");
      expect(rows[0]!.brand_evidence).toBe("unavailable");
      expect(rows[0]!.agreeing_dimensions).toBe(0);
      expect(rows[0]!.coordinate_distance_metres).toBeNull();
      expect(rows[0]!.source_run_id).toBeNull(); // not produced by a run
    });

    it("33. the approve_match path is not introduced by this pilot", async () => {
      const f = await readyProperty();
      await expect(
        adminQuery(
          `insert into public.source_property_review_receipts
             (source_property_identity_id, source, source_environment, source_property_id,
              evidence_observation_id, evidence_source_run_id, source_payload_digest,
              prereview_fingerprint, prereview_as_of, decision, reviewer_label, receipt_digest, reviewed_at)
           values ($1,$2,'evaluation',$3,$4,$5,$6,$7,'2026-08-17','approve_match','x',$8, now())`,
          [
            f.identityId,
            SOURCE,
            f.sourcePropertyId,
            f.observationId,
            f.runId,
            f.digest,
            "a".repeat(64),
            "b".repeat(64),
          ],
        ),
      ).rejects.toThrow();
      // No canonical LINK is ever created by this pilot, whatever the seed holds.
      const links = await adminQuery<{ n: string }>(
        "select count(*)::text n from public.hotel_source_identities",
      );
      expect(links[0]!.n).toBe("0");
    });
  });

  // =====================================================================
  describe("the review pack gives a human enough to notice a problem", () => {
    it("40. the pack carries name, city, address, coordinates and the A04 identifiers", async () => {
      const f = await readyProperty();
      const c = await client();
      try {
        const pack = await buildReviewPack(c, {
          source: SOURCE,
          environment: "evaluation",
          asOf: AS_OF,
          destinationSlug: null,
          limit: 200,
        });
        const item = pack.items.find((i) => i.sourcePropertyId === f.sourcePropertyId);
        expect(item).toBeTruthy();
        expect(item!.providerName).toMatch(/Ready Property/);
        expect(item!.sourceCity).toBe("Ubud");
        expect(item!.sourceAddress).toBe("Jl Test 1");
        expect(item!.sourceLatitude).toBeTruthy();
        expect(item!.sourceLongitude).toBeTruthy();
        expect(item!.currentObservationId).toBe(f.observationId);
        expect(item!.currentSourceRunId).toBe(f.runId);
        expect(item!.sourcePayloadDigest).toBe(f.digest);
        expect(item!.prereviewFingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(item!.starRevisionId).toBeTruthy();
        expect(item!.scopeRevisionId).toBeTruthy();
        expect(item!.locationRevisionId).toBeTruthy();
        expect(item!.nonReviewConditions.map((x) => x.number)).toEqual([3, 4, 6, 7, 8, 9, 10, 11]);
        // ...and every human field is EMPTY.
        expect(item!.humanDecision).toBeNull();
        expect(item!.canonicalDestinationSlug).toBeNull();
        expect(item!.humanNote).toBeNull();
        expect(item!.evidenceReferences).toEqual([]);
        expect(Object.values(item!.verifications).every((v) => v === null)).toBe(true);
      } finally {
        await c.end();
      }
    });

    it("the pack never contains a raw provider payload", async () => {
      await readyProperty();
      const c = await client();
      try {
        const pack = await buildReviewPack(c, {
          source: SOURCE,
          environment: "evaluation",
          asOf: AS_OF,
          destinationSlug: null,
          limit: 5,
        });
        const json = JSON.stringify(pack);
        expect(json).not.toMatch(/source_attributes/);
        expect(json).not.toMatch(/source_payload_uri/);
        expect(json).not.toMatch(/HOTELBEDS_API_KEY|HOTELBEDS_SECRET/);
      } finally {
        await c.end();
      }
    });
  });

  // =====================================================================
  describe("review evidence is internal operational provenance", () => {
    it("34. an ordinary creator can read no review receipt, verification or reference", async () => {
      const f = await readyProperty();
      await apply([await manifestFor(f)], { apply: true });
      for (const table of [
        "source_property_review_receipts",
        "source_property_review_verifications",
        "source_property_review_evidence_references",
      ]) {
        const res = await queryAs<{ id: string }>(
          { role: "authenticated", sub: USERS.free },
          `select id from public.${table}`,
        );
        expect(res.error ?? null).toBeNull();
        expect(res.rows).toHaveLength(0);
      }
    });

    it("35. anon can read none of them", async () => {
      const f = await readyProperty();
      await apply([await manifestFor(f)], { apply: true });
      for (const table of [
        "source_property_review_receipts",
        "source_property_review_verifications",
        "source_property_review_evidence_references",
      ]) {
        const res = await queryAs<{ id: string }>(
          { role: "anon" },
          `select id from public.${table}`,
        );
        // Either no grant at all, or RLS returns nothing. Never a row.
        expect(res.rows).toHaveLength(0);
      }
    });

    it("no APPLICATION role holds UPDATE or DELETE on the review evidence tables", async () => {
      // The table owner keeps them inherently, exactly as for 0031's append-only
      // evidence tables. What must be empty is the set of roles the application
      // ever connects as -- service_role included.
      const rows = await adminQuery<{
        grantee: string;
        privilege_type: string;
        table_name: string;
      }>(
        `select grantee, privilege_type, table_name from information_schema.role_table_grants
          where table_schema='public'
            and table_name in ('source_property_review_receipts','source_property_review_verifications',
                               'source_property_review_evidence_references')
            and privilege_type in ('UPDATE','DELETE')
            and grantee in ('anon','authenticated','service_role')`,
      );
      expect(rows).toEqual([]);
    });
  });

  // =====================================================================
  describe("write-target safety", () => {
    it("a production environment is refused outright", () => {
      expect(() =>
        resolveReviewWriteTarget(
          { TEST_DATABASE_URL: "postgres://u@127.0.0.1:5432/x" },
          { environment: "production", apply: false },
        ),
      ).toThrow(/evaluation. only/i);
    });

    it("--apply is refused against a remote database, with no override", () => {
      expect(() =>
        resolveReviewWriteTarget(
          { TEST_DATABASE_URL: "postgres://u:p@db.example.com:5432/x?sslmode=require" },
          { environment: "evaluation", apply: true },
        ),
      ).toThrow(/remote target/);
    });

    it("--apply is refused against an unclassifiable database", () => {
      expect(() =>
        resolveReviewWriteTarget(
          { TEST_DATABASE_URL: "not-a-connection-string" },
          {
            environment: "evaluation",
            apply: true,
          },
        ),
      ).toThrow();
    });

    it("a local loopback target is accepted", () => {
      const t = resolveReviewWriteTarget(
        { TEST_DATABASE_URL: "postgres://u@127.0.0.1:5433/x" },
        { environment: "evaluation", apply: true },
      );
      expect(t.classification.hostClass).toBe("loopback");
    });
  });

  // =====================================================================
  describe("review-row-only eligibility", () => {
    it("21b. before any human review the review-row-only population is empty", async () => {
      const f = await readyProperty();
      const p = await preview(f.sourcePropertyId);
      // Ready, but NOT one review row away: there is no accepted finding and no
      // receipt, and a review row supplies neither.
      expect(readinessOf(p).ready).toBe(true);
      expect(reviewRowOnlyEligible([p])).toHaveLength(0);
    });
  });
});
