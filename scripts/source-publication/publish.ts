/**
 * A05 PUBLICATION APPLY — a D062 PASS becomes a canonical hotel, atomically.
 *
 * ONE transaction produces all four facts, or none of them:
 *
 *   A) the canonical `hotels` row
 *   B) the ACTIVE `hotel_source_identities` link that says which provider
 *      property produced it
 *   C) the immutable `source_property_publication_receipts` row recording the
 *      D062 verdict and the human authorization behind it
 *   D) the terminal `resolution_state = 'resolved_eligible'` on the identity
 *
 * No hotel without a link. No link without a hotel. No `resolved_eligible`
 * without a promotion. No publication receipt claiming a transaction that did
 * not commit.
 *
 * ---- WHAT A D062 PASS IS, AND IS NOT ----
 *
 * A PASS is NECESSARY. It is not authorization. A04.5 answered "what did the
 * human decide about identity and destination?" and A04.6 answered "is that
 * decision still authorized?". Neither of them says "publish it", and this layer
 * refuses to treat `--apply` as if a human had. `publicationAuthorized` must be
 * explicitly true, with a stated label and a stated reason, or nothing happens.
 *
 * ---- WHAT IS NEVER COPIED ----
 *
 * The provider observation is not the canonical row. Star comes from the star
 * resolution, coordinates from the location resolution, destination from the
 * human review, country from the canonical destination. Name and address are the
 * only provider text that crosses the boundary, and only where the human's own
 * verification says `supports`. A human contradiction is preserved, never
 * normalized away: an address the reviewer marked `contradicts` is published as
 * NULL rather than published as if it agreed.
 */
import { createHash } from "node:crypto";
import type { Client } from "pg";

import { generateSlug } from "../../src/lib/canonical/slug";
import { composeAllPreviewResultsInCallerTransaction } from "../prepublication-preview/preview";
import type { PreviewResult } from "../prepublication-preview/evaluate";
import { D062_CONDITION_NUMBERS, allElevenPass } from "./pack";

/**
 * The `match_method` this publication path owns.
 *
 * `blocking:*` is the entity-resolution generator's namespace, and a link
 * written under it would claim a machine matched this property when in fact a
 * human created it. A02's stand-down sweep only touches `blocking:%` rows, so
 * borrowing that namespace would also expose the canonical link to a machine
 * supersession it must never be subject to.
 */
export const PUBLICATION_MATCH_METHOD = "human_review:d062_approve_create" as const;

/**
 * The canonical trim A05 applies to provider text before publishing it.
 *
 * `public.canonical_published_text()` in 0034 is the SAME function in SQL, and
 * the database compares the published `hotels.name` and `hotels.address` against
 * it — so the two must agree character for character. Both trim exactly the
 * ASCII whitespace set (space, tab, newline, carriage return, form feed,
 * vertical tab) and collapse an empty result to NULL, because a canonical field
 * that is present but blank is not a fact.
 *
 * Deliberately NOT `String.prototype.trim()`: it also strips Unicode spaces that
 * `btrim` does not, so a name ending in a non-breaking space would produce a
 * value the database then refused — failing closed on a legitimate publication.
 */
export function canonicalPublishedText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
  return trimmed === "" ? null : trimmed;
}

/** One publication decision: the prepared pins, plus the human authorization. */
export interface PublicationItem {
  sourcePropertyIdentityId: string;
  source: string;
  sourceEnvironment: string;
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

  starRevisionId: string;
  locationRevisionId: string;
  scopeRevisionId: string;

  publicationAuthorized: boolean;
  authorizedByLabel: string | null;
  authorizedByUserId?: string | null;
  authorizationNote: string | null;
}

export interface PublishedIds {
  hotelId: string;
  hotelSourceIdentityId: string;
  publicationReceiptId: string;
}

export type PublicationOutcome =
  | ({
      sourcePropertyIdentityId: string;
      sourcePropertyId: string;
      state: "would_publish" | "published" | "already_published";
    } & PublishedIds)
  | {
      sourcePropertyIdentityId: string;
      sourcePropertyId: string;
      state: "refused";
      refusal: string;
      detail: string;
    };

export interface PublicationReport {
  apply: boolean;
  outcomes: PublicationOutcome[];
  canonicalWrites: { hotels: number; hotelSourceIdentities: number; publicationReceipts: number };
}

