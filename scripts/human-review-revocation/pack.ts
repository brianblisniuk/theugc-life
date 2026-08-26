/**
 * A04.6 REVOCATION PACK — read-only.
 *
 * Builds the manifest a human fills in to withdraw a previous `approve_create`.
 * It decides nothing: every human field (`reviewerLabel`, `revocationNote`) is
 * emitted EMPTY, and the operator must type them.
 *
 * Everything else in the pack is a PIN read out of the database — the projection
 * row, the receipt it currently represents, that receipt's content digest, and
 * the observation the receipt cites. Apply re-checks all of them, so if anything
 * moves between prepare and apply the withdrawal is refused rather than aimed at
 * an approval the human never looked at.
 *
 * Deliberately NOT a filter here: D062 readiness. An approval that has since
 * become UNRESOLVED is exactly the kind a human most needs to withdraw.
 */
import type { Client } from "pg";

export interface RevocationCandidate {
  identityId: string;
  sourcePropertyId: string;
  providerName: string | null;
  reviewId: string;
  expectedDecision: "approve_create";
  expectedReviewStatus: "active";
  expectedCurrentReceiptId: string;
  expectedReceiptDigest: string;
  expectedEvidenceObservationId: string;

  /** Context for the human. None of this is a pin; none of it is checked. */
  context: {
    reviewedAt: string;
    reviewerLabel: string;
    reviewNote: string | null;
    destinationSlug: string | null;
    receiptEvidenceIsStillCurrent: boolean;
  };

  /** EMPTY. The human types these. */
  reviewerLabel: "";
  reviewerUserId: null;
  revocationNote: "";
}

export interface RevocationPack {
  kind: "human-review-revocation";
  preparedFrom: {
    source: string;
    environment: "evaluation" | "production";
    activeApprovals: number;
    revocable: number;
    withoutReceipt: number;
  };
  items: RevocationCandidate[];
}

/**
 * The currentness join is `o.source_run_id = i.last_seen_run_id`, identical to
 * A04's preview. Never `observed_at desc`: a re-extraction can write an older
 * clock value, and UUID order means nothing at all.
 *
 * `current_receipt_id is null` means a projection created before A04.5 (or by
 * hand). Those rows are counted and EXCLUDED from `items`: with no receipt there
 * is no specific approval to pin, and V1 will not invent one.
 */
const CANDIDATE_QUERY = `
  select rv.id                          as review_id,
         rv.source_property_identity_id as identity_id,
         rv.reviewed_at,
         rv.reviewer_label,
         rv.review_note,
         rv.current_receipt_id,
         i.source_property_id,
         cur.id                         as current_observation_id,
         cur.source_name                as provider_name,
         d.slug                         as destination_slug,
         r.receipt_digest,
         r.evidence_observation_id
    from public.source_property_reviews rv
    join public.source_property_identities i
      on i.id = rv.source_property_identity_id
    left join public.source_property_observations cur
      on cur.source_property_identity_id = i.id
     and cur.source_run_id = i.last_seen_run_id
    left join public.destinations d on d.id = rv.destination_id
    left join public.source_property_review_receipts r
      on r.id = rv.current_receipt_id
     and r.source_property_identity_id = rv.source_property_identity_id
   where rv.source = $1
     and rv.source_environment = $2
     and rv.decision = 'approve_create'
     and rv.review_status = 'active'
`;

const ORDER_BY = "\n   order by rv.reviewed_at desc, rv.id\n";

interface CandidateRow {
  review_id: string;
  identity_id: string;
  reviewed_at: Date | string;
  reviewer_label: string;
  review_note: string | null;
  current_receipt_id: string | null;
  source_property_id: string;
  current_observation_id: string | null;
  provider_name: string | null;
  destination_slug: string | null;
  receipt_digest: string | null;
  evidence_observation_id: string | null;
}

export async function buildRevocationPack(
  client: Client,
  args: { source: string; environment: "evaluation" | "production"; identityId?: string | null },
): Promise<RevocationPack> {
  const params: unknown[] = [args.source, args.environment];
  let sql = CANDIDATE_QUERY;
  if (args.identityId) {
    params.push(args.identityId);
    sql += "     and rv.source_property_identity_id = $3";
  }
  sql += ORDER_BY;

  const { rows } = await client.query<CandidateRow>(sql, params);

  const withoutReceipt = rows.filter((row) => row.current_receipt_id === null).length;
  const items: RevocationCandidate[] = [];
  for (const row of rows) {
    if (
      row.current_receipt_id === null ||
      row.receipt_digest === null ||
      row.evidence_observation_id === null
    )
      continue;
    items.push({
      identityId: row.identity_id,
      sourcePropertyId: row.source_property_id,
      providerName: row.provider_name,
      reviewId: row.review_id,
      expectedDecision: "approve_create",
      expectedReviewStatus: "active",
      expectedCurrentReceiptId: row.current_receipt_id,
      expectedReceiptDigest: row.receipt_digest,
      expectedEvidenceObservationId: row.evidence_observation_id,
      context: {
        reviewedAt:
          row.reviewed_at instanceof Date ? row.reviewed_at.toISOString() : String(row.reviewed_at),
        reviewerLabel: row.reviewer_label,
        reviewNote: row.review_note,
        destinationSlug: row.destination_slug,
        // Advisory only. A stale approval is still revocable — in fact it is the
        // most likely thing an operator wants to withdraw.
        receiptEvidenceIsStillCurrent: row.evidence_observation_id === row.current_observation_id,
      },
      reviewerLabel: "",
      reviewerUserId: null,
      revocationNote: "",
    });
  }

  return {
    kind: "human-review-revocation",
    preparedFrom: {
      source: args.source,
      environment: args.environment,
      activeApprovals: rows.length,
      revocable: items.length,
      withoutReceipt,
    },
    items,
  };
}
