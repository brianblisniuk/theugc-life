/**
 * A04.5 REVIEW APPLY — one human decision becomes durable evidence, atomically.
 *
 * An `approve_create` needs BOTH artefacts, and they are written as one action:
 *
 *   A) the accepted, HUMAN-OWNED `new_property` finding
 *   B) the `source_property_reviews` decision naming the canonical destination
 *
 * plus the immutable receipt that binds them to the exact observation reviewed.
 * Neither artefact alone means anything: a review row without a finding is a
 * decision with no supporting entity evidence, and a finding without a review is
 * a claim nobody signed.
 *
 * Everything below happens inside ONE transaction. If any step fails the whole
 * thing rolls back — no orphan finding, no review row without its receipt, no
 * receipt claiming a decision that did not become current.
 */
import { createHash } from "node:crypto";
import type { Client } from "pg";

import { composeAllPreviewResultsInSnapshot } from "../prepublication-preview/preview";
import type { PreviewResult } from "../prepublication-preview/evaluate";
import { readinessOf } from "./readiness";
import { REVIEW_DIMENSIONS, type ReviewDimension, type ReviewVerdict } from "./pack";

/**
 * The match_method namespace for human findings.
 *
 * `blocking:*` is the generator's. A human finding written under it would claim
 * a machine discovered something it never did, and the stand-down sweep in
 * 0030/A02 — which only touches `blocking:%` rows — would later supersede a
 * human decision as though it were a stale machine guess.
 */
export const HUMAN_NEW_PROPERTY_METHOD = "human_review:distinct_property" as const;
export const GENERATOR_METHOD_PREFIX = "blocking:" as const;

export interface ReviewedVerification {
  dimension: ReviewDimension;
  verdict: ReviewVerdict;
  note?: string | null;
}

export interface ReviewedEvidenceReference {
  referenceKind: string;
  locator: string;
  bearsOnDimensions: ReviewDimension[];
  stance: "supports" | "contradicts";
  note?: string | null;
}

/** One reviewed item: the pack's pins, plus what the human decided. */
export interface ReviewedItem {
  identityId: string;
  sourcePropertyId: string;
  currentObservationId: string;
  currentSourceRunId: string;
  sourcePayloadDigest: string;
  prereviewFingerprint: string;
  prereviewAsOf: string;

  decision: "approve_create" | "defer";
  canonicalDestinationSlug: string | null;
  reviewerLabel: string;
  reviewerUserId?: string | null;
  humanNote: string | null;
  verifications: ReviewedVerification[];
  evidenceReferences: ReviewedEvidenceReference[];
}

export type ApplyOutcome =
  | {
      identityId: string;
      sourcePropertyId: string;
      state: "would_apply" | "applied";
      receiptId: string | null;
    }
  | { identityId: string; sourcePropertyId: string; state: "already_applied"; receiptId: string }
  | {
      identityId: string;
      sourcePropertyId: string;
      state: "refused";
      refusal: string;
      detail: string;
    };

export interface ApplyReport {
  apply: boolean;
  outcomes: ApplyOutcome[];
  canonicalWrites: { hotels: 0; hotelSourceIdentities: 0; hotelContacts: 0 };
}

export class ReviewRefusal extends Error {
  constructor(
    readonly refusal: string,
    message: string,
  ) {
    super(message);
    this.name = "ReviewRefusal";
  }
}

/**
 * The semantic content digest of a decision. Two applies of the SAME decision
 * about the SAME evidence produce the same digest; anything materially different
 * produces a different one and is refused rather than silently overwriting.
 *
 * `reviewedAt` is deliberately excluded: re-running the identical manifest must
 * not be called "different" merely because the clock moved.
 */
