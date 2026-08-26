/**
 * A04.6 REVOCATION APPLY — a human withdraws a previous approve_create.
 *
 * This is deliberately NOT part of the normal review apply command. Revoking is
 * destructive to authorization, and an operator should never reach it by
 * accident while doing ordinary review work.
 *
 * A revocation is NOT a rejection, a deletion, a provider correction, or a
 * publication action. It asserts exactly one thing:
 *
 *     "the previously active human approval is withdrawn and may no longer
 *      authorize D062."
 *
 * What it therefore does NOT touch: the immutable receipt, its verification
 * children, its evidence references, the entity-level `new_property` finding,
 * the provider observation, `resolution_state`, or any canonical table. The
 * projection keeps pointing at the revoked receipt, so the resulting state reads
 * as: decision approve_create · receipt A · status revoked · and a revocation
 * event saying who withdrew it, when, and why.
 */
import { createHash } from "node:crypto";
import type { Client } from "pg";

/** SQLSTATEs meaning "this transaction lost a concurrency race". */
const SERIALIZATION_FAILURE = "40001";
const DEADLOCK_DETECTED = "40P01";

function isConcurrencyAbort(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === SERIALIZATION_FAILURE || code === DEADLOCK_DETECTED;
}

export class RevocationRefusal extends Error {
  constructor(
    readonly refusal: string,
    message: string,
  ) {
    super(message);
    this.name = "RevocationRefusal";
  }
}

/**
 * One revocation. It PINS the exact approval being withdrawn — not just the
 * identity — so a human can never discover they revoked something other than
 * what they were looking at.
 */
export interface RevocationItem {
  identityId: string;
  sourcePropertyId: string;
  /** The current projection row being withdrawn. */
  reviewId: string;
  expectedDecision: "approve_create";
  expectedReviewStatus: "active";
  expectedCurrentReceiptId: string;
  expectedReceiptDigest: string;
  expectedEvidenceObservationId: string;

  reviewerLabel: string;
  reviewerUserId?: string | null;
  /** REQUIRED. A withdrawal with no stated reason is not auditable. */
  revocationNote: string;
}

export type RevocationOutcome =
  | {
      identityId: string;
      sourcePropertyId: string;
      state: "would_revoke" | "revoked";
      revocationId: string | null;
    }
  | {
      identityId: string;
      sourcePropertyId: string;
      state: "already_revoked";
      revocationId: string;
    }
  | {
      identityId: string;
      sourcePropertyId: string;
      state: "refused";
      refusal: string;
      detail: string;
    };

export interface RevocationReport {
  apply: boolean;
  outcomes: RevocationOutcome[];
  canonicalWrites: { hotels: 0; hotelSourceIdentities: 0; hotelContacts: 0 };
}

/**
 * The semantic content digest of a revocation. Excludes `revokedAt` for the same
 * reason A04.5's receipt digest excludes `reviewed_at`: replaying an identical
 * manifest must not be called "different" merely because the clock moved.
 */
