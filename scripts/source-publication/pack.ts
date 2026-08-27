/**
 * A05 PUBLICATION PACK — read-only preparation of publication candidates.
 *
 * Prepare emits an item for a source identity ONLY when all of the following are
 * true of the REAL, recomputed evidence:
 *
 *   * the identity is `source_environment = 'production'`
 *   * the real D062 result is `overall = PASS` with all eleven conditions PASS
 *   * the current human review projection is an ACTIVE `approve_create` naming
 *     the receipt it represents, and that receipt cites the current observation
 *   * the identity is not already published
 *
 * It writes nothing, authorizes nothing, and leaves every human publication
 * authorization field EMPTY. `publicationAuthorized` starts `false` and an
 * unedited pack is refused by the apply path — `--apply` is a flag, not a human.
 *
 * The eleven-condition requirement is deliberately stated as "every condition
 * PASS" rather than "overall PASS". They are equivalent today by D062's own
 * composition rule, and a future condition added to the preview must not become
 * publishable-by-omission.
 */
import type { Client } from "pg";

import { loadAllPreviewResults } from "../prepublication-preview/preview";
import type { PreviewResult } from "../prepublication-preview/evaluate";

export const PUBLICATION_PACK_FORMAT_VERSION = "a05-source-publication-pack/1" as const;

/** The D062 condition numbers. All eleven must PASS before publication. */
export const D062_CONDITION_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;

/**
 * One prepared publication candidate.
 *
 * Everything above `publicationAuthorized` is a PIN: re-checked inside the
 * publication transaction against freshly recomputed evidence, and refused —
 * never rebased — when it has moved. Everything from `publicationAuthorized`
 * down is the human's, and prepare leaves it empty.
 */
export interface PublicationPackItem {
  sourcePropertyIdentityId: string;
  source: string;
  sourceEnvironment: "production";
  sourcePropertyId: string;

  currentObservationId: string;
  currentSourceRunId: string;
  sourcePayloadDigest: string;

  asOf: string;
  previewSchemaVersion: string;
  previewFingerprint: string;

  humanReviewReceiptId: string;
  reviewProjectionId: string;
  reviewCurrentReceiptId: string;
  humanNewPropertyFindingId: string;
  destinationId: string;
  destinationSlug: string;

  starRevisionId: string;
  locationRevisionId: string;
  scopeRevisionId: string;

  /** Read-only context for the human. Never re-derived by apply from this pack. */
  proposedName: string | null;
  proposedAddress: string | null;
  proposedStarRating: number | null;
  proposedLatitude: string | null;
  proposedLongitude: string | null;
  proposedCountryCode: string | null;
  nameVerdict: string | null;
  addressVerdict: string | null;

  /** ---- HUMAN PUBLICATION AUTHORIZATION. Empty until a human fills it. ---- */
  publicationAuthorized: false;
  authorizedByLabel: null;
  authorizedByUserId: null;
  authorizationNote: null;
}

export interface PublicationPack {
  formatVersion: typeof PUBLICATION_PACK_FORMAT_VERSION;
  source: string;
  environment: "production";
  asOf: string;
  preparedFrom: {
    identitiesEvaluated: number;
    d062Pass: number;
    alreadyPublished: number;
    skippedNotAuthorizedByHuman: number;
    skippedAlreadyPublished: number;
    emitted: number;
  };
  items: PublicationPackItem[];
}

interface CandidateRow {
  identity_id: string;
  source: string;
  source_environment: string;
  source_property_id: string;
  observation_id: string | null;
  source_run_id: string | null;
  source_payload_digest: string | null;
  source_name: string | null;
  source_address: string | null;
  review_id: string | null;
  review_decision: string | null;
  review_status: string | null;
  current_receipt_id: string | null;
  destination_id: string | null;
  destination_slug: string | null;
  destination_country_code: string | null;
  receipt_id: string | null;
  receipt_decision: string | null;
  receipt_observation_id: string | null;
  receipt_finding_id: string | null;
  revocation_id: string | null;
  star_revision_id: string | null;
  star_outcome: string | null;
  star_value: string | null;
  location_revision_id: string | null;
  location_outcome: string | null;
  latitude: string | null;
  longitude: string | null;
  scope_revision_id: string | null;
  scope_outcome: string | null;
  name_verdict: string | null;
  address_verdict: string | null;
  publication_receipt_id: string | null;
}

/**
 * The pins, read in ONE statement so a candidate is described by one consistent
 * row rather than by several independent lookups. `last_seen_run_id` — never a
 * timestamp and never UUID order — is what makes the observation "current",
 * matching D062's own currentness rule exactly.
 */