export function receiptDigestOf(item: ReviewedItem, destinationId: string | null): string {
  const canonical = {
    identityId: item.identityId,
    observationId: item.currentObservationId,
    runId: item.currentSourceRunId,
    payloadDigest: item.sourcePayloadDigest,
    prereviewFingerprint: item.prereviewFingerprint,
    prereviewAsOf: item.prereviewAsOf,
    decision: item.decision,
    destinationId,
    reviewerLabel: item.reviewerLabel,
    humanNote: item.humanNote ?? null,
    verifications: [...item.verifications]
      .sort((a, b) => (a.dimension < b.dimension ? -1 : a.dimension > b.dimension ? 1 : 0))
      .map((v) => [v.dimension, v.verdict, v.note ?? null]),
    evidenceReferences: [...item.evidenceReferences]
      .map((r) => [
        r.referenceKind,
        r.locator,
        [...r.bearsOnDimensions].sort(),
        r.stance,
        r.note ?? null,
      ])
      .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Shape rules a manifest must satisfy before the database is touched at all. */
export function validateReviewedItem(item: ReviewedItem): void {
  if (item.decision === "defer") {
    if (!item.humanNote || item.humanNote.trim() === "")
      throw new ReviewRefusal(
        "defer_requires_note",
        "A defer must say what could not be established.",
      );
    if (item.canonicalDestinationSlug)
      throw new ReviewRefusal(
        "defer_carries_destination",
        "A defer must not name a canonical destination; uncertainty is not a placement.",
      );
    return;
  }

  if (!item.canonicalDestinationSlug)
    throw new ReviewRefusal(
      "approve_create_requires_destination",
      "approve_create must name a supported canonical destination. It is never inferred from provider geography.",
    );

  const seen = new Map<string, ReviewedVerification>();
  for (const v of item.verifications) {
    if (!REVIEW_DIMENSIONS.includes(v.dimension))
      throw new ReviewRefusal(
        "unknown_dimension",
        `Unknown review dimension ${JSON.stringify(v.dimension)}.`,
      );
    if (seen.has(v.dimension))
      throw new ReviewRefusal("duplicate_dimension", `Dimension ${v.dimension} recorded twice.`);
    if (v.verdict === "contradicts" && (!v.note || v.note.trim() === ""))
      throw new ReviewRefusal(
        "contradiction_requires_note",
        `Dimension ${v.dimension} contradicts and must carry the reviewer's explanation.`,
      );
    seen.set(v.dimension, v);
  }
  for (const d of REVIEW_DIMENSIONS) {
    if (!seen.has(d))
      throw new ReviewRefusal(
        "dimension_missing",
        `Dimension ${d} has no recorded state. A dimension whose provider field is NULL is recorded as unavailable, never omitted.`,
      );
  }
  if (seen.get("distinct_property")!.verdict !== "supports")
    throw new ReviewRefusal(
      "distinct_property_not_affirmative",
      "approve_create requires an affirmative distinct-property verdict. No conflict is not the same as positive new-property evidence.",
    );
  if (seen.get("destination_membership")!.verdict !== "supports")
    throw new ReviewRefusal(
      "destination_membership_not_affirmative",
      "approve_create requires an affirmative destination-membership verdict.",
    );
  if (item.evidenceReferences.length < 1)
    throw new ReviewRefusal(
      "no_evidence_reference",
      "approve_create must cite at least one external evidence reference the human actually consulted.",
    );
  for (const r of item.evidenceReferences) {
    if (!r.locator || r.locator.trim() === "")
      throw new ReviewRefusal(
        "evidence_reference_empty_locator",
        "An evidence reference needs a locator.",
      );
    if (r.bearsOnDimensions.length < 1)
      throw new ReviewRefusal(
        "evidence_reference_no_dimension",
        "An evidence reference must say which dimension(s) it bears on.",
      );
  }
}

interface CurrentState {
  identityId: string;
  sourcePropertyId: string;
  source: string;
  environment: string;
  observationId: string;
  runId: string;
  payloadDigest: string;
}

/**
 * Apply one reviewed manifest. Dry-run unless `apply` is true — and in dry-run
 * the transaction is rolled back, so the same code path proves the same things
 * without leaving anything behind.
 */
export async function applyReviewedManifest(
  client: Client,
  items: readonly ReviewedItem[],
  opts: { source: string; environment: "evaluation" | "production"; asOf: string; apply: boolean },
): Promise<ApplyReport> {
  for (const item of items) validateReviewedItem(item);

  const outcomes: ApplyOutcome[] = [];
  await client.query("begin");
  try {
    // Recompute the CURRENT preview inside this transaction. Everything the
    // manifest pinned is compared against what is true right now, in one
    // consistent read, so nothing can move between the check and the write.
    const results = await composeAllPreviewResultsInSnapshot(client, opts);
    const byIdentity = new Map(results.map((r) => [r.identityId, r]));

    for (const item of items) {
      const outcome = await applyOne(client, item, byIdentity, opts);
      outcomes.push(outcome);
    }
    // `would_apply` and `applied` are the SAME work — a dry-run runs every write
    // and then rolls back — so the state is relabelled here, once, from the only
    // thing that actually differs between the two runs.
    if (opts.apply) for (const o of outcomes) if (o.state === "would_apply") o.state = "applied";

    if (opts.apply) await client.query("commit");
    else await client.query("rollback");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
  return {
    apply: opts.apply,
    outcomes,
    canonicalWrites: { hotels: 0, hotelSourceIdentities: 0, hotelContacts: 0 },
  };
}

async function applyOne(
  client: Client,
  item: ReviewedItem,
  previews: Map<string, PreviewResult>,
  opts: { source: string; environment: string },
): Promise<ApplyOutcome> {
  const id = { identityId: item.identityId, sourcePropertyId: item.sourcePropertyId };

  // ---- 1. LOCK the identity. Nothing else may advance it mid-decision. ----
  const locked = await client.query<CurrentState>(
    `select i.id "identityId", i.source_property_id "sourcePropertyId", i.source, i.source_environment "environment",
            o.id "observationId", o.source_run_id "runId", o.source_payload_digest "payloadDigest"
       from public.source_property_identities i
       join public.source_property_observations o
         on o.source_property_identity_id = i.id and o.source_run_id = i.last_seen_run_id
      where i.id = $1 and i.source = $2 and i.source_environment = $3
      for update of i`,
    [item.identityId, opts.source, opts.environment],
  );
  if (locked.rows.length !== 1)
    return {
      ...id,
      state: "refused",
      refusal: "identity_not_found",
      detail: "No such identity, or it has no current observation.",
    };
  const current = locked.rows[0]!;

  if (current.sourcePropertyId !== item.sourcePropertyId)
    return {
      ...id,
      state: "refused",
      refusal: "identity_mismatch",
      detail: "The manifest's provider id does not match the identity.",
    };

  // ---- 2. STALE PROTECTION. Every pin must still hold. ----
  if (current.observationId !== item.currentObservationId)
    return {
      ...id,
      state: "refused",
      refusal: "stale_observation",
      detail: `Reviewed observation ${item.currentObservationId} is no longer current (${current.observationId}). The reviewer must inspect the new evidence.`,
    };
  if (current.runId !== item.currentSourceRunId)
    return {
      ...id,
      state: "refused",
      refusal: "stale_run",
      detail: "The current source run has changed since the pack was prepared.",
    };
  if (current.payloadDigest !== item.sourcePayloadDigest)
    return {
      ...id,
      state: "refused",
      refusal: "stale_payload_digest",
      detail: "The current observation's payload digest has changed.",
    };

  // ---- 3. DESTINATION must exist in the canonical catalogue. ----
  // Resolved before the digest because the digest binds the destination the
  // human chose, not the slug they typed.
  let destinationId: string | null = null;
  if (item.decision === "approve_create") {
    const dest = await client.query<{ id: string }>(
      "select id from public.destinations where slug = $1",
      [item.canonicalDestinationSlug],
    );
    if (dest.rows.length !== 1)
      return {
        ...id,
        state: "refused",
        refusal: "destination_not_supported",
        detail: `No canonical destination with slug ${JSON.stringify(item.canonicalDestinationSlug)}.`,
      };
    destinationId = dest.rows[0]!.id;
  }

  const digest = receiptDigestOf(item, destinationId);

  // ---- 4. IDEMPOTENCY, checked BEFORE the fingerprint. ----
  //
  // Applying a review CHANGES the preview fingerprint: the receipt becomes part
  // of conditions 1 and 2. So a replay of the identical manifest necessarily
  // carries the pre-review fingerprint, and checking staleness first would
  // refuse every exact replay as stale — turning idempotency into a guaranteed
  // failure. The evidence pins above already proved this is the same observation,
  // the same run and the same payload, which is what "same evidence" means.
  const existing = await client.query<{ id: string; receipt_digest: string }>(
    `select id, receipt_digest from public.source_property_review_receipts
      where source_property_identity_id = $1 and evidence_observation_id = $2`,
    [item.identityId, item.currentObservationId],
  );
  if (existing.rows.length > 0) {
    const prior = existing.rows[0]!;
    if (prior.receipt_digest === digest)
      return { ...id, state: "already_applied", receiptId: prior.id };
    return {
      ...id,
      state: "refused",
      refusal: "conflicting_review_exists",
      detail: `A materially different review already exists for this observation (receipt ${prior.id}). This pilot does not implement supersession; a correction workflow is future work.`,
    };
  }

  // ---- 5. STALE FINGERPRINT + READINESS, for a review not yet applied. ----
  const preview = previews.get(item.identityId);
  if (!preview)
    return {
      ...id,
      state: "refused",
      refusal: "preview_unavailable",
      detail: "A04 produced no preview for this identity.",
    };
  if (preview.fingerprint !== item.prereviewFingerprint)
    return {
      ...id,
      state: "refused",
      refusal: "stale_prereview_fingerprint",
      detail:
        "The A04 pre-review fingerprint has changed; the evidence behind the decision is not the evidence reviewed.",
    };

  const verdict = readinessOf(preview);
  if (!verdict.ready)
    return {
      ...id,
      state: "refused",
      refusal: "not_review_ready",
      detail: `Not human-review-ready: ${verdict.blocking.map((b) => `c${b.number}=${b.status}(${b.reason})`).join(", ")}`,
    };

  if (item.decision === "defer") {
    const receiptId = await insertReceipt(client, item, current, digest, null, null);
    return { ...id, state: "would_apply", receiptId };
  }

  // ---- 6. THE HUMAN-OWNED FINDING, then the receipt, then the decision. ----
  const finding = await client.query<{ id: string }>(
    `insert into public.source_match_candidates
       (source_property_identity_id, source, source_environment, candidate_kind, match_method, status,
        review_note, resolved_at)
     values ($1, $2, $3, 'new_property', $4, 'accepted', $5, now())
     returning id`,
    [
      item.identityId,
      current.source,
      current.environment,
      HUMAN_NEW_PROPERTY_METHOD,
      item.humanNote && item.humanNote.trim() !== ""
        ? item.humanNote
        : `Human review by ${item.reviewerLabel}: distinct property established against observation ${current.observationId}.`,
    ],
  );
  const findingId = finding.rows[0]!.id;

  const receiptId = await insertReceipt(client, item, current, digest, destinationId, findingId);

  // The current-state review row points at the SAME semantics as the receipt.
  await client.query(
    `insert into public.source_property_reviews
       (source_property_identity_id, source, source_environment, decision, destination_id,
        reviewer_user_id, reviewer_label, review_note, decided_in_run_id, reviewed_at)
     values ($1, $2, $3, 'approve_create', $4, $5, $6, $7, $8, now())`,
    [
      item.identityId,
      current.source,
      current.environment,
      destinationId,
      item.reviewerUserId ?? null,
      item.reviewerLabel,
      item.humanNote,
      current.runId,
    ],
  );

  return { ...id, state: "would_apply", receiptId };
}

async function insertReceipt(
  client: Client,
  item: ReviewedItem,
  current: CurrentState,
  digest: string,
  destinationId: string | null,
  findingId: string | null,
): Promise<string> {
  const receipt = await client.query<{ id: string }>(
    `insert into public.source_property_review_receipts
       (source_property_identity_id, source, source_environment, source_property_id,
        evidence_observation_id, evidence_source_run_id, source_payload_digest,
        prereview_fingerprint, prereview_as_of, decision, destination_id, new_property_finding_id,
        reviewer_user_id, reviewer_label, review_note, receipt_digest, reviewed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12,$13,$14,$15,$16, now())
     returning id`,
    [
      item.identityId,
      current.source,
      current.environment,
      current.sourcePropertyId,
      current.observationId,
      current.runId,
      current.payloadDigest,
      item.prereviewFingerprint,
      item.prereviewAsOf,
      item.decision,
      destinationId,
      findingId,
      item.reviewerUserId ?? null,
      item.reviewerLabel,
      item.humanNote,
      digest,
    ],
  );
  const receiptId = receipt.rows[0]!.id;

  for (const v of item.verifications) {
    await client.query(
      `insert into public.source_property_review_verifications (receipt_id, dimension, verdict, note)
       values ($1,$2,$3,$4)`,
      [receiptId, v.dimension, v.verdict, v.note ?? null],
    );
  }
  for (const r of item.evidenceReferences) {
    await client.query(
      `insert into public.source_property_review_evidence_references
         (receipt_id, reference_kind, locator, bears_on_dimensions, stance, note)
       values ($1,$2,$3,$4,$5,$6)`,
      [receiptId, r.referenceKind, r.locator, r.bearsOnDimensions, r.stance, r.note ?? null],
    );
  }
  return receiptId;
}
