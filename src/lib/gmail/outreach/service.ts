import type { createAdminClient } from "@/lib/supabase/admin";
import {
  CLASSIFIER_INPUT_TRANSFORM_VERSION,
  OUTREACH_DETECTOR_VERSION,
  TARGET_MATCHER_VERSION,
  requirePositiveInteger,
  requireVersionShape,
  type CreatorDecisionAxis,
  type EvidenceMessage,
  type EvidenceRecipient,
  type EvidenceSubject,
  type EvidenceTextPart,
  type OutreachDecisionValue,
  type TargetAction,
  type TargetObservationInput,
  type TargetScope,
  type ThreadEvidence,
} from "@/lib/gmail/outreach/contract";
import { computeEvidenceDigest } from "@/lib/gmail/outreach/digest";
import { OutreachStructuralError } from "@/lib/gmail/outreach/errors";
import { classifyOutreach } from "@/lib/gmail/outreach/interpreter";
import { assessTargetContacts } from "@/lib/gmail/outreach/recipients";
import {
  deriveMachineTargetScope,
  extractDomain,
  extractTargetObservations,
  matchTargetObservation,
  type CatalogSnapshot,
} from "@/lib/gmail/outreach/target-extraction";

/**
 * B05's OPERATIONAL LOGIC — deliberately WITHOUT `server-only`, for exactly
 * the reason B04's `service.ts` documents: `createAdminClient` is imported
 * here as a TYPE ONLY, erased at compile time, so this module can run under
 * plain `tsx`/Node (the operator CLI) as well as inside the Next.js app via
 * `service.server.ts`'s thin wrapper.
 */
export interface OutreachDeps {
  db: ReturnType<typeof createAdminClient>;
}

export { requirePositiveInteger };

// ---------------------------------------------------------------------------
// Thread evidence + the source-evidence fence
// ---------------------------------------------------------------------------

interface RawEvidenceResponse {
  result: string;
  normalized_thread_id?: string;
  provider_thread_id?: string;
  messages?: Array<{
    normalized_message_id: string;
    provider_message_id: string;
    provider_sent: boolean;
    internal_date_ms: number;
    source_payload_sha256: string;
  }>;
  sent_text_parts?: Array<{
    normalized_message_id: string;
    part_path: number[];
    mime_type: "text/plain" | "text/html";
    decode_status: string;
    decoded_text: string | null;
  }>;
  sent_recipients?: Array<{
    normalized_message_id: string;
    source_header_id: string;
    source_participant_id: string;
    role: EvidenceRecipient["role"];
    display_name: string | null;
    addr_spec: string | null;
    local_part: string | null;
    domain: string | null;
    domain_lower: string | null;
    parse_status: EvidenceRecipient["parseStatus"];
  }>;
  subjects?: Array<{ normalized_message_id: string; raw_value: string }>;
}

export type GetThreadEvidenceResult =
  { result: "ok"; evidence: ThreadEvidence; evidenceDigest: string } | { result: "not_found" };