const CANDIDATE_QUERY = `
select i.id identity_id, i.source, i.source_environment, i.source_property_id,
       o.id observation_id, o.source_run_id, o.source_payload_digest,
       o.source_name, o.source_address,
       rv.id review_id, rv.decision review_decision, rv.review_status, rv.current_receipt_id,
       rv.destination_id, d.slug destination_slug, d.country_code destination_country_code,
       r.id receipt_id, r.decision receipt_decision,
       r.evidence_observation_id receipt_observation_id, r.new_property_finding_id receipt_finding_id,
       rvk.id revocation_id,
       st.id star_revision_id, st.outcome star_outcome, st.resolved_star_value::text star_value,
       lo.id location_revision_id, lo.outcome location_outcome,
       lo.resolved_latitude::text latitude, lo.resolved_longitude::text longitude,
       sc.id scope_revision_id, sc.outcome scope_outcome,
       vn.verdict name_verdict, va.verdict address_verdict,
       pub.id publication_receipt_id
  from public.source_property_identities i
  left join public.source_property_observations o
    on o.source_property_identity_id = i.id and o.source_run_id = i.last_seen_run_id
  left join public.source_property_reviews rv on rv.source_property_identity_id = i.id
  left join public.source_property_review_revocations rvk on rvk.revoked_receipt_id = rv.current_receipt_id
  left join public.destinations d on d.id = rv.destination_id
  left join public.source_property_review_receipts r
    on r.id = rv.current_receipt_id and r.source_property_identity_id = i.id
  left join public.source_property_review_verifications vn
    on vn.receipt_id = r.id and vn.dimension = 'name'
  left join public.source_property_review_verifications va
    on va.receipt_id = r.id and va.dimension = 'address'
  left join public.source_property_current_star_resolutions st on st.source_property_identity_id = i.id
  left join public.source_property_current_location_resolutions lo on lo.source_property_identity_id = i.id
  left join public.source_property_current_scope_resolutions sc on sc.source_property_identity_id = i.id
  left join public.source_property_publication_receipts pub on pub.source_property_identity_id = i.id
 where i.source = $1 and i.source_environment = $2
 order by i.source_property_id`;

export function allElevenPass(result: PreviewResult): boolean {
  return D062_CONDITION_NUMBERS.every(
    (n) => result.conditions.find((c) => c.number === n)?.status === "PASS",
  );
}

/**
 * Build the pack. Read-only: `loadAllPreviewResults` opens its own REPEATABLE
 * READ, READ ONLY transaction, and the candidate query below is a plain select.
 */
export async function buildPublicationPack(
  client: Client,
  args: { source: string; environment: "production"; asOf: string; limit?: number | null },
): Promise<PublicationPack> {
  const previews = await loadAllPreviewResults(client, args);
  const byIdentity = new Map(previews.map((p) => [p.identityId, p]));

  const candidates = await client.query<CandidateRow>(CANDIDATE_QUERY, [
    args.source,
    args.environment,
  ]);

  const items: PublicationPackItem[] = [];
  let d062Pass = 0;
  let alreadyPublished = 0;
  let skippedNotAuthorizedByHuman = 0;
  let skippedAlreadyPublished = 0;

  for (const row of candidates.rows) {
    const preview = byIdentity.get(row.identity_id);
    if (!preview || !allElevenPass(preview)) continue;
    d062Pass += 1;

    if (row.publication_receipt_id !== null) {
      alreadyPublished += 1;
      skippedAlreadyPublished += 1;
      continue;
    }

    // D062 already refuses every one of these; prepare asks independently so a
    // pack never depends on the evaluator having been correct, and so an
    // operator is never handed a candidate the apply path will refuse.
    const humanAuthorized =
      row.review_id !== null &&
      row.review_decision === "approve_create" &&
      row.review_status === "active" &&
      row.revocation_id === null &&
      row.current_receipt_id !== null &&
      row.receipt_id === row.current_receipt_id &&
      row.receipt_decision === "approve_create" &&
      row.receipt_observation_id !== null &&
      row.receipt_observation_id === row.observation_id &&
      row.receipt_finding_id !== null &&
      row.destination_id !== null;
    if (!humanAuthorized) {
      skippedNotAuthorizedByHuman += 1;
      continue;
    }

    // Guaranteed by the eleven-condition PASS above; asserted rather than
    // assumed, so a null can never reach the manifest as a pin.
    if (
      row.observation_id === null ||
      row.source_run_id === null ||
      row.source_payload_digest === null ||
      row.star_revision_id === null ||
      row.location_revision_id === null ||
      row.scope_revision_id === null ||
      row.destination_slug === null
    ) {
      skippedNotAuthorizedByHuman += 1;
      continue;
    }

    items.push({
      sourcePropertyIdentityId: row.identity_id,
      source: row.source,
      sourceEnvironment: "production",
      sourcePropertyId: row.source_property_id,
      currentObservationId: row.observation_id,
      currentSourceRunId: row.source_run_id,
      sourcePayloadDigest: row.source_payload_digest,
      asOf: args.asOf,
      previewSchemaVersion: preview.schemaVersion,
      previewFingerprint: preview.fingerprint,
      humanReviewReceiptId: row.receipt_id!,
      reviewProjectionId: row.review_id!,
      reviewCurrentReceiptId: row.current_receipt_id!,
      humanNewPropertyFindingId: row.receipt_finding_id!,
      destinationId: row.destination_id!,
      destinationSlug: row.destination_slug,
      starRevisionId: row.star_revision_id,
      locationRevisionId: row.location_revision_id,
      scopeRevisionId: row.scope_revision_id,
      proposedName: row.source_name,
      proposedAddress: row.source_address,
      proposedStarRating: row.star_value === null ? null : Number(row.star_value),
      proposedLatitude: row.latitude,
      proposedLongitude: row.longitude,
      proposedCountryCode: row.destination_country_code,
      nameVerdict: row.name_verdict,
      addressVerdict: row.address_verdict,
      publicationAuthorized: false,
      authorizedByLabel: null,
      authorizedByUserId: null,
      authorizationNote: null,
    });
    if (args.limit != null && items.length >= args.limit) break;
  }

  return {
    formatVersion: PUBLICATION_PACK_FORMAT_VERSION,
    source: args.source,
    environment: "production",
    asOf: args.asOf,
    preparedFrom: {
      identitiesEvaluated: candidates.rows.length,
      d062Pass,
      alreadyPublished,
      skippedNotAuthorizedByHuman,
      skippedAlreadyPublished,
      emitted: items.length,
    },
    items,
  };
}
