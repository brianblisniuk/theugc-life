/**
 * A04.6 — HUMAN REVIEW REVOCATION (migration 0033 + the revoke path).
 *
 * A04.5 made a human decision durable. This layer answers the question A05 makes
 * urgent and A04.5 deliberately left open:
 *
 *   How can a human withdraw a previous `approve_create` so that it IMMEDIATELY
 *   stops authorizing D062, without modifying the immutable receipt, without
 *   deleting history, and without publishing anything?
 *
 * The suite is organised around the ways that answer goes wrong:
 *
 *   1. A withdrawal that rewrites history. Editing the receipt, or flipping
 *      `decision`, destroys the record of what was actually concluded.
 *   2. A withdrawal that silently comes back. Replaying the original approve
 *      manifest must not read as "authorization restored".
 *   3. A withdrawal aimed at the wrong approval. Every pin is re-checked, so a
 *      manifest prepared against receipt A can never withdraw receipt B.
 *   4. A brake that is disabled exactly when it is needed. Revocation must not
 *      require D062 readiness — a drifted, unready, conflicted identity is the
 *      most likely thing an operator wants to withdraw.
 *   5. A half-applied withdrawal. The revocation row and the projection status
 *      move together or not at all.
 *
 * All fixtures synthetic. No real provider data, and no decision — approve or
 * revoke — about any of the real cached identities appears here.
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "./harness";
import { seed, USERS } from "../rls/seed";
import { loadPreviewResults } from "../../scripts/prepublication-preview/preview";
import {
  applyReviewedManifest,
  receiptDigestOf,
  type ReviewedItem,
} from "../../scripts/human-review/apply";
import { REVIEW_DIMENSIONS } from "../../scripts/human-review/pack";
import { resolveReviewWriteTarget } from "../../scripts/human-review/target";
import {
  applyRevocationManifest,
  revocationDigestOf,
  validateRevocationItem,
  RevocationRefusal,
  type RevocationItem,
} from "../../scripts/human-review-revocation/revoke";
import { buildRevocationPack } from "../../scripts/human-review-revocation/pack";

const d = describe.skipIf(!hasTestDb);
const SOURCE = "hotelbeds";
const AS_OF = "2026-08-17";
const POLICY = {
  provider: "hotelbeds",
  star: "hotelbeds-classification/1",
  scope: "hotelbeds-hospitality-scope/1",
  location: "hotelbeds-location/1",
};
const STAR_CODE = "4EST";
const SCOPE_CODE = "H";

let counter = 0;
const uniq = () => `R${Date.now().toString(36)}${(counter += 1)}`;

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

/** An identity for which every non-review D062 condition passes. */
async function readyProperty(opts?: { slug?: string }): Promise<Fixture> {
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
        source_payload_digest)
     values ($1,$2,$3,'evaluation', now(), $4, 'Ubud', 'Jl Test 1', -8.5, 115.26,
             true, $6, $7, $5)
     returning id`,
    [
      runId,
      identityId,
      SOURCE,
      `Ready Property ${sourcePropertyId}`,
      digest,
      STAR_CODE,
      SCOPE_CODE,
    ],
  );
  const observationId = observation[0]!.id;

  await setStar(identityId, observationId, "exact_four");
  await setScope(identityId, observationId, "physical_hospitality");
  await setLocation(identityId, observationId);
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

async function setLocation(identityId: string, observationId: string): Promise<void> {
  const rev = await adminQuery<{ id: string }>(
    `insert into public.source_property_location_resolution_revisions
       (source_property_identity_id, source, source_environment, evidence_observation_id,
        policy_provider, policy_version, outcome, resolved_latitude, resolved_longitude,
        unresolved_reason, conflict_state)
     values ($1,$2,'evaluation',$3,$4,$5,'resolved',-8.5,115.26,null,'none') returning id`,
    [identityId, SOURCE, observationId, POLICY.provider, POLICY.location],
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
): Promise<{ observationId: string; runId: string; digest: string }> {
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
  await setLocation(f.identityId, observationId);
  await setCompleteLifecycleSnapshot(f.identityId, observationId, runId, digest);
  return { observationId, runId, digest };
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

async function applyReview(items: ReviewedItem[], opts: { apply: boolean }) {
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

async function applyRevocation(items: RevocationItem[], opts: { apply: boolean }) {
  const c = await client();
  try {
    return await applyRevocationManifest(c, items, {
      source: SOURCE,
      environment: "evaluation",
      apply: opts.apply,
    });
  } finally {
    await c.end();
  }
}

/** An identity carrying a real, applied, ACTIVE approve_create. */
async function approvedProperty(): Promise<Fixture & { receiptId: string; reviewId: string }> {
  const f = await readyProperty();
  const report = await applyReview([await manifestFor(f)], { apply: true });
  // Reported with the refusal attached, so a fixture that stops being
  // review-ready says WHY instead of just "not applied".
  const outcome = report.outcomes[0]!;
  expect(
    outcome.state === "applied" ? "applied" : `${outcome.state}: ${JSON.stringify(outcome)}`,
  ).toBe("applied");
  const [row] = await adminQuery<{ id: string; current_receipt_id: string }>(
    "select id, current_receipt_id from public.source_property_reviews where source_property_identity_id = $1",
    [f.identityId],
  );
  return { ...f, reviewId: row!.id, receiptId: row!.current_receipt_id };
}

/**
 * An identity reviewed TWICE: approve A on observation A, then a legitimate new
 * observation B and a fresh approve B. Two receipts, ONE projection, one
 * finding — the shape amendment #1 exists for.
 */
async function advancedTwiceProperty(): Promise<{
  identityId: string;
  sourcePropertyId: string;
  destinationId: string;
  receiptA: string;
  receiptB: string;
  runA: string;
  runB: string;
  observationB: string;
  digestB: string;
  reviewId: string;
}> {
  const a = await approvedProperty();
  const fresh = await advanceToNewObservation(a);
  const p = await preview(a.sourcePropertyId);
  const report = await applyReview(
    [
      await manifestFor(a, {
        currentObservationId: fresh.observationId,
        currentSourceRunId: fresh.runId,
        sourcePayloadDigest: fresh.digest,
        prereviewFingerprint: p.fingerprint,
        humanNote: "Second review, against the newer observation.",
      }),
    ],
    { apply: true },
  );
  expect(report.outcomes[0]!.state).toBe("applied");

  const [row] = await adminQuery<{
    id: string;
    current_receipt_id: string;
    decided_in_run_id: string;
  }>(
    "select id, current_receipt_id, decided_in_run_id from public.source_property_reviews where source_property_identity_id = $1",
    [a.identityId],
  );
  expect(row!.current_receipt_id).not.toBe(a.receiptId);
  expect(row!.decided_in_run_id).toBe(fresh.runId);
  expect((await artefactCounts(a.identityId)).receipts).toBe(2);

  return {
    identityId: a.identityId,
    sourcePropertyId: a.sourcePropertyId,
    destinationId: a.destinationId,
    receiptA: a.receiptId,
    receiptB: row!.current_receipt_id,
    runA: a.runId,
    runB: fresh.runId,
    observationB: fresh.observationId,
    digestB: fresh.digest,
    reviewId: row!.id,
  };
}

/**
 * Run `work` with ONLY the new coherence trigger disabled, so a test can build
 * the corrupted state the production schema refuses to store. Nothing else is
 * relaxed, and the trigger is restored even if `work` throws — the protection is
 * never weakened to make a test convenient.
 */
async function withCoherenceTriggerDisabled(work: () => Promise<void>): Promise<void> {
  await adminQuery(
    "alter table public.source_property_reviews disable trigger source_property_reviews_receipt_coherence",
  );
  try {
    await work();
  } finally {
    await adminQuery(
      "alter table public.source_property_reviews enable trigger source_property_reviews_receipt_coherence",
    );
  }
}

/** A revocation manifest pinned to an arbitrary receipt of a twice-reviewed identity. */
async function revocationForReceipt(
  ab: Awaited<ReturnType<typeof advancedTwiceProperty>>,
  receiptId: string,
): Promise<RevocationItem> {
  const [receipt] = await adminQuery<{ receipt_digest: string; evidence_observation_id: string }>(
    "select receipt_digest, evidence_observation_id from public.source_property_review_receipts where id = $1",
    [receiptId],
  );
  return {
    identityId: ab.identityId,
    sourcePropertyId: ab.sourcePropertyId,
    reviewId: ab.reviewId,
    expectedDecision: "approve_create",
    expectedReviewStatus: "active",
    expectedCurrentReceiptId: receiptId,
    expectedReceiptDigest: receipt!.receipt_digest,
    expectedEvidenceObservationId: receipt!.evidence_observation_id,
    reviewerLabel: "test-reviewer",
    revocationNote: "Withdrawn during an amendment #1 coherence test.",
  };
}

/** The revocation manifest a human would have been handed for `a`. */
async function revocationFor(
  a: Fixture & { receiptId: string; reviewId: string },
  overrides: Partial<RevocationItem> = {},
): Promise<RevocationItem> {
  const [receipt] = await adminQuery<{ receipt_digest: string; evidence_observation_id: string }>(
    "select receipt_digest, evidence_observation_id from public.source_property_review_receipts where id = $1",
    [a.receiptId],
  );
  return {
    identityId: a.identityId,
    sourcePropertyId: a.sourcePropertyId,
    reviewId: a.reviewId,
    expectedDecision: "approve_create",
    expectedReviewStatus: "active",
    expectedCurrentReceiptId: a.receiptId,
    expectedReceiptDigest: receipt!.receipt_digest,
    expectedEvidenceObservationId: receipt!.evidence_observation_id,
    reviewerLabel: "test-reviewer",
    revocationNote: "Withdrawn: the destination assignment was wrong.",
    ...overrides,
  };
}

/** Every byte of the receipt that a revocation must leave alone. */
async function receiptSnapshot(receiptId: string) {
  const [row] = await adminQuery(
    "select * from public.source_property_review_receipts where id = $1",
    [receiptId],
  );
  return row;
}

async function artefactCounts(identityId: string) {
  const [row] = await adminQuery<{
    receipts: string;
    verifications: string;
    references: string;
    findings: string;
    reviews: string;
    revocations: string;
    observations: string;
  }>(
    `select
       (select count(*) from public.source_property_review_receipts
         where source_property_identity_id = $1)::text receipts,
       (select count(*) from public.source_property_review_verifications v
          join public.source_property_review_receipts r on r.id = v.receipt_id
         where r.source_property_identity_id = $1)::text verifications,
       (select count(*) from public.source_property_review_evidence_references e
          join public.source_property_review_receipts r on r.id = e.receipt_id
         where r.source_property_identity_id = $1)::text references,
       (select count(*) from public.source_match_candidates
         where source_property_identity_id = $1 and candidate_kind = 'new_property'
           and status = 'accepted')::text findings,
       (select count(*) from public.source_property_reviews
         where source_property_identity_id = $1)::text reviews,
       (select count(*) from public.source_property_review_revocations
         where source_property_identity_id = $1)::text revocations,
       (select count(*) from public.source_property_observations
         where source_property_identity_id = $1)::text observations`,
    [identityId],
  );
  return {
    receipts: Number(row!.receipts),
    verifications: Number(row!.verifications),
    references: Number(row!.references),
    findings: Number(row!.findings),
    reviews: Number(row!.reviews),
    revocations: Number(row!.revocations),
    observations: Number(row!.observations),
  };
}

async function canonicalWriteCounts() {
  const [row] = await adminQuery<{
    hotels: string;
    links: string;
    contacts: string;
    promoted: string;
    terminal: string;
  }>(
    `select
       (select count(*) from public.hotels)::text hotels,
       (select count(*) from public.hotel_source_identities)::text links,
       (select count(*) from public.hotel_contacts)::text contacts,
       (select count(*) from public.source_property_identities
         where promoted_hotel_id is not null)::text promoted,
       (select count(*) from public.source_property_identities
         where resolution_state <> 'unresolved')::text terminal`,
  );
  return {
    hotels: Number(row!.hotels),
    links: Number(row!.links),
    contacts: Number(row!.contacts),
    promoted: Number(row!.promoted),
    terminal: Number(row!.terminal),
  };
}

async function reviewRow(identityId: string) {
  const [row] = await adminQuery<{
    id: string;
    decision: string;
    review_status: string;
    current_receipt_id: string | null;
    destination_id: string | null;
  }>(
    `select id, decision, review_status, current_receipt_id, destination_id
       from public.source_property_reviews where source_property_identity_id = $1`,
    [identityId],
  );
  return row ?? null;
}

/**
 * Start a revocation and pause it immediately BEFORE the first statement matching
 * `pauseBefore`, so the test decides the interleaving exactly rather than guessing
 * at timing. Every statement — the pins, the inserts and the COMMIT — is proxied.
 */
function startPausedRevocation(
  c: Client,
  items: RevocationItem[],
  pauseBefore: RegExp,
  opts: { apply: boolean } = { apply: true },
) {
  let signalReached!: () => void;
  const reached = new Promise<void>((r) => (signalReached = r));
  let signalRelease!: () => void;
  const gate = new Promise<void>((r) => (signalRelease = r));
  let armed = true;

  const proxy = {
    query: async (...args: unknown[]) => {
      const first = args[0];
      const sql = typeof first === "string" ? first : ((first as { text?: string })?.text ?? "");
      if (armed && pauseBefore.test(sql)) {
        armed = false;
        signalReached();
        await gate;
      }
      return (c.query as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  } as unknown as Client;

  const settled = applyRevocationManifest(proxy, items, {
    source: SOURCE,
    environment: "evaluation",
    apply: opts.apply,
  }).then(
    (report) => ({ ok: true as const, report }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  void settled.then(() => signalReached());

  return { reached, release: () => signalRelease(), connection: c, settled, end: () => c.end() };
}

/** Block until backend `pid` is genuinely waiting on a lock — a condition, not a sleep. */
async function awaitBlockedOnLock(pid: number): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    const [row] = await adminQuery<{ waiting: boolean }>(
      "select (wait_event_type = 'Lock') waiting from pg_stat_activity where pid = $1",
      [pid],
    );
    if (row?.waiting) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`backend ${pid} never blocked on a lock`);
}

d("A04.6 human review revocation (0033)", () => {
  beforeAll(async () => {
    await setupDatabase();
    await seed();
  });
  afterAll(teardownDatabase);

  // =====================================================================
  describe("the withdrawal itself", () => {
    it("1. revoking an active approve_create flips only the STATUS", async () => {
      const a = await approvedProperty();
      const before = await reviewRow(a.identityId);
      expect(before!.review_status).toBe("active");
      expect(before!.current_receipt_id).toBe(a.receiptId);

      const report = await applyRevocation([await revocationFor(a)], { apply: true });
      expect(report.outcomes[0]!.state).toBe("revoked");

      const after = await reviewRow(a.identityId);
      // `decision` still records what the human CONCLUDED. Rewriting it would
      // destroy the audit trail; the status is what says it is no longer valid.
      expect(after!.decision).toBe("approve_create");
      expect(after!.review_status).toBe("revoked");
      // Still pointing at the withdrawn approval, so the record says WHICH one.
      expect(after!.current_receipt_id).toBe(a.receiptId);
      expect(after!.destination_id).toBe(before!.destination_id);
    });

    it("2. the immutable receipt is byte-identical afterwards", async () => {
      const a = await approvedProperty();
      const before = await receiptSnapshot(a.receiptId);
      await applyRevocation([await revocationFor(a)], { apply: true });
      expect(await receiptSnapshot(a.receiptId)).toEqual(before);
    });

    it("3. nothing else is deleted: verifications, references, finding, observation", async () => {
      const a = await approvedProperty();
      const before = await artefactCounts(a.identityId);
      await applyRevocation([await revocationFor(a)], { apply: true });
      const after = await artefactCounts(a.identityId);
      expect(after).toEqual({ ...before, revocations: before.revocations + 1 });
      expect(after.receipts).toBe(1);
      expect(after.findings).toBe(1);
    });

    it("4. the revocation records who, when and WHY", async () => {
      const a = await approvedProperty();
      const item = await revocationFor(a);
      await applyRevocation([item], { apply: true });
      const [row] = await adminQuery<{
        revoked_receipt_id: string;
        reviewer_label: string;
        revocation_note: string;
        revocation_digest: string;
        revoked_at: Date;
        source: string;
        source_environment: string;
      }>(
        "select * from public.source_property_review_revocations where source_property_identity_id = $1",
        [a.identityId],
      );
      expect(row!.revoked_receipt_id).toBe(a.receiptId);
      expect(row!.reviewer_label).toBe("test-reviewer");
      expect(row!.revocation_note).toBe(item.revocationNote);
      expect(row!.revocation_digest).toBe(revocationDigestOf(item));
      expect(row!.source).toBe(SOURCE);
      expect(row!.source_environment).toBe("evaluation");
      expect(row!.revoked_at).toBeInstanceOf(Date);
    });

    it("5. a dry-run proves the same things and writes nothing", async () => {
      const a = await approvedProperty();
      const before = await artefactCounts(a.identityId);
      const report = await applyRevocation([await revocationFor(a)], { apply: false });
      expect(report.outcomes[0]!.state).toBe("would_revoke");
      expect(await artefactCounts(a.identityId)).toEqual(before);
      expect((await reviewRow(a.identityId))!.review_status).toBe("active");
    });

    it("6. revocation writes NO canonical row", async () => {
      const a = await approvedProperty();
      const before = await canonicalWriteCounts();
      const report = await applyRevocation([await revocationFor(a)], { apply: true });
      expect(report.canonicalWrites).toEqual({
        hotels: 0,
        hotelSourceIdentities: 0,
        hotelContacts: 0,
      });
      expect(await canonicalWriteCounts()).toEqual(before);
    });
  });

  // =====================================================================
  describe("D062 stops being authorized immediately", () => {
    it("7. conditions 1 and 2 flip to human_review_revoked and the verdict is UNRESOLVED", async () => {
      const a = await approvedProperty();
      const authorized = await preview(a.sourcePropertyId);
      expect(statusOf(authorized, 1)).toBe("PASS");
      expect(statusOf(authorized, 2)).toBe("PASS");

      await applyRevocation([await revocationFor(a)], { apply: true });

      const after = await preview(a.sourcePropertyId);
      expect(statusOf(after, 1)).toBe("UNRESOLVED");
      expect(reasonOf(after, 1)).toBe("human_review_revoked");
      expect(statusOf(after, 2)).toBe("UNRESOLVED");
      expect(reasonOf(after, 2)).toBe("human_review_revoked");
      expect(after.overall).not.toBe("PASS");
    });

    it("8. condition 5, which derives from 1 and 2, stops passing too", async () => {
      const a = await approvedProperty();
      expect(statusOf(await preview(a.sourcePropertyId), 5)).toBe("PASS");
      await applyRevocation([await revocationFor(a)], { apply: true });
      expect(statusOf(await preview(a.sourcePropertyId), 5)).not.toBe("PASS");
    });
  });

  // =====================================================================
  describe("idempotency and conflicting withdrawals", () => {
    it("9. an exact replay is already_revoked and writes no second row", async () => {
      const a = await approvedProperty();
      const item = await revocationFor(a);
      const first = await applyRevocation([item], { apply: true });
      const firstId = (first.outcomes[0] as { revocationId: string }).revocationId;

      const second = await applyRevocation([item], { apply: true });
      expect(second.outcomes[0]!.state).toBe("already_revoked");
      expect((second.outcomes[0] as { revocationId: string }).revocationId).toBe(firstId);
      expect((await artefactCounts(a.identityId)).revocations).toBe(1);
    });

    it("10. a materially DIFFERENT second withdrawal of the same approval is refused", async () => {
      const a = await approvedProperty();
      await applyRevocation([await revocationFor(a)], { apply: true });
      const report = await applyRevocation(
        [await revocationFor(a, { revocationNote: "A completely different stated reason." })],
        { apply: true },
      );
      const o = report.outcomes[0] as { state: string; refusal: string };
      expect(o.state).toBe("refused");
      expect(o.refusal).toBe("conflicting_revocation_exists");
      expect((await artefactCounts(a.identityId)).revocations).toBe(1);
    });

    it("11. the database refuses a duplicate revocation even if the app did not", async () => {
      const a = await approvedProperty();
      const item = await revocationFor(a);
      await applyRevocation([item], { apply: true });
      await expect(
        adminQuery(
          `insert into public.source_property_review_revocations
             (source_property_identity_id, source, source_environment, revoked_receipt_id,
              reviewer_label, revocation_note, revoked_at, revocation_digest)
           values ($1,$2,'evaluation',$3,'sneaky','second', now(), repeat('a', 64))`,
          [a.identityId, SOURCE, a.receiptId],
        ),
      ).rejects.toThrow(/source_property_review_revocations_receipt_uk/);
    });
  });

  // =====================================================================
  describe("a withdrawal can never be aimed at the wrong approval", () => {
    it("12. a stale receipt pin is refused", async () => {
      const a = await approvedProperty();
      const other = await approvedProperty();
      const report = await applyRevocation(
        [await revocationFor(a, { expectedCurrentReceiptId: other.receiptId })],
        { apply: true },
      );
      const o = report.outcomes[0] as { state: string; refusal: string };
      expect(o.state).toBe("refused");
      expect(o.refusal).toBe("receipt_mismatch");
      expect((await artefactCounts(a.identityId)).revocations).toBe(0);
      expect((await artefactCounts(other.identityId)).revocations).toBe(0);
    });

    it("13. a changed receipt digest is refused", async () => {
      const a = await approvedProperty();
      const report = await applyRevocation(
        [await revocationFor(a, { expectedReceiptDigest: "f".repeat(64) })],
        { apply: true },
      );
      expect((report.outcomes[0] as { refusal: string }).refusal).toBe("receipt_mismatch");
    });

    it("14. a different evidence observation is refused", async () => {
      const a = await approvedProperty();
      const fresh = await advanceToNewObservation(a);
      const report = await applyRevocation(
        [await revocationFor(a, { expectedEvidenceObservationId: fresh.observationId })],
        { apply: true },
      );
      expect((report.outcomes[0] as { refusal: string }).refusal).toBe("receipt_mismatch");
      expect((await reviewRow(a.identityId))!.review_status).toBe("active");
    });

    it("15. naming a review row that is not this identity's projection is refused", async () => {
      const a = await approvedProperty();
      const other = await approvedProperty();
      const report = await applyRevocation([await revocationFor(a, { reviewId: other.reviewId })], {
        apply: true,
      });
      expect((report.outcomes[0] as { refusal: string }).refusal).toBe("stale_review_projection");
    });

    it("16. an identity with no review projection at all is refused", async () => {
      const f = await readyProperty();
      const a = await approvedProperty();
      const report = await applyRevocation(
        [
          await revocationFor(a, {
            identityId: f.identityId,
            sourcePropertyId: f.sourcePropertyId,
          }),
        ],
        { apply: true },
      );
      expect((report.outcomes[0] as { refusal: string }).refusal).toBe("review_not_found");
    });

    it("17. revoking an ALREADY revoked approval under a new receipt pin is refused", async () => {
      const a = await approvedProperty();
      await applyRevocation([await revocationFor(a)], { apply: true });
      const fresh = await advanceToNewObservation(a);
      const report = await applyRevocation(
        [
          await revocationFor(a, {
            expectedCurrentReceiptId: a.receiptId,
            expectedEvidenceObservationId: fresh.observationId,
          }),
        ],
        { apply: true },
      );
      expect((report.outcomes[0] as { refusal: string }).refusal).toBe(
        "conflicting_revocation_exists",
      );
    });
  });

  // =====================================================================
  describe("the manifest itself must be a real human decision", () => {
    it("18. a revocation with no stated reason is refused before the database is touched", () => {
      expect(() =>
        validateRevocationItem({
          identityId: "i",
          sourcePropertyId: "p",
          reviewId: "r",
          expectedDecision: "approve_create",
          expectedReviewStatus: "active",
          expectedCurrentReceiptId: "c",
          expectedReceiptDigest: "d",
          expectedEvidenceObservationId: "o",
          reviewerLabel: "someone",
          revocationNote: "   ",
        }),
      ).toThrow(RevocationRefusal);
    });

    it("19. a revocation with no named reviewer is refused", () => {
      expect(() =>
        validateRevocationItem({
          identityId: "i",
          sourcePropertyId: "p",
          reviewId: "r",
          expectedDecision: "approve_create",
          expectedReviewStatus: "active",
          expectedCurrentReceiptId: "c",
          expectedReceiptDigest: "d",
          expectedEvidenceObservationId: "o",
          reviewerLabel: "",
          revocationNote: "because",
        }),
      ).toThrow(/name the human/);
    });

    it("20. a refusal in one item does not stop the others committing", async () => {
      const good = await approvedProperty();
      const bad = await approvedProperty();
      const report = await applyRevocation(
        [
          await revocationFor(bad, { expectedReceiptDigest: "0".repeat(64) }),
          await revocationFor(good),
        ],
        { apply: true },
      );
      expect((report.outcomes[0] as { refusal: string }).refusal).toBe("receipt_mismatch");
      expect(report.outcomes[1]!.state).toBe("revoked");
      expect((await reviewRow(bad.identityId))!.review_status).toBe("active");
      expect((await reviewRow(good.identityId))!.review_status).toBe("revoked");
      expect((await artefactCounts(bad.identityId)).revocations).toBe(0);
    });
  });

  // =====================================================================
  describe("the brake works when it is most needed", () => {
    it("21. revocation does NOT require D062 review-readiness", async () => {
      const a = await approvedProperty();
      // Break readiness the way reality does: a fresh observation arrives, so the
      // receipt is no longer current and A04 already HOLDS this identity.
      await advanceToNewObservation(a);
      const drifted = await preview(a.sourcePropertyId);
      expect(drifted.overall).not.toBe("PASS");

      const report = await applyRevocation([await revocationFor(a)], { apply: true });
      expect(report.outcomes[0]!.state).toBe("revoked");
      expect((await reviewRow(a.identityId))!.review_status).toBe("revoked");
    });

    it("22. revocation is possible while an entity-resolution conflict is open", async () => {
      const a = await approvedProperty();
      const partner = await readyProperty();
      const [lo, hi] =
        a.identityId < partner.identityId
          ? [a.identityId, partner.identityId]
          : [partner.identityId, a.identityId];
      const [pair] = await adminQuery<{ id: string }>(
        `insert into public.source_match_candidates
           (source_property_identity_id, source, source_environment, candidate_kind,
            candidate_source_property_identity_id, match_method, status)
         values ($1,$2,'evaluation','source_identity',$3,'blocking:exact_phone','pending')
         returning id`,
        [lo, SOURCE, hi],
      );
      try {
        const report = await applyRevocation([await revocationFor(a)], { apply: true });
        expect(report.outcomes[0]!.state).toBe("revoked");
      } finally {
        // An open pending pair fails the ENTITY SYNC GATE for the whole
        // evaluation, not just these two identities, so it must not outlive the
        // test that needed it.
        await adminQuery("delete from public.source_match_candidates where id = $1", [pair!.id]);
      }
    });
  });

  // =====================================================================
  describe("there is no un-revoke", () => {
    it("23. replaying the ORIGINAL approve manifest is refused, not already_applied", async () => {
      const a = await approvedProperty();
      const manifest = await manifestFor(a);
      await applyRevocation([await revocationFor(a)], { apply: true });

      const report = await applyReview([manifest], { apply: true });
      const o = report.outcomes[0] as { state: string; refusal: string };
      expect(o.state).toBe("refused");
      expect(o.refusal).toBe("review_revoked_requires_fresh_observation");

      // And nothing moved: the projection is still revoked, the revocation is
      // still there, and no second receipt was written.
      expect((await reviewRow(a.identityId))!.review_status).toBe("revoked");
      const counts = await artefactCounts(a.identityId);
      expect(counts.revocations).toBe(1);
      expect(counts.receipts).toBe(1);
    });

    it("24. the revoked identity still does not authorize D062 after the replay", async () => {
      const a = await approvedProperty();
      const manifest = await manifestFor(a);
      await applyRevocation([await revocationFor(a)], { apply: true });
      await applyReview([manifest], { apply: true });
      const p = await preview(a.sourcePropertyId);
      expect(reasonOf(p, 1)).toBe("human_review_revoked");
      expect(p.overall).not.toBe("PASS");
    });

    it("25. a defer after a revocation is still refused", async () => {
      const a = await approvedProperty();
      await applyRevocation([await revocationFor(a)], { apply: true });
      const fresh = await advanceToNewObservation(a);
      const p = await preview(a.sourcePropertyId);
      const report = await applyReview(
        [
          await manifestFor(
            { ...a, observationId: fresh.observationId, runId: fresh.runId, digest: fresh.digest },
            {
              currentObservationId: fresh.observationId,
              currentSourceRunId: fresh.runId,
              sourcePayloadDigest: fresh.digest,
              prereviewFingerprint: p.fingerprint,
              decision: "defer",
              canonicalDestinationSlug: null,
              humanNote: "Still unsure after the withdrawal.",
              verifications: REVIEW_DIMENSIONS.map((dimension) => ({
                dimension,
                verdict: "unavailable" as const,
              })),
              evidenceReferences: [],
            },
          ),
        ],
        { apply: true },
      );
      expect((report.outcomes[0] as { refusal: string }).refusal).toBe(
        "defer_after_existing_review_unsupported",
      );
      expect((await reviewRow(a.identityId))!.review_status).toBe("revoked");
    });

    it("26. authorization returns ONLY through a fresh review of a FRESH observation", async () => {
      const a = await approvedProperty();
      await applyRevocation([await revocationFor(a)], { apply: true });
      const fresh = await advanceToNewObservation(a);
      const p = await preview(a.sourcePropertyId);

      const report = await applyReview(
        [
          await manifestFor(a, {
            currentObservationId: fresh.observationId,
            currentSourceRunId: fresh.runId,
            sourcePayloadDigest: fresh.digest,
            prereviewFingerprint: p.fingerprint,
            humanNote: "Re-reviewed after the withdrawal, against the new observation.",
          }),
        ],
        { apply: true },
      );
      expect(report.outcomes[0]!.state).toBe("applied");

      const row = await reviewRow(a.identityId);
      expect(row!.review_status).toBe("active");
      // A NEW receipt, and the old one — plus its revocation — still stand.
      expect(row!.current_receipt_id).not.toBe(a.receiptId);
      const counts = await artefactCounts(a.identityId);
      expect(counts.receipts).toBe(2);
      expect(counts.revocations).toBe(1);
      expect(counts.findings).toBe(1);
      expect(await receiptSnapshot(a.receiptId)).toBeTruthy();

      // And D062 authorizes again, because a human said so about current evidence.
      expect(statusOf(await preview(a.sourcePropertyId), 1)).toBe("PASS");
    });
  });

  // =====================================================================
  describe("0033 schema: the record cannot be edited away", () => {
    it("27. UPDATE on a revocation is refused", async () => {
      const a = await approvedProperty();
      await applyRevocation([await revocationFor(a)], { apply: true });
      await expect(
        adminQuery(
          "update public.source_property_review_revocations set revocation_note = 'rewritten' where source_property_identity_id = $1",
          [a.identityId],
        ),
      ).rejects.toThrow(/APPEND-ONLY/);
    });

    it("28. DELETE on a revocation is refused", async () => {
      const a = await approvedProperty();
      await applyRevocation([await revocationFor(a)], { apply: true });
      await expect(
        adminQuery(
          "delete from public.source_property_review_revocations where source_property_identity_id = $1",
          [a.identityId],
        ),
      ).rejects.toThrow(/APPEND-ONLY/);
    });

    it("29. a revocation with an empty note or reviewer is unstorable", async () => {
      const a = await approvedProperty();
      for (const [label, note] of [
        ["reviewer", "  "],
        ["  ", "note"],
      ] as const) {
        await expect(
          adminQuery(
            `insert into public.source_property_review_revocations
               (source_property_identity_id, source, source_environment, revoked_receipt_id,
                reviewer_label, revocation_note, revoked_at, revocation_digest)
             values ($1,$2,'evaluation',$3,$4,$5, now(), repeat('b', 64))`,
            [a.identityId, SOURCE, a.receiptId, label, note],
          ),
        ).rejects.toThrow(/check constraint/);
      }
    });

    it("30. a revocation may not cite another identity's receipt", async () => {
      const a = await approvedProperty();
      const other = await approvedProperty();
      await expect(
        adminQuery(
          `insert into public.source_property_review_revocations
             (source_property_identity_id, source, source_environment, revoked_receipt_id,
              reviewer_label, revocation_note, revoked_at, revocation_digest)
           values ($1,$2,'evaluation',$3,'r','n', now(), repeat('c', 64))`,
          [a.identityId, SOURCE, other.receiptId],
        ),
      ).rejects.toThrow(/source_property_review_revocations_receipt_fk/);
    });

    it("31. a projection may not point at another identity's receipt", async () => {
      const a = await approvedProperty();
      const other = await approvedProperty();
      const point = () =>
        adminQuery(
          "update public.source_property_reviews set current_receipt_id = $2 where source_property_identity_id = $1",
          [a.identityId, other.receiptId],
        );

      // TWO independent layers refuse this, and the BEFORE trigger from
      // amendment #1 gets there first because it also notices the run and
      // destination disagree.
      await expect(point()).rejects.toThrow(/review_projection_receipt_incoherent/);

      // The composite FK is proven separately, with only the coherence trigger
      // stood down, so "the trigger caught it" never hides a missing FK.
      await withCoherenceTriggerDisabled(async () => {
        await expect(point()).rejects.toThrow(/source_property_reviews_current_receipt_fk/);
      });
    });

    it("32. review_status accepts only active/revoked", async () => {
      const a = await approvedProperty();
      await expect(
        adminQuery(
          "update public.source_property_reviews set review_status = 'cancelled' where source_property_identity_id = $1",
          [a.identityId],
        ),
      ).rejects.toThrow(/review_status/);
    });

    it("33. the digest column only accepts a sha256 hex digest", async () => {
      const a = await approvedProperty();
      await expect(
        adminQuery(
          `insert into public.source_property_review_revocations
             (source_property_identity_id, source, source_environment, revoked_receipt_id,
              reviewer_label, revocation_note, revoked_at, revocation_digest)
           values ($1,$2,'evaluation',$3,'r','n', now(), 'not-a-digest')`,
          [a.identityId, SOURCE, a.receiptId],
        ),
      ).rejects.toThrow(/revocation_digest/);
    });

    it("34. an A04.5 approve_create is backfilled to active with its receipt bound", async () => {
      const a = await approvedProperty();
      const row = await reviewRow(a.identityId);
      // 0033's backfill binds on RUN PROVENANCE, and the apply path now sets the
      // same value directly. Both must agree with the receipt that actually
      // exists for the reviewed observation.
      const [receipt] = await adminQuery<{ id: string }>(
        `select r.id from public.source_property_review_receipts r
           join public.source_property_reviews rv
             on rv.source_property_identity_id = r.source_property_identity_id
            and rv.decided_in_run_id = r.evidence_source_run_id
          where r.source_property_identity_id = $1`,
        [a.identityId],
      );
      expect(row!.review_status).toBe("active");
      expect(row!.current_receipt_id).toBe(receipt!.id);
    });
  });

  // =====================================================================
  describe("who may see a withdrawal", () => {
    it("35. anon may not read revocations", async () => {
      const a = await approvedProperty();
      await applyRevocation([await revocationFor(a)], { apply: true });
      const res = await queryAs(
        { role: "anon" },
        "select id from public.source_property_review_revocations",
      );
      expect(res.error ?? { code: "" }).toBeTruthy();
      expect(res.rows.length).toBe(0);
    });

    it("36. an ordinary creator sees nothing", async () => {
      const a = await approvedProperty();
      await applyRevocation([await revocationFor(a)], { apply: true });
      const res = await queryAs(
        { role: "authenticated", sub: USERS.free },
        "select id from public.source_property_review_revocations",
      );
      expect(res.rows.length).toBe(0);
    });

    it("37. an editor may read them", async () => {
      const a = await approvedProperty();
      await applyRevocation([await revocationFor(a)], { apply: true });
      const res = await queryAs<{ id: string }>(
        { role: "authenticated", sub: USERS.editor },
        "select id from public.source_property_review_revocations where source_property_identity_id = $1",
        [a.identityId],
      );
      expect(res.error).toBeNull();
      expect(res.rows.length).toBe(1);
    });

    it("38. no application role holds UPDATE or DELETE on revocations", async () => {
      const rows = await adminQuery<{ grantee: string; privilege_type: string }>(
        `select grantee, privilege_type from information_schema.role_table_grants
          where table_schema = 'public' and table_name = 'source_property_review_revocations'
            and privilege_type in ('UPDATE', 'DELETE')
            and grantee in ('anon', 'authenticated', 'service_role')`,
      );
      expect(rows).toEqual([]);
    });

    it("39. anon holds no grant on revocations at all", async () => {
      const rows = await adminQuery(
        `select privilege_type from information_schema.role_table_grants
          where table_schema = 'public' and table_name = 'source_property_review_revocations'
            and grantee = 'anon'`,
      );
      expect(rows).toEqual([]);
    });
  });

  // =====================================================================
  describe("the operational path", () => {
    it("40. the prepare pack pins the approval and leaves the human fields EMPTY", async () => {
      const a = await approvedProperty();
      const c = await client();
      try {
        const pack = await buildRevocationPack(c, {
          source: SOURCE,
          environment: "evaluation",
          identityId: a.identityId,
        });
        expect(pack.items.length).toBe(1);
        const item = pack.items[0]!;
        expect(item.expectedCurrentReceiptId).toBe(a.receiptId);
        expect(item.reviewId).toBe(a.reviewId);
        expect(item.expectedReviewStatus).toBe("active");
        expect(item.reviewerLabel).toBe("");
        expect(item.revocationNote).toBe("");
        expect(item.reviewerUserId).toBeNull();
      } finally {
        await c.end();
      }
    });

    it("41. an unedited pack is refused, because nobody decided anything", async () => {
      const a = await approvedProperty();
      const c = await client();
      try {
        const pack = await buildRevocationPack(c, {
          source: SOURCE,
          environment: "evaluation",
          identityId: a.identityId,
        });
        await expect(
          applyRevocationManifest(c, pack.items as unknown as RevocationItem[], {
            source: SOURCE,
            environment: "evaluation",
            apply: true,
          }),
        ).rejects.toThrow(RevocationRefusal);
      } finally {
        await c.end();
      }
      expect((await artefactCounts(a.identityId)).revocations).toBe(0);
    });

    it("42. an already-revoked approval disappears from the pack", async () => {
      const a = await approvedProperty();
      await applyRevocation([await revocationFor(a)], { apply: true });
      const c = await client();
      try {
        const pack = await buildRevocationPack(c, {
          source: SOURCE,
          environment: "evaluation",
          identityId: a.identityId,
        });
        expect(pack.items).toEqual([]);
      } finally {
        await c.end();
      }
    });

    it("43. a revoke --apply to a remote target is refused, with no override", () => {
      expect(() =>
        resolveReviewWriteTarget(
          { TEST_DATABASE_URL: "postgresql://u:p@db.example.supabase.co:5432/postgres" },
          { environment: "evaluation", apply: true },
        ),
      ).toThrow(/remote target/);
    });
  });

  // =====================================================================
  // CONCURRENCY. No sleeps: each test pauses the revocation at a named statement
  // boundary and decides the interleaving itself.
  // =====================================================================
  describe("concurrency", () => {
    it("44. two concurrent revocations of the same approval: exactly one is recorded", async () => {
      const a = await approvedProperty();
      const item = await revocationFor(a);
      const c1 = await client();
      const c2 = await client();
      const secondPid = (await c2.query<{ pid: number }>("select pg_backend_pid() pid")).rows[0]!
        .pid;

      // A holds the projection lock, paused just before its own insert.
      const first = startPausedRevocation(
        c1,
        [item],
        /insert into public\.source_property_review_revocations/,
      );
      await first.reached;

      // B starts and blocks on `for update of rv` — a real lock wait, observed in
      // pg_stat_activity rather than guessed at with a sleep.
      const second = applyRevocationManifest(c2, [item], {
        source: SOURCE,
        environment: "evaluation",
        apply: true,
      }).then(
        (report) => ({ ok: true as const, report }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await awaitBlockedOnLock(secondPid);

      first.release();
      const firstResult = await first.settled;
      const secondResult = await second;
      await first.end();
      await c2.end();

      expect(firstResult.ok).toBe(true);
      if (firstResult.ok) expect(firstResult.report.outcomes[0]!.state).toBe("revoked");

      // B does NOT quietly succeed, and does NOT quietly become a no-op. It
      // aborts, because the row it made its decision against changed underneath
      // it, and retrying would re-run a human decision against a snapshot the
      // human never saw.
      expect(secondResult.ok).toBe(false);
      if (!secondResult.ok) {
        expect(secondResult.error).toBeInstanceOf(RevocationRefusal);
        expect((secondResult.error as RevocationRefusal).refusal).toBe(
          "evidence_changed_concurrently",
        );
      }

      expect((await artefactCounts(a.identityId)).revocations).toBe(1);
      expect((await reviewRow(a.identityId))!.review_status).toBe("revoked");
    });

    it("45. a revocation racing a fresh-observation re-approval: the re-approval aborts", async () => {
      const a = await approvedProperty();
      const item = await revocationFor(a);

      // Everything the racing re-approval needs is prepared BEFORE the race, so
      // the only thing overlapping is the write itself.
      const fresh = await advanceToNewObservation(a);
      const p = await preview(a.sourcePropertyId);
      const reapprovalManifest = await manifestFor(a, {
        currentObservationId: fresh.observationId,
        currentSourceRunId: fresh.runId,
        sourcePayloadDigest: fresh.digest,
        prereviewFingerprint: p.fingerprint,
        humanNote: "Racing re-approval.",
      });

      const c1 = await client();
      const c2 = await client();
      const reapprovalPid = (await c2.query<{ pid: number }>("select pg_backend_pid() pid"))
        .rows[0]!.pid;

      const paused = startPausedRevocation(
        c1,
        [item],
        /insert into public\.source_property_review_revocations/,
      );
      await paused.reached;

      const reapproval = applyReviewedManifest(c2, [reapprovalManifest], {
        source: SOURCE,
        environment: "evaluation",
        asOf: AS_OF,
        apply: true,
      }).then(
        (report) => ({ ok: true as const, report }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await awaitBlockedOnLock(reapprovalPid);

      paused.release();
      const revocationResult = await paused.settled;
      const reapprovalResult = await reapproval;
      await paused.end();
      await c2.end();

      expect(revocationResult.ok).toBe(true);
      // The re-approval is NOT silently applied on top of a withdrawal it never
      // saw. It aborts, and the operator re-prepares against the revoked state —
      // at which point the §14 guard tells them what actually happened.
      expect(reapprovalResult.ok).toBe(false);

      const row = await reviewRow(a.identityId);
      const counts = await artefactCounts(a.identityId);
      expect(row!.review_status).toBe("revoked");
      expect(row!.current_receipt_id).toBe(a.receiptId);
      expect(counts.revocations).toBe(1);
      expect(counts.receipts).toBe(1);
    });

    it("46. a revocation is never retried behind the human's back", async () => {
      const a = await approvedProperty();
      const item = await revocationFor(a);

      // A COMMIT that reports a serialization failure must surface as a refusal,
      // not silently re-run the decision against a snapshot nobody looked at.
      const c = await client();
      let commits = 0;
      const proxy = {
        query: async (...args: unknown[]) => {
          const first = args[0];
          const sql =
            typeof first === "string" ? first : ((first as { text?: string })?.text ?? "");
          if (sql.trim() === "commit") {
            commits += 1;
            throw Object.assign(new Error("could not serialize access"), { code: "40001" });
          }
          return (c.query as (...x: unknown[]) => Promise<unknown>)(...args);
        },
      } as unknown as Client;

      await expect(
        applyRevocationManifest(proxy, [item], {
          source: SOURCE,
          environment: "evaluation",
          apply: true,
        }),
      ).rejects.toThrow(/evidence_changed_concurrently|changed by a concurrent transaction/);
      await c.end();

      expect(commits).toBe(1);
      expect((await artefactCounts(a.identityId)).revocations).toBe(0);
      expect((await reviewRow(a.identityId))!.review_status).toBe("active");
    });
  });

  // =====================================================================
  // AMENDMENT #1 — PROJECTION ↔ RECEIPT COHERENCE
  //
  // `current_receipt_id` is supposed to name the receipt this projection IS.
  // 0033's composite FK only proves the receipt belongs to the same IDENTITY,
  // and an identity legitimately accumulates one receipt per reviewed
  // observation. So "same identity" permitted a projection advanced onto run B
  // to be pointed back at receipt A — schema-valid, and an authorization A05
  // could have consumed while the current human record named something else.
  // =====================================================================
  describe("the projection must BE the receipt it names", () => {
    it("47. an A→B identity's pointer cannot be moved back to the older receipt", async () => {
      const ab = await advancedTwiceProperty();

      // The state the fix must forbid. Everything else is left alone: both
      // receipts, both runs, the destination, the decision, the finding.
      await expect(
        adminQuery(
          "update public.source_property_reviews set current_receipt_id = $2 where source_property_identity_id = $1",
          [ab.identityId, ab.receiptA],
        ),
      ).rejects.toThrow(/review_projection_receipt_incoherent/);

      // And the pre-fix escape hatch is proven closed for the right reason:
      // receipt A really does belong to this identity, so the composite FK
      // alone would have accepted the pointer.
      const [owner] = await adminQuery<{ n: string }>(
        `select count(*)::text n from public.source_property_review_receipts
          where id = $1 and source_property_identity_id = $2`,
        [ab.receiptA, ab.identityId],
      );
      expect(Number(owner!.n)).toBe(1);

      const row = await reviewRow(ab.identityId);
      expect(row!.current_receipt_id).toBe(ab.receiptB);
      expect(row!.review_status).toBe("active");
    });

    it("48. the A→B identity is a real 11/11 PASS before and after the attempt", async () => {
      const ab = await advancedTwiceProperty();
      const before = await preview(ab.sourcePropertyId);
      expect(before.overall).toBe("PASS");
      expect(before.conditions.every((c) => c.status === "PASS")).toBe(true);

      await adminQuery(
        "update public.source_property_reviews set current_receipt_id = $2 where source_property_identity_id = $1",
        [ab.identityId, ab.receiptA],
      ).catch(() => undefined);

      const after = await preview(ab.sourcePropertyId);
      expect(after.overall).toBe("PASS");
      expect(after.fingerprint).toBe(before.fingerprint);
    });

    it("49. moving decided_in_run_id alone breaks coherence and is refused", async () => {
      const ab = await advancedTwiceProperty();
      await expect(
        adminQuery(
          "update public.source_property_reviews set decided_in_run_id = $2 where source_property_identity_id = $1",
          [ab.identityId, ab.runA],
        ),
      ).rejects.toThrow(/review_projection_receipt_incoherent/);
    });

    it("50. moving destination_id alone breaks coherence and is refused", async () => {
      const a = await approvedProperty();
      const other = await destination("dubai");
      await expect(
        adminQuery(
          "update public.source_property_reviews set destination_id = $2 where source_property_identity_id = $1",
          [a.identityId, other],
        ),
      ).rejects.toThrow(/review_projection_receipt_incoherent/);
    });

    it("51. the trigger fires on INSERT, not only on UPDATE", async () => {
      const a = await approvedProperty();
      const fresh = await readyProperty();
      // A hand-written projection for a different identity's receipt is already
      // stopped by the composite FK; this one is same-identity-shaped but names
      // a run and destination the receipt does not carry.
      await expect(
        adminQuery(
          `insert into public.source_property_reviews
             (source_property_identity_id, source, source_environment, decision, destination_id,
              reviewer_label, decided_in_run_id, review_status, current_receipt_id)
           values ($1,$2,'evaluation','approve_create',$3,'hand-written',$4,'active',$5)`,
          [a.identityId, SOURCE, a.destinationId, fresh.runId, a.receiptId],
        ),
      ).rejects.toThrow(/source_property_reviews|review_projection_receipt_incoherent/);
    });

    it("52. a REVOKED projection keeps pointing at the receipt that was withdrawn", async () => {
      const a = await approvedProperty();
      await applyRevocation([await revocationFor(a)], { apply: true });
      const row = await reviewRow(a.identityId);
      // Status is deliberately NOT part of the coherence predicate: the whole
      // point of the record is that it still names the approval that was pulled.
      expect(row!.review_status).toBe("revoked");
      expect(row!.current_receipt_id).toBe(a.receiptId);
    });

    it("53. a legacy NULL pointer is allowed, and may NOT borrow an existing receipt", async () => {
      const a = await approvedProperty();
      // NULL is honest legacy state, so the trigger permits it...
      await adminQuery(
        "update public.source_property_reviews set current_receipt_id = null where source_property_identity_id = $1",
        [a.identityId],
      );
      expect((await reviewRow(a.identityId))!.current_receipt_id).toBeNull();
      expect((await artefactCounts(a.identityId)).receipts).toBe(1);

      // ...and D062 refuses to treat "a receipt exists" as authorization.
      const p = await preview(a.sourcePropertyId);
      expect(reasonOf(p, 1)).toBe("human_review_projection_receipt_missing");
      expect(reasonOf(p, 2)).toBe("human_review_projection_receipt_missing");
      expect(statusOf(p, 5)).not.toBe("PASS");
      expect(p.overall).not.toBe("PASS");
    });
  });

  // =====================================================================
  describe("the operational path defends itself too", () => {
    it("54. the pack excludes an incoherent projection and REPORTS it", async () => {
      const ab = await advancedTwiceProperty();
      await withCoherenceTriggerDisabled(async () => {
        await adminQuery(
          "update public.source_property_reviews set current_receipt_id = $2 where source_property_identity_id = $1",
          [ab.identityId, ab.receiptA],
        );
      });

      const c = await client();
      try {
        const pack = await buildRevocationPack(c, {
          source: SOURCE,
          environment: "evaluation",
          identityId: ab.identityId,
        });
        expect(pack.items).toEqual([]);
        expect(pack.preparedFrom.activeApprovals).toBe(1);
        expect(pack.preparedFrom.incoherentProjections).toBe(1);
        expect(pack.preparedFrom.incoherentIdentityIds).toEqual([ab.identityId]);
        // Not counted as "no receipt to pin" — it HAS a pointer; the pointer is
        // the problem, and the two diagnoses must not be conflated.
        expect(pack.preparedFrom.withoutReceipt).toBe(0);
      } finally {
        await c.end();
      }
    });

    it("55. revocation apply refuses an incoherent projection before any write", async () => {
      const ab = await advancedTwiceProperty();
      // The manifest a human would have been handed BEFORE the pointer moved:
      // correctly pinned to receipt B, the approval that was current.
      const item = await revocationForReceipt(ab, ab.receiptB);

      await withCoherenceTriggerDisabled(async () => {
        await adminQuery(
          "update public.source_property_reviews set current_receipt_id = $2 where source_property_identity_id = $1",
          [ab.identityId, ab.receiptA],
        );
      });

      const report = await applyRevocation([item], { apply: true });
      const o = report.outcomes[0] as { state: string; refusal: string };
      expect(o.state).toBe("refused");
      // `receipt_mismatch` fires first here — the manifest pinned B and the
      // projection now says A — and that is correct: either way NOTHING is
      // written, and the withdrawal is never aimed at an approval the current
      // review does not claim.
      expect(["receipt_mismatch", "review_projection_receipt_mismatch"]).toContain(o.refusal);

      const counts = await artefactCounts(ab.identityId);
      expect(counts.revocations).toBe(0);
      expect(counts.receipts).toBe(2);
      expect(counts.findings).toBe(1);
      expect((await reviewRow(ab.identityId))!.review_status).toBe("active");
      expect(await canonicalWriteCounts()).toEqual(await canonicalWriteCounts());
    });

    it("56. revocation apply refuses when the manifest matches the incoherent pointer too", async () => {
      const ab = await advancedTwiceProperty();
      await withCoherenceTriggerDisabled(async () => {
        await adminQuery(
          "update public.source_property_reviews set current_receipt_id = $2 where source_property_identity_id = $1",
          [ab.identityId, ab.receiptA],
        );
      });

      // Now the manifest agrees with the corrupted pointer — every A04.6 pin
      // matches. Only the projection/receipt coherence check can catch this, and
      // it must, because revoking receipt A would record that the wrong approval
      // was withdrawn while the projection still authorizes run B's decision.
      const item = await revocationForReceipt(ab, ab.receiptA);
      const report = await applyRevocation([item], { apply: true });
      const o = report.outcomes[0] as { state: string; refusal: string };
      expect(o.state).toBe("refused");
      expect(o.refusal).toBe("review_projection_receipt_mismatch");

      const counts = await artefactCounts(ab.identityId);
      expect(counts.revocations).toBe(0);
      expect(counts.receipts).toBe(2);
      expect(counts.verifications).toBe(12);
      expect(counts.findings).toBe(1);
      expect((await reviewRow(ab.identityId))!.review_status).toBe("active");
    });

    it("57. D062 fails closed on the same corrupted state, independently", async () => {
      const ab = await advancedTwiceProperty();
      await withCoherenceTriggerDisabled(async () => {
        await adminQuery(
          "update public.source_property_reviews set current_receipt_id = $2 where source_property_identity_id = $1",
          [ab.identityId, ab.receiptA],
        );
      });

      const p = await preview(ab.sourcePropertyId);
      expect(reasonOf(p, 1)).toBe("human_review_projection_receipt_mismatch");
      expect(reasonOf(p, 2)).toBe("human_review_projection_receipt_mismatch");
      expect(statusOf(p, 5)).not.toBe("PASS");
      expect(p.overall).not.toBe("PASS");
    });
  });

  // =====================================================================
  describe("the full withdrawal-and-return lifecycle", () => {
    it("58. revoked A → fresh observation B → active PASS, with history intact", async () => {
      const a = await approvedProperty();
      expect((await preview(a.sourcePropertyId)).overall).toBe("PASS");

      await applyRevocation([await revocationFor(a)], { apply: true });
      const revoked = await preview(a.sourcePropertyId);
      expect(reasonOf(revoked, 1)).toBe("human_review_revoked");
      expect(revoked.overall).not.toBe("PASS");

      const fresh = await advanceToNewObservation(a);
      const p = await preview(a.sourcePropertyId);
      const report = await applyReview(
        [
          await manifestFor(a, {
            currentObservationId: fresh.observationId,
            currentSourceRunId: fresh.runId,
            sourcePayloadDigest: fresh.digest,
            prereviewFingerprint: p.fingerprint,
            humanNote: "Re-reviewed after the withdrawal, against the new observation.",
          }),
        ],
        { apply: true },
      );
      expect(report.outcomes[0]!.state).toBe("applied");

      const after = await preview(a.sourcePropertyId);
      expect(after.conditions.every((c) => c.status === "PASS")).toBe(true);
      expect(after.overall).toBe("PASS");

      const row = await reviewRow(a.identityId);
      const counts = await artefactCounts(a.identityId);
      expect(row!.review_status).toBe("active");
      expect(row!.current_receipt_id).not.toBe(a.receiptId);
      expect(counts.receipts).toBe(2);
      expect(counts.revocations).toBe(1);
      expect(counts.reviews).toBe(1);
      expect(counts.findings).toBe(1);

      // Receipt A and its revocation are both untouched history.
      expect(await receiptSnapshot(a.receiptId)).toBeTruthy();
      const [rev] = await adminQuery<{ revoked_receipt_id: string }>(
        "select revoked_receipt_id from public.source_property_review_revocations where source_property_identity_id = $1",
        [a.identityId],
      );
      expect(rev!.revoked_receipt_id).toBe(a.receiptId);

      // And the pointer cannot be walked back to the revoked approval.
      await expect(
        adminQuery(
          "update public.source_property_reviews set current_receipt_id = $2 where source_property_identity_id = $1",
          [a.identityId, a.receiptId],
        ),
      ).rejects.toThrow(/review_projection_receipt_incoherent/);
      expect((await reviewRow(a.identityId))!.review_status).toBe("active");
    });
  });
});