export async function getThreadEvidence(
  deps: OutreachDeps,
  input: { userId: string; mailAccountId: string; normalizedThreadId: string },
): Promise<GetThreadEvidenceResult> {
  const { data: rawData, error } = await deps.db.rpc("gmail_outreach_get_thread_evidence", {
    p_user_id: input.userId,
    p_mail_account_id: input.mailAccountId,
    p_normalized_thread_id: input.normalizedThreadId,
  });

  if (error || !rawData) {
    throw new Error(`gmail_outreach_get_thread_evidence failed: ${error?.message ?? "no data"}`);
  }

  const data = rawData as RawEvidenceResponse;
  if (data.result === "not_found") return { result: "not_found" };
  if (data.result !== "ok") {
    throw new OutreachStructuralError(
      `gmail_outreach_get_thread_evidence returned unknown result: ${data.result}`,
    );
  }

  const messages: EvidenceMessage[] = (data.messages ?? []).map((m) => ({
    normalizedMessageId: m.normalized_message_id,
    providerMessageId: m.provider_message_id,
    providerSent: m.provider_sent,
    internalDateMs: m.internal_date_ms,
    sourcePayloadSha256: m.source_payload_sha256,
  }));

  const sentTextParts: EvidenceTextPart[] = (data.sent_text_parts ?? []).map((tp) => ({
    normalizedMessageId: tp.normalized_message_id,
    partPath: tp.part_path,
    mimeType: tp.mime_type,
    decodeStatus: tp.decode_status,
    decodedText: tp.decoded_text,
  }));

  const sentRecipients: EvidenceRecipient[] = (data.sent_recipients ?? []).map((r) => ({
    normalizedMessageId: r.normalized_message_id,
    sourceHeaderId: r.source_header_id,
    sourceParticipantId: r.source_participant_id,
    role: r.role,
    displayName: r.display_name,
    addrSpec: r.addr_spec,
    localPart: r.local_part,
    domain: r.domain,
    domainLower: r.domain_lower,
    parseStatus: r.parse_status,
  }));

  const subjects: EvidenceSubject[] = (data.subjects ?? []).map((s) => ({
    normalizedMessageId: s.normalized_message_id,
    rawValue: s.raw_value,
  }));

  const evidence: ThreadEvidence = {
    normalizedThreadId: data.normalized_thread_id!,
    providerThreadId: data.provider_thread_id!,
    messages,
    sentTextParts,
    sentRecipients,
    subjects,
  };

  return { result: "ok", evidence, evidenceDigest: computeEvidenceDigest(messages) };
}

// ---------------------------------------------------------------------------
// Catalog snapshot (deterministic, bounded, epoch-stamped)
// ---------------------------------------------------------------------------

export async function getCurrentCatalogEpoch(deps: OutreachDeps): Promise<number> {
  const { data, error } = await deps.db.rpc("gmail_outreach_current_catalog_epoch", {});
  if (error || data === null || data === undefined) {
    throw new Error(`gmail_outreach_current_catalog_epoch failed: ${error?.message ?? "no data"}`);
  }
  return Number(data);
}

/** Escapes a literal value for safe use inside a PostgREST `.or()` filter string (commas/parens are the filter's own delimiters). */
function escapeOrFilterValue(value: string): string {
  return value.replace(/[,()]/g, "");
}

/**
 * A bounded, deterministic snapshot of the canonical rows RELEVANT to this
 * thread's evaluation. This is the ONLY place B05 reads `public.hotels`/
 * `public.organizations`/`public.hotel_contacts`/`public.organization_
 * contacts` — read-only, never mutated.
 *
 * EXTERNAL AUDIT AMENDMENT #1, Finding 4/5: this used to fetch the ENTIRE
 * `hotels`/`organizations` tables for every single thread, and matched
 * contact emails via `.in("email", lowerAddresses)` — case-sensitive against
 * stored text, while the SQL side compares `lower(email) = lower(addr_
 * spec)`, so a differently-cased stored email silently never matched here.
 * Both are fixed: the candidate universe is now BOUNDED to hotels/
 * organizations actually reachable from this thread's own evidence (an
 * exact contact-email match, or a website domain matching one of the
 * observed target domains) — an unrelated hotel added anywhere else in the
 * catalog costs this function nothing — and every email comparison is
 * case-insensitive via `ilike` on the literal address (no wildcard
 * characters), matching the database's own `lower(email) = lower(addr_
 * spec)` rule exactly. Contact lookups are also MULTIMAPS (Finding 5): one
 * email can legitimately match several hotel_contacts rows.
 */