export class PublicationRefusal extends Error {
  constructor(
    readonly refusal: string,
    message: string,
  ) {
    super(message);
    this.name = "PublicationRefusal";
  }
}

/**
 * The semantic content digest of an authorized publication.
 *
 * `authorized_at` is deliberately excluded, following A04.5/A04.6: an exact
 * replay must not be called "different" merely because the clock moved. Every
 * pin IS included, so a manifest that names different evidence — or a different
 * human authorization — produces a different digest and is refused rather than
 * quietly creating a second canonical property.
 */
export function publicationDigestOf(item: PublicationItem): string {
  const canonical = {
    identityId: item.sourcePropertyIdentityId,
    source: item.source,
    sourceEnvironment: item.sourceEnvironment,
    sourcePropertyId: item.sourcePropertyId,
    observationId: item.currentObservationId,
    runId: item.currentSourceRunId,
    payloadDigest: item.sourcePayloadDigest,
    asOf: item.asOf,
    previewSchemaVersion: item.previewSchemaVersion,
    previewFingerprint: item.previewFingerprint,
    humanReviewReceiptId: item.humanReviewReceiptId,
    reviewProjectionId: item.reviewProjectionId,
    reviewCurrentReceiptId: item.reviewCurrentReceiptId,
    humanNewPropertyFindingId: item.humanNewPropertyFindingId,
    destinationId: item.destinationId,
    starRevisionId: item.starRevisionId,
    locationRevisionId: item.locationRevisionId,
    scopeRevisionId: item.scopeRevisionId,
    authorizedByLabel: item.authorizedByLabel,
    authorizedByUserId: item.authorizedByUserId ?? null,
    authorizationNote: item.authorizationNote,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Shape rules a publication manifest must satisfy before the database is opened
 * at all. An unedited pack fails here: `publicationAuthorized` is `false` in
 * every prepared item, and no flag on the command line can substitute for it.
 */
export function validatePublicationItem(item: PublicationItem): void {
  if (item.sourceEnvironment !== "production")
    throw new PublicationRefusal(
      "evaluation_identity_not_publishable",
      `Manifest item ${item.sourcePropertyId} declares source_environment ${JSON.stringify(item.sourceEnvironment)}. EVALUATION DATA NEVER BECOMES CANONICAL DATA: the provider test environment is not production canonical evidence, and relabelling it would be the failure the whole isolation axis exists to prevent.`,
    );
  if (item.publicationAuthorized !== true)
    throw new PublicationRefusal(
      "publication_not_authorized",
      `Manifest item ${item.sourcePropertyId} is not publication-authorized. A D062 PASS is necessary and is not authorization; a human must set publicationAuthorized, a label and a note. \`--apply\` is a flag, not a person.`,
    );
  if (!item.authorizedByLabel || item.authorizedByLabel.trim() === "")
    throw new PublicationRefusal(
      "publication_authorization_incomplete",
      `Manifest item ${item.sourcePropertyId} names nobody as the authorizing human.`,
    );
  if (!item.authorizationNote || item.authorizationNote.trim() === "")
    throw new PublicationRefusal(
      "publication_authorization_incomplete",
      `Manifest item ${item.sourcePropertyId} carries no authorization note. Publication is irreversible in V1; an irreversible action with no stated reason is not auditable.`,
    );
}

interface LockedIdentity {
  identityId: string;
  sourcePropertyId: string;
  source: string;
  environment: string;
  resolutionState: string;
  promotedHotelId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  observationId: string;
  runId: string;
  payloadDigest: string | null;
  sourceName: string | null;
  sourceAddress: string | null;
}

const SERIALIZATION_FAILURE = "40001";
const DEADLOCK_DETECTED = "40P01";

function isConcurrencyAbort(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === SERIALIZATION_FAILURE || code === DEADLOCK_DETECTED;
}

/**
 * Apply one publication manifest. Dry-run unless `apply` is true — and the
 * dry-run runs every write and then rolls back, so the same code proves the same
 * things and leaves nothing behind.
 *
 * ---- WHY SERIALIZABLE, AND WHY NO RETRY ----
 *
 * The verdict this transaction acts on is composed across the identity, its
 * current observation, the star/scope/location head revisions, lifecycle
 * evidence, the review projection, the review receipt, the revocation record,
 * the candidate matrix and a live entity-resolution discovery sweep. Under READ
 * COMMITTED each statement gets its own snapshot and the evaluator can compose a
 * view that never existed. REPEATABLE READ fixes the snapshot but permits write
 * skew, and this transaction reads evidence and writes elsewhere — which is
 * exactly write skew. SERIALIZABLE (SSI) is what makes "these four writes rest
 * on this verdict" true.
 *
 * There is deliberately NO RETRY. A retry would re-run a human's irreversible
 * publication authorization against a snapshot that human never saw. `40001` and
 * `40P01` surface as a refusal meaning: nothing was published, look at the new
 * evidence.
 *
 * ---- LOCK ORDER ----
 *
 * 1. `source_property_identities`, then 2. the `source_property_reviews`
 * projection — the same order A04.5's apply and A04.6's revoke use, so a
 * publication and a concurrent revocation queue rather than deadlock.
 */
export async function applyPublicationManifest(
  client: Client,
  items: readonly PublicationItem[],
  opts: { source: string; environment: "evaluation" | "production"; asOf: string; apply: boolean },
): Promise<PublicationReport> {
  for (const item of items) validatePublicationItem(item);

  const outcomes: PublicationOutcome[] = [];
  const written = { hotels: 0, hotelSourceIdentities: 0, publicationReceipts: 0 };
  await client.query("begin isolation level serializable");
  try {
    const results = await composeAllPreviewResultsInCallerTransaction(client, opts);
    const byIdentity = new Map(results.map((r) => [r.identityId, r]));

    for (const item of items) {
      const outcome = await publishOne(client, item, byIdentity, opts);
      outcomes.push(outcome);
      if (outcome.state === "would_publish") {
        written.hotels += 1;
        written.hotelSourceIdentities += 1;
        written.publicationReceipts += 1;
      }
    }
    // A dry-run performs the SAME work and then rolls back, so the label is the
    // only thing that differs between the two runs.
    if (opts.apply)
      for (const o of outcomes) if (o.state === "would_publish") o.state = "published";

    // COMMIT is where SSI and both deferred constraint triggers fire, so this
    // call can still fail after every statement above succeeded.
    if (opts.apply) await client.query("commit");
    else await client.query("rollback");
  } catch (error) {
    // Nothing survives: no hotel, no canonical link, no publication receipt and
    // no terminal resolution transition.
    await client.query("rollback").catch(() => undefined);
    if (isConcurrencyAbort(error))
      throw new PublicationRefusal(
        "publication_evidence_changed_concurrently",
        "Evidence this publication depends on was changed by a concurrent transaction, so it could not be committed against the state it was authorized against. NOTHING was published. Re-run prepare and look at the new evidence; a human's irreversible authorization is deliberately never retried against a snapshot the human never saw.",
      );
    throw error;
  }
  return {
    apply: opts.apply,
    outcomes,
    canonicalWrites: opts.apply
      ? written
      : { hotels: 0, hotelSourceIdentities: 0, publicationReceipts: 0 },
  };
}

async function publishOne(
  client: Client,
  item: PublicationItem,
  previews: Map<string, PreviewResult>,
  opts: { source: string; environment: string; asOf: string },
): Promise<PublicationOutcome> {
  const id = {
    sourcePropertyIdentityId: item.sourcePropertyIdentityId,
    sourcePropertyId: item.sourcePropertyId,
  };
  const refuse = (refusal: string, detail: string): PublicationOutcome => ({
    ...id,
    state: "refused",
    refusal,
    detail,
  });

  // ---- 1. LOCK the identity. Nothing else may advance it mid-publication. ----
  //
  // Deliberately NOT filtered on `source_environment`: an evaluation identity
  // must be found and then explicitly REFUSED, because "not found" would be a
  // false diagnosis of the single most important boundary in this layer.
  //
  // `FOR NO KEY UPDATE`, not `FOR UPDATE`, and the difference is load-bearing.
  // This transaction changes `resolution_state` and `promoted_hotel_id` — no key
  // column — so the weaker mode is the honest one, and it still conflicts with
  // itself, so two concurrent publications of the same identity still serialise.
  //
  // `FOR UPDATE` would additionally conflict with the `FOR KEY SHARE` lock that
  // any FK child insert takes on this row, and A04.6's revocation is exactly
  // such a child: `source_property_review_revocations` references the identity.
  // A publication in flight would then BLOCK the emergency brake and win the
  // race — which is legal under SSI but is the wrong way round for a safety
  // action. With this mode the two contend on the review PROJECTION instead,
  // which is the row whose meaning they actually disagree about.
  const locked = await client.query<LockedIdentity>(
    `select i.id "identityId", i.source_property_id "sourcePropertyId", i.source,
            i.source_environment "environment", i.resolution_state "resolutionState",
            i.promoted_hotel_id "promotedHotelId",
            i.first_seen_at "firstSeenAt", i.last_seen_at "lastSeenAt",
            o.id "observationId", o.source_run_id "runId", o.source_payload_digest "payloadDigest",
            o.source_name "sourceName", o.source_address "sourceAddress"
       from public.source_property_identities i
       join public.source_property_observations o
         on o.source_property_identity_id = i.id and o.source_run_id = i.last_seen_run_id
      where i.id = $1
      for no key update of i`,
    [item.sourcePropertyIdentityId],
  );
  if (locked.rows.length !== 1)
    return refuse(
      "identity_not_found",
      "No such source identity, or it has no current observation.",
    );
  const current = locked.rows[0]!;

  if (current.source !== opts.source || current.sourcePropertyId !== item.sourcePropertyId)
    return refuse(
      "identity_mismatch",
      `The manifest describes ${opts.source}/${item.sourcePropertyId}; the identity is ${current.source}/${current.sourcePropertyId}.`,
    );

  // ---- 2. THE HARD ENVIRONMENT WALL. ----
  //
  // Checked before every other database read, and before anything at all could
  // be written. 0027 already makes an evaluation identity unlinkable and
  // ineligible, and 0034 refuses a non-production publication receipt — three
  // independent layers, because the cost of this one being wrong is permanent:
  // provider TEST data sitting in the canonical inventory a creator searches.
  //
  // The A04.7 pilot's eight real 11/11 PASS identities are `evaluation`. They
  // are exactly the population this refusal exists for, and they stay
  // unpublished.
  if (current.environment !== "production")
    return refuse(
      "evaluation_identity_not_publishable",
      `Source identity ${current.sourcePropertyId} is \`${current.environment}\`, not \`production\`. EVALUATION DATA NEVER BECOMES CANONICAL DATA — not by a bug, not by a script, and not by relabelling an identity to make a publication succeed. A D062 PASS on evaluation evidence is a statement about the evaluation corpus, never a publication authorization.`,
    );

  // ---- 3. EVIDENCE PINS. The prepared verdict must still describe today. ----
  if (current.observationId !== item.currentObservationId)
    return refuse(
      "stale_observation",
      `Prepared observation ${item.currentObservationId} is no longer current (${current.observationId}). Publication is irreversible; the authorizing human must look at the new evidence.`,
    );
  if (current.runId !== item.currentSourceRunId)
    return refuse("stale_run", "The current source run has changed since prepare.");
  if (current.payloadDigest !== item.sourcePayloadDigest)
    return refuse(
      "stale_payload_digest",
      "The current observation's payload digest has changed since prepare.",
    );

  // ---- 4. LOCK the review projection. Same order as A04.5 and A04.6. ----
  //
  // This is what makes a concurrent A04.6 revocation safe rather than merely
  // unlikely: the revocation path locks the same row, so the two serialise. The
  // loser sees the committed state of the winner and refuses.
  const projection = await client.query<{
    id: string;
    decision: string;
    review_status: string;
    current_receipt_id: string | null;
    destination_id: string | null;
  }>(
    `select rv.id, rv.decision, rv.review_status, rv.current_receipt_id, rv.destination_id
       from public.source_property_reviews rv
      where rv.source_property_identity_id = $1
      for update of rv`,
    [item.sourcePropertyIdentityId],
  );

  const digest = publicationDigestOf(item);

  // ---- 5. IDEMPOTENCY, before every state check that publication itself
  //         changes. ----
  //
  // Publishing makes the identity `resolved_eligible` and linked, so the
  // "not yet published" checks below would refuse an exact replay if they ran
  // first — turning idempotency into a guaranteed failure, exactly as A04.5 §9
  // describes for its own fingerprint ordering. The pins above already proved
  // this is the same identity, observation, run and payload.
  const existing = await client.query<{
    id: string;
    hotel_id: string;
    publication_digest: string;
  }>(
    `select id, hotel_id, publication_digest
       from public.source_property_publication_receipts
      where source_property_identity_id = $1`,
    [item.sourcePropertyIdentityId],
  );
  if (existing.rows.length > 0) {
    const prior = existing.rows[0]!;
    if (prior.publication_digest !== digest)
      return refuse(
        "conflicting_publication_exists",
        `Identity ${current.sourcePropertyId} is already published as hotel ${prior.hotel_id} (receipt ${prior.id}) under a materially different authorization. A second canonical property is never created for the same source identity; correcting a published property is a separate, unimplemented workflow.`,
      );
    const link = await client.query<{ id: string }>(
      `select id from public.hotel_source_identities
        where source_property_identity_id = $1 and hotel_id = $2`,
      [item.sourcePropertyIdentityId, prior.hotel_id],
    );
    return {
      ...id,
      state: "already_published",
      hotelId: prior.hotel_id,
      hotelSourceIdentityId: link.rows[0]!.id,
      publicationReceiptId: prior.id,
    };
  }

  // ---- 6. THE IDENTITY MUST NOT ALREADY BE LINKED OR RESOLVED. ----
  const priorLink = await client.query<{ id: string; hotel_id: string }>(
    `select id, hotel_id from public.hotel_source_identities
      where source_property_identity_id = $1 and link_status = 'active'`,
    [item.sourcePropertyIdentityId],
  );
  if (priorLink.rows.length > 0)
    return refuse(
      "identity_already_linked",
      `Identity ${current.sourcePropertyId} already holds an ACTIVE canonical link to hotel ${priorLink.rows[0]!.hotel_id}. Attaching a second source identity to an existing canonical hotel is \`approve_match\`, which A05 V1 does not implement.`,
    );
  if (current.resolutionState !== "unresolved")
    return refuse(
      "identity_not_unresolved",
      `Identity ${current.sourcePropertyId} is \`${current.resolutionState}\`, not \`unresolved\`. Publication is the transition out of \`unresolved\`; it is not a way to re-terminate an identity that already has a terminal state.`,
    );

  // ---- 7. THE HUMAN APPROVAL MUST STILL BE CURRENT AND AUTHORIZED. ----
  //
  // D062 conditions 1 and 2 already refuse every case below, and this layer asks
  // independently anyway. The evaluator is the publication gate; these checks are
  // what make the writer safe without assuming the gate ran correctly.
  if (projection.rows.length !== 1)
    return refuse(
      "human_review_missing",
      "No current human review projection exists for this identity. A05 publishes a human decision; there is nothing here to publish.",
    );
  const review = projection.rows[0]!;
  if (review.decision === "approve_match")
    return refuse(
      "approve_match_not_implemented",
      "The current human decision is `approve_match`. A05 V1 implements only `approve_create` -> create canonical hotel; A04.5 deliberately has no `approve_match` receipt model, so there is no authorization to publish here — not merely no code.",
    );
  if (review.decision !== "approve_create")
    return refuse(
      "publication_decision_not_supported",
      `The current human decision is \`${review.decision}\`. Only \`approve_create\` authorizes creating a canonical property.`,
    );
  if (review.id !== item.reviewProjectionId)
    return refuse(
      "stale_review_projection",
      "The current review projection is not the one this publication was prepared against.",
    );

  const revocation = await client.query<{ id: string }>(
    `select id from public.source_property_review_revocations where revoked_receipt_id = $1`,
    [review.current_receipt_id],
  );
  // The IMMUTABLE event and the MUTABLE column are read as an OR, exactly as
  // D062 does. `review_status` sits on a table admin/editor legitimately hold
  // UPDATE on; a revocation is an append-only fact, and it wins.
  if (revocation.rows.length > 0 || review.review_status === "revoked")
    return refuse(
      "human_review_revoked",
      `A human withdrew the approval on identity ${current.sourcePropertyId}${revocation.rows[0] ? ` (revocation ${revocation.rows[0].id})` : " (projection status `revoked`)"}. A withdrawn approval is not a weaker approval; it is not an approval. Authorization returns only through a fresh human review of fresh evidence.`,
    );

  if (review.current_receipt_id === null)
    return refuse(
      "review_projection_receipt_missing",
      "The current review projection names no receipt, so it cannot say WHICH approval authorizes this identity.",
    );
  if (review.current_receipt_id !== item.reviewCurrentReceiptId)
    return refuse(
      "stale_review_receipt",
      `The projection now represents receipt ${review.current_receipt_id}, not the prepared ${item.reviewCurrentReceiptId}.`,
    );
  if (review.current_receipt_id !== item.humanReviewReceiptId)
    return refuse(
      "review_projection_receipt_mismatch",
      "The manifest's human review receipt is not the receipt the current projection represents.",
    );
  if (review.destination_id !== item.destinationId)
    return refuse(
      "stale_destination",
      "The reviewed canonical destination has changed since prepare.",
    );

  const receipt = await client.query<{
    id: string;
    decision: string;
    evidence_observation_id: string;
    destination_id: string | null;
    new_property_finding_id: string | null;
  }>(
    `select id, decision, evidence_observation_id, destination_id, new_property_finding_id
       from public.source_property_review_receipts
      where id = $1 and source_property_identity_id = $2`,
    [item.humanReviewReceiptId, item.sourcePropertyIdentityId],
  );
  if (receipt.rows.length !== 1)
    return refuse(
      "human_review_receipt_missing",
      "The prepared human review receipt does not exist for this identity.",
    );
  const r = receipt.rows[0]!;
  if (r.decision !== "approve_create")
    return refuse(
      "human_review_receipt_decision_mismatch",
      `The cited receipt records \`${r.decision}\`. A defer authorizes nothing.`,
    );
  if (r.evidence_observation_id !== current.observationId)
    return refuse(
      "human_review_receipt_not_current",
      `The cited receipt reviewed observation ${r.evidence_observation_id}, which is no longer this identity's current observation (${current.observationId}). A decision about superseded evidence is not authorization for today's evidence.`,
    );
  if (r.destination_id !== item.destinationId)
    return refuse(
      "human_review_receipt_destination_mismatch",
      "The cited receipt names a different canonical destination from the review projection.",
    );
  if (r.new_property_finding_id !== item.humanNewPropertyFindingId)
    return refuse(
      "stale_new_property_finding",
      "The cited receipt rests on a different accepted `new_property` finding from the prepared one.",
    );

  // ---- 8. THE REAL D062 VERDICT, RECOMPUTED INSIDE THIS TRANSACTION. ----
  //
  // The prepared fingerprint is a PIN, never cached authorization. Both are
  // required: all eleven conditions must PASS on evidence read under this
  // transaction's snapshot, AND that evidence must be the evidence the human was
  // shown.
  const preview = previews.get(item.sourcePropertyIdentityId);
  if (!preview) return refuse("preview_unavailable", "A04 produced no preview for this identity.");
  if (!allElevenPass(preview)) {
    const failing = D062_CONDITION_NUMBERS.map((n) =>
      preview.conditions.find((c) => c.number === n),
    )
      .filter((c) => !c || c.status !== "PASS")
      .map((c, i) => (c ? `c${c.number}=${c.status}(${c.reason})` : `c?${i}=absent`))
      .join(", ");
    return refuse(
      "d062_not_pass",
      `D062 is \`${preview.overall}\` for this identity: ${failing}. Publication requires all eleven conditions to PASS on current evidence; a condition is never waived to let an authorization through.`,
    );
  }
  if (preview.schemaVersion !== item.previewSchemaVersion)
    return refuse(
      "stale_preview_schema_version",
      `The preview schema version is ${preview.schemaVersion}, not the prepared ${item.previewSchemaVersion}.`,
    );
  if (preview.fingerprint !== item.previewFingerprint)
    return refuse(
      "stale_preview_fingerprint",
      `The D062 fingerprint is ${preview.fingerprint}, not the prepared ${item.previewFingerprint}. Star, location, scope, lifecycle or entity evidence moved after the human authorized publication, so this authorization is about evidence that no longer exists.`,
    );

  // ---- 9. THE RESOLUTION HEADS MUST STILL BE THE PREPARED REVISIONS. ----
  const heads = await client.query<{
    star_revision_id: string | null;
    star_outcome: string | null;
    star_value: string | null;
    location_revision_id: string | null;
    location_outcome: string | null;
    latitude: string | null;
    longitude: string | null;
    scope_revision_id: string | null;
    scope_outcome: string | null;
  }>(
    `select st.id star_revision_id, st.outcome star_outcome, st.resolved_star_value::text star_value,
            lo.id location_revision_id, lo.outcome location_outcome,
            lo.resolved_latitude::text latitude, lo.resolved_longitude::text longitude,
            sc.id scope_revision_id, sc.outcome scope_outcome
       from public.source_property_identities i
       left join public.source_property_current_star_resolutions st
         on st.source_property_identity_id = i.id
       left join public.source_property_current_location_resolutions lo
         on lo.source_property_identity_id = i.id
       left join public.source_property_current_scope_resolutions sc
         on sc.source_property_identity_id = i.id
      where i.id = $1`,
    [item.sourcePropertyIdentityId],
  );
  const head = heads.rows[0]!;
  if (head.star_revision_id !== item.starRevisionId)
    return refuse("stale_star_revision", "The current star resolution revision has changed.");
  if (head.location_revision_id !== item.locationRevisionId)
    return refuse(
      "stale_location_revision",
      "The current location resolution revision has changed.",
    );
  if (head.scope_revision_id !== item.scopeRevisionId)
    return refuse("stale_scope_revision", "The current scope resolution revision has changed.");

  // ---- 10. CANONICAL FIELD POLICY. ----
  //
  // The provider observation is evidence, not canonical truth. Each field below
  // comes from the evidence layer D062 actually approved, and nothing is copied
  // merely because the provider supplied it.
  const destination = await client.query<{ slug: string; country_code: string | null }>(
    "select slug, country_code from public.destinations where id = $1",
    [item.destinationId],
  );
  if (destination.rows.length !== 1)
    return refuse(
      "destination_not_found",
      "The reviewed canonical destination no longer exists in the catalogue.",
    );
  const dest = destination.rows[0]!;

  const verdicts = await client.query<{ dimension: string; verdict: string }>(
    `select dimension, verdict from public.source_property_review_verifications
      where receipt_id = $1 and dimension in ('name', 'address')`,
    [item.humanReviewReceiptId],
  );
  const verdictOf = (dimension: string): string | null =>
    verdicts.rows.find((v) => v.dimension === dimension)?.verdict ?? null;

  // NAME. A canonical hotel needs a name, and A05 has no corrected-name field:
  // the only name available is the provider's, so publishing requires the human
  // to have affirmatively said it is right. `unavailable` is not `supports`, and
  // `contradicts` is the reviewer saying the provider is wrong.
  const nameVerdict = verdictOf("name");
  if (nameVerdict !== "supports")
    return refuse(
      "publication_name_not_human_supported",
      `The human review records name = \`${nameVerdict ?? "missing"}\`. A canonical hotel requires a name, the only name available is the provider's, and A05 has no corrected-name field — so a name the reviewer did not affirm is not publishable. Absence of evidence is not agreement.`,
    );
  const name = canonicalPublishedText(current.sourceName);
  if (!name)
    return refuse(
      "publication_name_missing",
      "The current observation carries no provider name to publish, and A05 never invents one.",
    );

  // ADDRESS is optional, and a human contradiction is PRESERVED rather than
  // normalized away. The A04.7 pilot proved a property can validly reach 11/11
  // while its address contradicts; publishing that address anyway would silently
  // overrule the reviewer.
  const addressVerdict = verdictOf("address");
  const address =
    addressVerdict === "supports" ? canonicalPublishedText(current.sourceAddress) : null;

  const starRating = head.star_value === null ? null : Number(head.star_value);
  if (head.star_outcome !== "exact_four" && head.star_outcome !== "exact_five")
    return refuse(
      "star_not_exactly_four_or_five",
      `The current star resolution is \`${head.star_outcome ?? "missing"}\`; D062 condition 6 admits exactly four or five.`,
    );
  if (head.location_outcome !== "resolved" || head.latitude === null || head.longitude === null)
    return refuse(
      "location_not_resolved",
      "The current location resolution is not `resolved`; raw provider coordinates are never published in its place.",
    );

  // ---- 11. WRITES. Nothing above this line has touched the database. ----
  const slug = await generateSlug(
    client,
    name,
    dest.slug,
    `${current.source}:${current.environment}:${current.sourcePropertyId}`,
  );

  const hotel = await client.query<{ id: string }>(
    `insert into public.hotels
       (name, slug, destination_id, country_code, address, latitude, longitude, star_rating,
        active_status, editorial_verification_status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'unknown','unverified')
     returning id`,
    [
      name,
      slug,
      item.destinationId,
      // Country is canonical geography, never a provider country string. NULL
      // when the destination itself does not record one: unknown stays unknown.
      dest.country_code,
      address,
      head.latitude,
      head.longitude,
      starRating,
    ],
  );
  const hotelId = hotel.rows[0]!.id;

  // Bounded, auditable evidence only. The publication receipt is the record;
  // this is the pointer back to it, and no provider payload is duplicated here.
  const matchEvidence = {
    a05: "source_publication/1",
    previewSchemaVersion: preview.schemaVersion,
    previewFingerprint: preview.fingerprint,
    previewAsOf: opts.asOf,
    humanReviewReceiptId: item.humanReviewReceiptId,
    humanNewPropertyFindingId: item.humanNewPropertyFindingId,
    starRevisionId: item.starRevisionId,
    locationRevisionId: item.locationRevisionId,
    scopeRevisionId: item.scopeRevisionId,
    publicationDigest: digest,
  };

  const link = await client.query<{ id: string }>(
    `insert into public.hotel_source_identities
       (hotel_id, source_property_identity_id, source, source_environment, source_property_id,
        link_status, match_method, match_evidence, linked_by_user_id, first_seen_at, last_seen_at)
     values ($1,$2,$3,$4,$5,'active',$6,$7::jsonb,$8,$9,$10)
     returning id`,
    [
      hotelId,
      item.sourcePropertyIdentityId,
      current.source,
      current.environment,
      current.sourcePropertyId,
      PUBLICATION_MATCH_METHOD,
      JSON.stringify(matchEvidence),
      item.authorizedByUserId ?? null,
      current.firstSeenAt,
      current.lastSeenAt,
    ],
  );
  const linkId = link.rows[0]!.id;

  const publication = await client.query<{ id: string }>(
    `insert into public.source_property_publication_receipts
       (source_property_identity_id, source, source_environment, source_property_id, hotel_id,
        evidence_observation_id, human_review_receipt_id, human_new_property_finding_id,
        star_revision_id, location_revision_id, scope_revision_id,
        preview_as_of, preview_schema_version, preview_fingerprint,
        publication_authorized_by_user_id, publication_authorized_by_label, authorization_note,
        authorized_at, publication_digest)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::date,$13,$14,$15,$16,$17, now(), $18)
     returning id`,
    [
      item.sourcePropertyIdentityId,
      current.source,
      current.environment,
      current.sourcePropertyId,
      hotelId,
      current.observationId,
      item.humanReviewReceiptId,
      item.humanNewPropertyFindingId,
      item.starRevisionId,
      item.locationRevisionId,
      item.scopeRevisionId,
      opts.asOf,
      preview.schemaVersion,
      preview.fingerprint,
      item.authorizedByUserId ?? null,
      item.authorizedByLabel,
      item.authorizationNote,
      digest,
    ],
  );

  // The terminal transition comes LAST, after the hotel and its ACTIVE link both
  // exist — 0027's composite FK and `enforce_eligible_requires_active_link()`
  // require exactly that, and 0034's deferred trigger re-checks the pair at
  // COMMIT from both sides.
  await client.query(
    `update public.source_property_identities
        set resolution_state = 'resolved_eligible',
            promoted_hotel_id = $2,
            resolution_reason = null
      where id = $1`,
    [item.sourcePropertyIdentityId, hotelId],
  );

  return {
    ...id,
    state: "would_publish",
    hotelId,
    hotelSourceIdentityId: linkId,
    publicationReceiptId: publication.rows[0]!.id,
  };
}