export function revocationDigestOf(item: RevocationItem): string {
  const canonical = {
    identityId: item.identityId,
    reviewId: item.reviewId,
    revokedReceiptId: item.expectedCurrentReceiptId,
    receiptDigest: item.expectedReceiptDigest,
    evidenceObservationId: item.expectedEvidenceObservationId,
    reviewerLabel: item.reviewerLabel,
    reviewerUserId: item.reviewerUserId ?? null,
    revocationNote: item.revocationNote,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Shape rules checked before the database is touched at all. */
export function validateRevocationItem(item: RevocationItem): void {
  if (!item.revocationNote || item.revocationNote.trim() === "")
    throw new RevocationRefusal(
      "revocation_requires_note",
      "A revocation must say why the approval is being withdrawn. Withdrawing authorization silently is not auditable.",
    );
  if (!item.reviewerLabel || item.reviewerLabel.trim() === "")
    throw new RevocationRefusal(
      "revocation_requires_reviewer",
      "A revocation must name the human withdrawing the approval.",
    );
  if (item.expectedDecision !== "approve_create")
    throw new RevocationRefusal(
      "revocation_target_not_approve_create",
      "A04.6 V1 withdraws an `approve_create` authorization only. Nothing else currently authorizes D062.",
    );
  if (item.expectedReviewStatus !== "active")
    throw new RevocationRefusal(
      "revocation_target_not_active",
      "A revocation manifest must claim to be withdrawing an ACTIVE approval.",
    );
}

interface CurrentReview {
  id: string;
  decision: string;
  review_status: string;
  current_receipt_id: string | null;
  source: string;
  source_environment: string;
  source_property_id: string;
}

/**
 * Apply a revocation manifest. Dry-run unless `apply` — and in dry-run the
 * transaction is rolled back, so the same code proves the same things and leaves
 * nothing behind.
 *
 * SERIALIZABLE, and no retry, for exactly the reasons A04.5's apply path
 * documents: a retry would re-run a human decision against a snapshot the human
 * never saw. An abort means nothing was withdrawn and the operator looks again.
 */
export async function applyRevocationManifest(
  client: Client,
  items: readonly RevocationItem[],
  opts: { source: string; environment: "evaluation" | "production"; apply: boolean },
): Promise<RevocationReport> {
  for (const item of items) validateRevocationItem(item);

  const outcomes: RevocationOutcome[] = [];
  await client.query("begin isolation level serializable");
  try {
    for (const item of items) outcomes.push(await revokeOne(client, item, opts));
    if (opts.apply) for (const o of outcomes) if (o.state === "would_revoke") o.state = "revoked";

    if (opts.apply) await client.query("commit");
    else await client.query("rollback");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if (isConcurrencyAbort(error))
      throw new RevocationRefusal(
        "evidence_changed_concurrently",
        "The review this revocation targets was changed by a concurrent transaction, so the withdrawal could not be committed against the state it was made against. NOTHING was revoked. Re-run prepare and look at the current approval.",
      );
    throw error;
  }
  return {
    apply: opts.apply,
    outcomes,
    canonicalWrites: { hotels: 0, hotelSourceIdentities: 0, hotelContacts: 0 },
  };
}

async function revokeOne(
  client: Client,
  item: RevocationItem,
  opts: { source: string; environment: string },
): Promise<RevocationOutcome> {
  const id = { identityId: item.identityId, sourcePropertyId: item.sourcePropertyId };

  // ---- 1. LOCK the current projection. ----
  //
  // Note what is deliberately NOT required here: D062 readiness. A safety
  // revocation must remain possible when star, scope, location or lifecycle
  // evidence has drifted, when entity conflicts appeared, when a new observation
  // arrived, or when A04 is already UNRESOLVED. Revocation WITHDRAWS human
  // authorization; it does not grant any. Requiring current readiness would
  // disable the emergency brake in precisely the situations that most need it.
  //
  // The only currentness that matters: the projection is still the exact
  // approval this manifest says it is withdrawing.
  const locked = await client.query<CurrentReview>(
    `select rv.id, rv.decision, rv.review_status, rv.current_receipt_id,
            rv.source, rv.source_environment, i.source_property_id
       from public.source_property_reviews rv
       join public.source_property_identities i on i.id = rv.source_property_identity_id
      where rv.source_property_identity_id = $1 and rv.source = $2 and rv.source_environment = $3
      for update of rv`,
    [item.identityId, opts.source, opts.environment],
  );
  if (locked.rows.length !== 1)
    return {
      ...id,
      state: "refused",
      refusal: "review_not_found",
      detail: "No current review projection for this identity/source/environment.",
    };
  const review = locked.rows[0]!;

  if (review.id !== item.reviewId)
    return {
      ...id,
      state: "refused",
      refusal: "stale_review_projection",
      detail: `The manifest names review row ${item.reviewId}, but this identity's current projection is ${review.id}.`,
    };
  if (review.source_property_id !== item.sourcePropertyId)
    return {
      ...id,
      state: "refused",
      refusal: "identity_mismatch",
      detail: "The manifest's provider id does not match the identity.",
    };

  // ---- 2. IDEMPOTENCY, before the state checks. ----
  //
  // Same ordering rationale as A04.5: the act of revoking changes the very state
  // ("active") the checks below look for, so checking state first would turn an
  // exact replay into `review_not_active` instead of `already_revoked`.
  const digest = revocationDigestOf(item);
  const existing = await client.query<{ id: string; revocation_digest: string }>(
    `select id, revocation_digest from public.source_property_review_revocations
      where revoked_receipt_id = $1`,
    [item.expectedCurrentReceiptId],
  );
  if (existing.rows.length > 0) {
    const prior = existing.rows[0]!;
    if (prior.revocation_digest === digest)
      return { ...id, state: "already_revoked", revocationId: prior.id };
    return {
      ...id,
      state: "refused",
      refusal: "conflicting_revocation_exists",
      detail: `This approval was already revoked with a materially different revocation (${prior.id}). The stated reason is part of the record and is never silently rewritten.`,
    };
  }

  // ---- 3. THE PINS. Every one must still hold. ----
  if (review.decision !== "approve_create")
    return {
      ...id,
      state: "refused",
      refusal: "review_not_approve_create",
      detail: `The current decision is '${review.decision}'. A04.6 V1 withdraws an approve_create authorization only.`,
    };
  if (review.review_status !== "active")
    return {
      ...id,
      state: "refused",
      refusal: "review_not_active",
      detail: `The current review status is '${review.review_status}', not 'active'. There is nothing to withdraw.`,
    };
  if (review.current_receipt_id !== item.expectedCurrentReceiptId)
    return {
      ...id,
      state: "refused",
      refusal: "receipt_mismatch",
      detail: `The projection now represents receipt ${review.current_receipt_id}, not the ${item.expectedCurrentReceiptId} this manifest was prepared against. A revocation pinned to one approval must never withdraw a different one.`,
    };

  const receipt = await client.query<{
    id: string;
    decision: string;
    receipt_digest: string;
    evidence_observation_id: string;
  }>(
    `select id, decision, receipt_digest, evidence_observation_id
       from public.source_property_review_receipts
      where id = $1 and source_property_identity_id = $2`,
    [item.expectedCurrentReceiptId, item.identityId],
  );
  if (receipt.rows.length !== 1)
    return {
      ...id,
      state: "refused",
      refusal: "receipt_mismatch",
      detail: "The pinned receipt does not exist for this identity.",
    };
  const r = receipt.rows[0]!;
  if (r.decision !== "approve_create")
    return {
      ...id,
      state: "refused",
      refusal: "review_not_approve_create",
      detail: `The pinned receipt records '${r.decision}', not an approve_create authorization.`,
    };
  if (r.receipt_digest !== item.expectedReceiptDigest)
    return {
      ...id,
      state: "refused",
      refusal: "receipt_mismatch",
      detail: "The pinned receipt's content digest has changed since the manifest was prepared.",
    };
  if (r.evidence_observation_id !== item.expectedEvidenceObservationId)
    return {
      ...id,
      state: "refused",
      refusal: "receipt_mismatch",
      detail: "The pinned receipt cites a different evidence observation than the manifest.",
    };

  // ---- 4. WRITES. Nothing above this line has touched the database. ----
  const inserted = await client.query<{ id: string }>(
    `insert into public.source_property_review_revocations
       (source_property_identity_id, source, source_environment, revoked_receipt_id,
        reviewer_user_id, reviewer_label, revocation_note, revoked_at, revocation_digest)
     values ($1,$2,$3,$4,$5,$6,$7, now(), $8)
     returning id`,
    [
      item.identityId,
      review.source,
      review.source_environment,
      item.expectedCurrentReceiptId,
      item.reviewerUserId ?? null,
      item.reviewerLabel,
      item.revocationNote,
      digest,
    ],
  );

  // Only the status moves. `decision`, `destination_id`, `target_hotel_id` and
  // `current_receipt_id` all stay exactly as they were, so the record still says
  // what was decided and which approval was withdrawn.
  await client.query(
    `update public.source_property_reviews
        set review_status = 'revoked'
      where source_property_identity_id = $1`,
    [item.identityId],
  );

  return { ...id, state: "would_revoke", revocationId: inserted.rows[0]!.id };
}