export async function getCatalogSnapshot(
  deps: OutreachDeps,
  input: { associatedAddresses: readonly string[]; observedDomains: readonly string[] },
): Promise<CatalogSnapshot> {
  const epoch = await getCurrentCatalogEpoch(deps);

  const lowerAddresses = [...new Set(input.associatedAddresses.map((a) => a.toLowerCase()))];
  const domains = [...new Set(input.observedDomains.map((d) => d.toLowerCase()))];

  const hotelIdByContactEmail = new Map<string, Set<string>>();
  const organizationIdByContactEmail = new Map<string, Set<string>>();

  if (lowerAddresses.length === 0 && domains.length === 0) {
    return {
      epoch,
      hotels: [],
      organizations: [],
      hotelIdByContactEmail,
      organizationIdByContactEmail,
    };
  }

  const contactOrFilter = lowerAddresses
    .map((a) => `email.ilike.${escapeOrFilterValue(a)}`)
    .join(",");

  const [{ data: hotelContacts, error: hcError }, { data: orgContacts, error: ocError }] =
    lowerAddresses.length > 0
      ? await Promise.all([
          deps.db.from("hotel_contacts").select("hotel_id, email").or(contactOrFilter),
          deps.db
            .from("organization_contacts")
            .select("organization_id, email")
            .or(contactOrFilter),
        ])
      : [
          { data: [] as unknown, error: null },
          { data: [] as unknown, error: null },
        ];
  if (hcError) throw new Error(`hotel_contacts lookup failed: ${hcError.message}`);
  if (ocError) throw new Error(`organization_contacts lookup failed: ${ocError.message}`);

  const matchedHotelIds = new Set<string>();
  for (const row of (hotelContacts ?? []) as Array<{ hotel_id: string; email: string | null }>) {
    if (!row.email) continue;
    const key = row.email.toLowerCase();
    matchedHotelIds.add(row.hotel_id);
    const set = hotelIdByContactEmail.get(key) ?? new Set<string>();
    set.add(row.hotel_id);
    hotelIdByContactEmail.set(key, set);
  }
  const matchedOrgIds = new Set<string>();
  for (const row of (orgContacts ?? []) as Array<{
    organization_id: string;
    email: string | null;
  }>) {
    if (!row.email) continue;
    const key = row.email.toLowerCase();
    matchedOrgIds.add(row.organization_id);
    const set = organizationIdByContactEmail.get(key) ?? new Set<string>();
    set.add(row.organization_id);
    organizationIdByContactEmail.set(key, set);
  }

  // The BOUNDED candidate universe: reachable by an exact contact-email
  // match, or a website domain containing one of the observed target
  // domains. `website_url` is free text (not normalized to a bare domain in
  // the schema), so a domain match is necessarily an `ilike` substring test
  // rather than an exact equality — still vastly narrower than every row.
  const hotelOrParts = [
    ...[...matchedHotelIds].map((id) => `id.eq.${id}`),
    ...domains.map((d) => `website_url.ilike.%${escapeOrFilterValue(d)}%`),
  ];
  const orgOrParts = [
    ...[...matchedOrgIds].map((id) => `id.eq.${id}`),
    ...domains.map((d) => `website_url.ilike.%${escapeOrFilterValue(d)}%`),
  ];

  const [{ data: hotelsData, error: hotelsError }, { data: orgsData, error: orgsError }] =
    await Promise.all([
      hotelOrParts.length > 0
        ? deps.db.from("hotels").select("id, name, website_url").or(hotelOrParts.join(","))
        : Promise.resolve({ data: [] as unknown, error: null }),
      orgOrParts.length > 0
        ? deps.db.from("organizations").select("id, name, website_url").or(orgOrParts.join(","))
        : Promise.resolve({ data: [] as unknown, error: null }),
    ]);

  if (hotelsError) throw new Error(`hotels lookup failed: ${hotelsError.message}`);
  if (orgsError) throw new Error(`organizations lookup failed: ${orgsError.message}`);

  const hotels = (
    (hotelsData ?? []) as Array<{ id: string; name: string; website_url: string | null }>
  ).map((h) => ({
    id: h.id,
    name: h.name,
    websiteDomain: extractDomain(h.website_url),
  }));
  const organizations = (
    (orgsData ?? []) as Array<{ id: string; name: string; website_url: string | null }>
  ).map((o) => ({ id: o.id, name: o.name, websiteDomain: extractDomain(o.website_url) }));

  return { epoch, hotels, organizations, hotelIdByContactEmail, organizationIdByContactEmail };
}

// ---------------------------------------------------------------------------
// Interpret ONE thread — classify, extract, match, commit atomically
// ---------------------------------------------------------------------------

export type InterpretThreadOutcome =
  | { result: "ok"; outreachStatus: string }
  | { result: "stale_source"; currentEvidenceDigest: string }
  | { result: "stale_catalog"; currentCatalogEpoch: number }
  | { result: "thread_not_found" }
  | { result: "account_deleted" }
  | { result: "not_found" };

interface CommitResponse {
  result: string;
  normalized_thread_id?: string;
  current_evidence_digest?: string;
  current_catalog_epoch?: number;
}

export async function interpretOneThread(
  deps: OutreachDeps,
  input: { userId: string; mailAccountId: string; normalizedThreadId: string },
): Promise<InterpretThreadOutcome> {
  const evidenceResult = await getThreadEvidence(deps, input);
  if (evidenceResult.result === "not_found") return { result: "thread_not_found" };

  const { evidence, evidenceDigest } = evidenceResult;

  const outreach = classifyOutreach({
    messages: evidence.messages,
    sentTextParts: evidence.sentTextParts,
    subjects: evidence.subjects,
  });

  // EXTERNAL AUDIT AMENDMENT #1, Finding 7: recipient/target extraction runs
  // for EVERY evaluated thread, regardless of outreach classification.
  // OBSERVED is literal evidence, not interpretation — a machine false
  // negative (`not_outreach`/`insufficient_evidence`) must never permanently
  // prevent a later creator correction to `outreach_confirmed` from having
  // any observed recipients or target candidates to act on.
  const recipientParticipantIds = evidence.sentRecipients.map((r) => r.sourceParticipantId);

  const contactAssessment = assessTargetContacts(evidence.sentRecipients);
  const targetContactCandidates = contactAssessment.candidates.map((c) => ({
    source_participant_id: c.sourceParticipantId,
    role_evidence: c.roleEvidence,
    address_pattern_evidence: c.addressPatternEvidence,
    rank: c.rank,
  }));

  const messageIdToProviderId = new Map(
    evidence.messages.map((m) => [m.normalizedMessageId, m.providerMessageId]),
  );
  const rawObservations = extractTargetObservations(evidence.sentRecipients, messageIdToProviderId);
  const associatedAddresses = evidence.sentRecipients
    .filter((r) => r.role === "to" && r.addrSpec)
    .map((r) => r.addrSpec as string);
  const observedDomains = rawObservations
    .map((o) => o.observedDomain)
    .filter((d): d is string => d !== null);

  const targetObservations: TargetObservationInput[] = [];
  const targetCanonicalLinks: Array<Record<string, unknown>> = [];
  // Only touch the catalog when there is something to actually match against
  // (EXTERNAL AUDIT AMENDMENT #1, Finding 4) — most threads extract zero raw
  // observations (freemail-only, or no `to` recipients at all), and those
  // threads have no reason to read `hotels`/`organizations` at all.
  let catalogEpoch: number;

  if (rawObservations.length > 0) {
    const catalog = await getCatalogSnapshot(deps, { associatedAddresses, observedDomains });
    catalogEpoch = catalog.epoch;

    for (const raw of rawObservations) {
      const matched = matchTargetObservation(raw, associatedAddresses, catalog);
      targetObservations.push(matched.observation);
      for (const link of matched.links) {
        targetCanonicalLinks.push({
          observation_fingerprint: link.observationFingerprint,
          target_kind: link.targetKind,
          target_hotel_id: link.targetHotelId ?? "",
          target_organization_id: link.targetOrganizationId ?? "",
          name_evidence: link.nameEvidence,
          domain_evidence: link.domainEvidence,
          address_evidence: link.addressEvidence,
          contact_evidence: link.contactEvidence,
          rank: link.rank,
        });
      }
    }
  } else {
    catalogEpoch = await getCurrentCatalogEpoch(deps);
  }

  // EXTERNAL AUDIT AMENDMENT #1, Finding 6: the machine's own thread-level
  // target-scope hint. Always computed (even zero observations legitimately
  // report `unresolved`) and always advisory.
  const machineScope = deriveMachineTargetScope(targetObservations);

  const { data: rawData, error } = await deps.db.rpc("gmail_outreach_commit_interpretation", {
    p_user_id: input.userId,
    p_mail_account_id: input.mailAccountId,
    p_normalized_thread_id: input.normalizedThreadId,
    p_detector_version: requireVersionShape(OUTREACH_DETECTOR_VERSION, "detectorVersion"),
    p_matcher_version: requireVersionShape(TARGET_MATCHER_VERSION, "matcherVersion"),
    p_expected_evidence_digest: evidenceDigest,
    p_outreach_status: outreach.status,
    p_reason_codes: outreach.reasonCodes,
    p_recipient_participant_ids: recipientParticipantIds,
    p_target_contact_match_quality: contactAssessment.matchQuality,
    p_target_contact_candidate_set_fingerprint: contactAssessment.candidateSetFingerprint,
    p_target_contact_candidates: targetContactCandidates,
    p_target_observations: targetObservations.map((o) => ({
      observation_fingerprint: o.observationFingerprint,
      observed_name: o.observedName,
      observed_domain: o.observedDomain,
      target_kind_hint: o.targetKindHint,
      source_provider_message_ids: o.sourceProviderMessageIds,
      machine_canonical_link_assessment: o.machineCanonicalLinkAssessment,
      candidate_set_fingerprint: o.candidateSetFingerprint,
    })),
    p_target_canonical_links: targetCanonicalLinks,
    p_machine_target_scope: machineScope.scope,
    p_target_scope_reason_codes: machineScope.reasonCodes,
    p_catalog_epoch: catalogEpoch,
  });

  if (error || !rawData) {
    throw new Error(`gmail_outreach_commit_interpretation failed: ${error?.message ?? "no data"}`);
  }

  const data = rawData as CommitResponse;
  switch (data.result) {
    case "ok":
      return { result: "ok", outreachStatus: outreach.status };
    case "stale_source":
      return { result: "stale_source", currentEvidenceDigest: data.current_evidence_digest! };
    case "stale_catalog":
      return { result: "stale_catalog", currentCatalogEpoch: data.current_catalog_epoch! };
    case "thread_not_found":
      return { result: "thread_not_found" };
    case "account_deleted":
      return { result: "account_deleted" };
    case "not_found":
      return { result: "not_found" };
    default:
      throw new OutreachStructuralError(
        `gmail_outreach_commit_interpretation returned unknown result: ${data.result}`,
      );
  }
}

// ---------------------------------------------------------------------------
// Bounded batch + until-idle worker — mirrors B04's normalizeMailboxUntilIdle
// ---------------------------------------------------------------------------

interface CandidatesResponse {
  result: string;
  candidates: Array<{ normalized_thread_id: string; provider_thread_id: string }>;
}

export interface InterpretOutcomeRecord {
  normalizedThreadId: string;
  result: InterpretThreadOutcome["result"];
}

export interface InterpretBatchSummary {
  candidatesFound: number;
  interpreted: number;
  staleSource: number;
  staleCatalog: number;
  other: number;
  outcomes: InterpretOutcomeRecord[];
}

function emptyBatchSummary(): InterpretBatchSummary {
  return {
    candidatesFound: 0,
    interpreted: 0,
    staleSource: 0,
    staleCatalog: 0,
    other: 0,
    outcomes: [],
  };
}

export async function interpretBatch(
  deps: OutreachDeps,
  input: {
    userId: string;
    mailAccountId: string;
    limit: number;
    excludeNormalizedThreadIds?: readonly string[];
  },
): Promise<InterpretBatchSummary> {
  const limit = requirePositiveInteger(input.limit, "limit");
  const currentCatalogEpoch = await getCurrentCatalogEpoch(deps);

  const { data: rawData, error } = await deps.db.rpc("gmail_outreach_list_candidates", {
    p_user_id: input.userId,
    p_mail_account_id: input.mailAccountId,
    p_detector_version: OUTREACH_DETECTOR_VERSION,
    p_matcher_version: TARGET_MATCHER_VERSION,
    p_current_catalog_epoch: currentCatalogEpoch,
    p_limit: limit,
    p_exclude_normalized_thread_ids: input.excludeNormalizedThreadIds ?? [],
  });

  if (error || !rawData) {
    throw new Error(`gmail_outreach_list_candidates failed: ${error?.message ?? "no data"}`);
  }

  const data = rawData as CandidatesResponse;
  const summary = emptyBatchSummary();
  summary.candidatesFound = data.candidates.length;

  for (const candidate of data.candidates) {
    const outcome = await interpretOneThread(deps, {
      userId: input.userId,
      mailAccountId: input.mailAccountId,
      normalizedThreadId: candidate.normalized_thread_id,
    });
    summary.outcomes.push({
      normalizedThreadId: candidate.normalized_thread_id,
      result: outcome.result,
    });
    if (outcome.result === "ok") summary.interpreted += 1;
    else if (outcome.result === "stale_source") summary.staleSource += 1;
    else if (outcome.result === "stale_catalog") summary.staleCatalog += 1;
    else summary.other += 1;
  }

  return summary;
}

const PROGRESS_RESULTS = new Set<InterpretThreadOutcome["result"]>(["ok"]);
const MAX_ATTEMPTS_PER_CANDIDATE = 5;

export interface InterpretUntilIdleResult extends InterpretBatchSummary {
  completed: boolean;
  gaveUpCount: number;
}

/** Interpret ALL currently stale/missing threads for a mailbox, in bounded batches. Never infinite-loops on a permanently-failing thread. */
export async function outreachInterpretMailboxUntilIdle(
  deps: OutreachDeps,
  input: { userId: string; mailAccountId: string; batchSize: number },
): Promise<InterpretUntilIdleResult> {
  const batchSize = requirePositiveInteger(input.batchSize, "batchSize");

  const total = emptyBatchSummary();
  const attempts = new Map<string, number>();
  const excluded = new Set<string>();
  let gaveUpCount = 0;

  for (;;) {
    const batch = await interpretBatch(deps, {
      userId: input.userId,
      mailAccountId: input.mailAccountId,
      limit: batchSize,
      excludeNormalizedThreadIds: [...excluded],
    });

    total.candidatesFound += batch.candidatesFound;
    total.interpreted += batch.interpreted;
    total.staleSource += batch.staleSource;
    total.staleCatalog += batch.staleCatalog;
    total.other += batch.other;
    total.outcomes.push(...batch.outcomes);

    if (batch.candidatesFound === 0) {
      return { ...total, completed: gaveUpCount === 0, gaveUpCount };
    }

    for (const outcome of batch.outcomes) {
      if (PROGRESS_RESULTS.has(outcome.result)) {
        attempts.delete(outcome.normalizedThreadId);
        continue;
      }
      const attemptCount = (attempts.get(outcome.normalizedThreadId) ?? 0) + 1;
      attempts.set(outcome.normalizedThreadId, attemptCount);
      if (attemptCount >= MAX_ATTEMPTS_PER_CANDIDATE) {
        excluded.add(outcome.normalizedThreadId);
        gaveUpCount += 1;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Creator decisions — the ONLY human writer
// ---------------------------------------------------------------------------

export type RecordCreatorDecisionInput =
  | { axis: "outreach"; outreachDecision: OutreachDecisionValue }
  | { axis: "target_scope"; targetScopeDecision: TargetScope }
  | { axis: "target"; targetAction: TargetAction; targetObservationId: string }
  | { axis: "target_contact"; targetAction: TargetAction; observedRecipientId: string };

export type RecordCreatorDecisionResult =
  | { result: "ok"; eventId: string }
  | { result: "unauthenticated" }
  | { result: "not_found" }
  | { result: "account_deleted" }
  | { result: "thread_not_found" }
  | { result: "observation_not_found" }
  | { result: "recipient_not_found" };

interface DecisionResponse {
  result: string;
  event_id?: string;
}

/**
 * EXTERNAL AUDIT AMENDMENT #1, Finding 2: `deps.db` here MUST be a
 * user-scoped client whose session carries the real creator's own
 * `auth.uid()` — the repository's `@/lib/supabase/server` cookie-bound
 * client, exactly as `service.server.ts`'s `defaultCreatorDecisionDeps()`
 * constructs it — never the service-role admin client the other B05
 * functions in this module use. There is no `userId`/`p_user_id` parameter
 * any more: the database derives the actor from the session itself, so a
 * caller cannot assert authorship it does not actually have. A machine/
 * service-role caller with no such session gets `unauthenticated`.
 */
export async function recordCreatorDecision(
  deps: OutreachDeps,
  input: {
    mailAccountId: string;
    normalizedThreadId: string;
  } & RecordCreatorDecisionInput,
): Promise<RecordCreatorDecisionResult> {
  const axis: CreatorDecisionAxis = input.axis;

  const { data: rawData, error } = await deps.db.rpc("gmail_outreach_record_creator_decision", {
    p_mail_account_id: input.mailAccountId,
    p_normalized_thread_id: input.normalizedThreadId,
    p_axis: axis,
    p_outreach_decision: input.axis === "outreach" ? input.outreachDecision : null,
    p_target_scope_decision: input.axis === "target_scope" ? input.targetScopeDecision : null,
    p_target_action:
      input.axis === "target" || input.axis === "target_contact" ? input.targetAction : null,
    p_target_observation_id: input.axis === "target" ? input.targetObservationId : null,
    p_observed_recipient_id: input.axis === "target_contact" ? input.observedRecipientId : null,
  });

  if (error || !rawData) {
    throw new Error(
      `gmail_outreach_record_creator_decision failed: ${error?.message ?? "no data"}`,
    );
  }

  const data = rawData as DecisionResponse;
  switch (data.result) {
    case "ok":
      return { result: "ok", eventId: data.event_id! };
    case "unauthenticated":
    case "not_found":
    case "account_deleted":
    case "thread_not_found":
    case "observation_not_found":
    case "recipient_not_found":
      return { result: data.result };
    default:
      throw new OutreachStructuralError(
        `gmail_outreach_record_creator_decision returned unknown result: ${data.result}`,
      );
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface OutreachStatusCounts {
  normalizedThreads: number;
  threadsClassified: number;
  qualifiedOutreachThreads: number;
  targetObservations: number;
  confirmedTargets: number;
  observedRecipients: number;
  confirmedTargetContacts: number;
}

export async function getOutreachStatus(
  deps: OutreachDeps,
  input: { userId: string; mailAccountId: string },
): Promise<{ result: "ok"; counts: OutreachStatusCounts } | { result: "not_found" }> {
  const { data: rawData, error } = await deps.db.rpc("gmail_outreach_status", {
    p_user_id: input.userId,
    p_mail_account_id: input.mailAccountId,
  });

  if (error || !rawData) {
    throw new Error(`gmail_outreach_status failed: ${error?.message ?? "no data"}`);
  }

  const data = rawData as {
    result: string;
    normalized_threads?: number;
    threads_classified?: number;
    qualified_outreach_threads?: number;
    target_observations?: number;
    confirmed_targets?: number;
    observed_recipients?: number;
    confirmed_target_contacts?: number;
  };

  if (data.result === "not_found") return { result: "not_found" };
  if (data.result !== "ok") {
    throw new OutreachStructuralError(
      `gmail_outreach_status returned unknown result: ${data.result}`,
    );
  }

  return {
    result: "ok",
    counts: {
      normalizedThreads: data.normalized_threads ?? 0,
      threadsClassified: data.threads_classified ?? 0,
      qualifiedOutreachThreads: data.qualified_outreach_threads ?? 0,
      targetObservations: data.target_observations ?? 0,
      confirmedTargets: data.confirmed_targets ?? 0,
      observedRecipients: data.observed_recipients ?? 0,
      confirmedTargetContacts: data.confirmed_target_contacts ?? 0,
    },
  };
}

export { CLASSIFIER_INPUT_TRANSFORM_VERSION, OUTREACH_DETECTOR_VERSION, TARGET_MATCHER_VERSION };
