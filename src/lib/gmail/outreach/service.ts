import type { createAdminClient } from "@/lib/supabase/admin";
import {
  CLASSIFIER_INPUT_TRANSFORM_VERSION,
  OUTREACH_DETECTOR_VERSION,
  TARGET_MATCHER_VERSION,
  requirePositiveInteger,
  requireVersionShape,
  type CandidateStaleness,
  type CreatorDecisionAxis,
  type EvidenceMessage,
  type EvidenceRecipient,
  type EvidenceSubject,
  type EvidenceTextPart,
  type MachineStateSnapshot,
  type MatchQuality,
  type OutreachDecisionValue,
  type OutreachStatus,
  type TargetAction,
  type TargetCanonicalLinkCandidateInput,
  type TargetObservationInput,
  type TargetScope,
  type ThreadEvidence,
} from "@/lib/gmail/outreach/contract";
import { computeEvidenceDigest } from "@/lib/gmail/outreach/digest";
import { OutreachStructuralError } from "@/lib/gmail/outreach/errors";
import { classifyOutreach as classifyOutreachDefault } from "@/lib/gmail/outreach/interpreter";
import { assessTargetContacts } from "@/lib/gmail/outreach/recipients";
import { buildClassifierInputForMessage } from "@/lib/gmail/outreach/text-transform";
import {
  computeAuthoredTextTargetEvidence,
  computeRelevantCandidateFingerprint,
  deriveMachineTargetScope,
  detectScopeLanguage,
  extractAuthoredTextNameCandidates,
  extractDomain,
  extractTargetObservations,
  matchTargetObservation as matchTargetObservationDefault,
  type CatalogSnapshot,
  type HotelOrganizationLink,
  type ScopeCandidate,
} from "@/lib/gmail/outreach/target-extraction";

/**
 * B05's OPERATIONAL LOGIC — deliberately WITHOUT `server-only`, for exactly
 * the reason B04's `service.ts` documents: `createAdminClient` is imported
 * here as a TYPE ONLY, erased at compile time, so this module can run under
 * plain `tsx`/Node (the operator CLI) as well as inside the Next.js app via
 * `service.server.ts`'s thin wrapper.
 *
 * `classifyOutreach`/`matchTargetObservation` are OPTIONAL injectable
 * overrides of the real implementations (EXTERNAL AUDIT AMENDMENT #2,
 * Finding 4) — production code never sets them; tests wrap the real
 * functions with a counting adapter to PROVE the two-level fast path
 * actually skips the classifier/matcher rather than merely inferring it from
 * equal final output.
 */
export interface OutreachDeps {
  db: ReturnType<typeof createAdminClient>;
  classifyOutreach?: typeof classifyOutreachDefault;
  matchTargetObservation?: typeof matchTargetObservationDefault;
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
  machine_state?: {
    thread_signal: {
      outreach_status: string;
      reason_codes: string[];
      detector_version: string;
    } | null;
    target_contact_signal: {
      match_quality: string;
      matcher_version: string;
      evaluated_epoch: number;
      candidate_set_fingerprint: string;
    } | null;
    target_scope_signal: {
      machine_target_scope: string;
      matcher_version: string;
      evaluated_epoch: number;
    } | null;
    target_observations: Array<{
      observation_fingerprint: string;
      matcher_version: string | null;
      evaluated_epoch: number | null;
      candidate_set_fingerprint: string | null;
      machine_canonical_link_assessment: string | null;
      best_canonical_link: {
        target_kind: "hotel" | "organization";
        target_hotel_id: string | null;
        target_organization_id: string | null;
        contact_evidence: "agrees" | "differs" | "unavailable";
      } | null;
    }>;
  };
}

export type GetThreadEvidenceResult =
  | {
      result: "ok";
      evidence: ThreadEvidence;
      evidenceDigest: string;
      machineState: MachineStateSnapshot;
    }
  | { result: "not_found" }
  | { result: "account_deleted" }
  | { result: "deletion_pending" }
  | { result: "consent_missing" };

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
  if (
    data.result === "not_found" ||
    data.result === "account_deleted" ||
    data.result === "deletion_pending" ||
    data.result === "consent_missing"
  ) {
    return { result: data.result };
  }
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

  const rawMachineState = data.machine_state ?? {
    thread_signal: null,
    target_contact_signal: null,
    target_scope_signal: null,
    target_observations: [],
  };
  const machineState: MachineStateSnapshot = {
    threadSignal: rawMachineState.thread_signal
      ? {
          outreachStatus: rawMachineState.thread_signal.outreach_status as OutreachStatus,
          reasonCodes: rawMachineState.thread_signal.reason_codes,
          detectorVersion: rawMachineState.thread_signal.detector_version,
        }
      : null,
    targetContactSignal: rawMachineState.target_contact_signal
      ? {
          matchQuality: rawMachineState.target_contact_signal.match_quality as MatchQuality,
          matcherVersion: rawMachineState.target_contact_signal.matcher_version,
          evaluatedEpoch: rawMachineState.target_contact_signal.evaluated_epoch,
          candidateSetFingerprint: rawMachineState.target_contact_signal.candidate_set_fingerprint,
        }
      : null,
    targetScopeSignal: rawMachineState.target_scope_signal
      ? {
          machineTargetScope: rawMachineState.target_scope_signal
            .machine_target_scope as TargetScope,
          matcherVersion: rawMachineState.target_scope_signal.matcher_version,
          evaluatedEpoch: rawMachineState.target_scope_signal.evaluated_epoch,
        }
      : null,
    targetObservations: rawMachineState.target_observations.map((o) => ({
      observationFingerprint: o.observation_fingerprint,
      matcherVersion: o.matcher_version,
      evaluatedEpoch: o.evaluated_epoch,
      candidateSetFingerprint: o.candidate_set_fingerprint,
      machineCanonicalLinkAssessment: o.machine_canonical_link_assessment as MatchQuality | null,
      bestCanonicalLink: o.best_canonical_link
        ? {
            targetKind: o.best_canonical_link.target_kind,
            targetHotelId: o.best_canonical_link.target_hotel_id,
            targetOrganizationId: o.best_canonical_link.target_organization_id,
            contactEvidence: o.best_canonical_link.contact_evidence,
          }
        : null,
    })),
  };

  return { result: "ok", evidence, evidenceDigest: computeEvidenceDigest(messages), machineState };
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

interface CatalogSnapshotResponse {
  hotels: Array<{ id: string; name: string; website_url: string | null }>;
  organizations: Array<{ id: string; name: string; website_url: string | null }>;
  hotel_contacts: Array<{ hotel_id: string; email: string | null }>;
  organization_contacts: Array<{ organization_id: string; email: string | null }>;
  hotel_organization_links: Array<{
    hotel_id: string;
    organization_id: string;
    relationship: string;
  }>;
}

/**
 * A bounded, deterministic snapshot of the canonical rows RELEVANT to this
 * thread's evaluation. This is the ONLY place B05 reads `public.hotels`/
 * `public.organizations`/`public.hotel_contacts`/`public.organization_
 * contacts`/`public.hotel_organizations` — read-only, never mutated.
 *
 * EXTERNAL AUDIT AMENDMENT #2, Finding 8: this used to build its own
 * PostgREST `.or()` filter strings with `email.ilike.<address>` /
 * `website_url.ilike.%<domain>%` literals — `escapeOrFilterValue()` stripped
 * only the filter-DSL's own delimiters, never ILIKE's wildcard
 * metacharacters (`%`/`_`) inside the literal itself, so a legally-shaped
 * local-part or domain containing either character could silently broaden
 * the match. This now delegates the ENTIRE bounded lookup to one
 * parameterized RPC (`gmail_outreach_catalog_snapshot`) that compares emails
 * with EXACT equality (`lower(email) = any(...)`, no wildcard semantics at
 * all) and escapes `%`/`_` before building its website-domain ILIKE pattern
 * — see that function's own comment.
 */
export async function getCatalogSnapshot(
  deps: OutreachDeps,
  input: {
    associatedAddresses: readonly string[];
    observedDomains: readonly string[];
    /** EXTERNAL AUDIT AMENDMENT #4, Finding 2: deterministic candidate phrases from the creator's own authored SENT text — lets a real canonical business enter the bounded snapshot even when unreachable via domain/contact. */
    authoredTextCandidateNames?: readonly string[];
  },
): Promise<CatalogSnapshot> {
  const epoch = await getCurrentCatalogEpoch(deps);

  const lowerAddresses = [...new Set(input.associatedAddresses.map((a) => a.toLowerCase()))];
  const domains = [...new Set(input.observedDomains.map((d) => d.toLowerCase()))];
  const candidateNames = [...new Set(input.authoredTextCandidateNames ?? [])];

  const hotelIdByContactEmail = new Map<string, Set<string>>();
  const organizationIdByContactEmail = new Map<string, Set<string>>();

  if (lowerAddresses.length === 0 && domains.length === 0 && candidateNames.length === 0) {
    return {
      epoch,
      hotels: [],
      organizations: [],
      hotelIdByContactEmail,
      organizationIdByContactEmail,
      hotelOrganizationLinks: [],
    };
  }

  const { data, error } = await deps.db.rpc("gmail_outreach_catalog_snapshot", {
    p_addresses: lowerAddresses,
    p_domains: domains,
    p_candidate_names: candidateNames,
  });
  if (error || !data) {
    throw new Error(`gmail_outreach_catalog_snapshot failed: ${error?.message ?? "no data"}`);
  }
  const snapshot = data as CatalogSnapshotResponse;

  for (const row of snapshot.hotel_contacts) {
    if (!row.email) continue;
    const key = row.email.toLowerCase();
    const set = hotelIdByContactEmail.get(key) ?? new Set<string>();
    set.add(row.hotel_id);
    hotelIdByContactEmail.set(key, set);
  }
  for (const row of snapshot.organization_contacts) {
    if (!row.email) continue;
    const key = row.email.toLowerCase();
    const set = organizationIdByContactEmail.get(key) ?? new Set<string>();
    set.add(row.organization_id);
    organizationIdByContactEmail.set(key, set);
  }

  const hotels = snapshot.hotels.map((h) => ({
    id: h.id,
    name: h.name,
    websiteDomain: extractDomain(h.website_url),
  }));
  const organizations = snapshot.organizations.map((o) => ({
    id: o.id,
    name: o.name,
    websiteDomain: extractDomain(o.website_url),
  }));
  const hotelOrganizationLinks: HotelOrganizationLink[] = snapshot.hotel_organization_links.map(
    (l) => ({
      hotelId: l.hotel_id,
      organizationId: l.organization_id,
      relationship: l.relationship,
    }),
  );

  return {
    epoch,
    hotels,
    organizations,
    hotelIdByContactEmail,
    organizationIdByContactEmail,
    hotelOrganizationLinks,
  };
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
  | { result: "deletion_pending" }
  | { result: "consent_missing" }
  | { result: "not_found" };

interface CommitResponse {
  result: string;
  normalized_thread_id?: string;
  current_evidence_digest?: string;
  current_catalog_epoch?: number;
}

/** Builds a `ScopeCandidate`/corroboration-evidence pair for ONE observation from its FRESH match result. */
function toScopeCandidate(
  observation: TargetObservationInput,
  links: readonly TargetCanonicalLinkCandidateInput[],
): ScopeCandidate {
  const bestLink = links.find((l) => l.rank === 0) ?? null;
  return { observation, bestLink };
}

export async function interpretOneThread(
  deps: OutreachDeps,
  input: {
    userId: string;
    mailAccountId: string;
    normalizedThreadId: string;
    /** WHY this thread was offered (EXTERNAL AUDIT AMENDMENT #2, Finding 4). Omit for a direct call outside `gmail_outreach_list_candidates`'s own offering — treated as fully stale (the safe default). */
    staleness?: CandidateStaleness;
  },
): Promise<InterpretThreadOutcome> {
  const evidenceResult = await getThreadEvidence(deps, input);
  if (
    evidenceResult.result === "not_found" ||
    evidenceResult.result === "account_deleted" ||
    evidenceResult.result === "deletion_pending" ||
    evidenceResult.result === "consent_missing"
  ) {
    return evidenceResult.result === "not_found"
      ? { result: "thread_not_found" }
      : { result: evidenceResult.result };
  }

  const { evidence, evidenceDigest, machineState } = evidenceResult;
  const staleness = input.staleness ?? {
    sourceStale: true,
    matcherStale: false,
    catalogStale: false,
  };
  const classify = deps.classifyOutreach ?? classifyOutreachDefault;
  const matchObservation = deps.matchTargetObservation ?? matchTargetObservationDefault;

  // EXTERNAL AUDIT AMENDMENT #2, Finding 4, staleness reason (A): the
  // classifier — the one genuinely heuristic/versioned interpretation step —
  // reruns ONLY when the underlying B04 evidence itself is stale (new/
  // changed messages, or the detector version bumped). When it is not, and a
  // thread_signal already exists, the PREVIOUSLY-COMMITTED result is reused
  // byte-for-byte rather than rederived.
  const canReuseOutreachStatus = !staleness.sourceStale && machineState.threadSignal !== null;
  const outreach = canReuseOutreachStatus
    ? {
        status: machineState.threadSignal!.outreachStatus,
        reasonCodes: machineState.threadSignal!.reasonCodes,
      }
    : classify({
        messages: evidence.messages,
        sentTextParts: evidence.sentTextParts,
        subjects: evidence.subjects,
      });

  // EXTERNAL AUDIT AMENDMENT #1, Finding 7: recipient/target extraction runs
  // for EVERY evaluated thread, regardless of outreach classification.
  // OBSERVED is literal evidence, not interpretation — a machine false
  // negative (`not_outreach`/`insufficient_evidence`) must never permanently
  // prevent a later creator correction to `outreach_confirmed` from having
  // any observed recipients or target candidates to act on. This extraction
  // is deterministic parsing, not semantic interpretation, so it always runs
  // regardless of staleness reason — there is nothing expensive to skip.
  const recipientParticipantIds = evidence.sentRecipients.map((r) => r.sourceParticipantId);

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

  // EXTERNAL AUDIT AMENDMENT #4, Finding 2: candidate business-name phrases
  // from the creator's OWN clean (authored, non-quoted, non-uncertain-
  // signature) sent text — computed once, thread-level, reused both to widen
  // the bounded catalog snapshot below and to derive `deriveMachineTargetScope`'s
  // scope-language text further down (Finding 5's own principle: read the
  // SAME clean text an authorship claim is scored against, never a quoted or
  // uncertain-authorship section).
  const cleanSentTexts = evidence.messages
    .filter((m) => m.providerSent)
    .flatMap((m) =>
      evidence.sentTextParts.filter((p) => p.normalizedMessageId === m.normalizedMessageId),
    );
  const cleanAuthoredText = buildScopeLanguageText(cleanSentTexts);
  const authoredTextCandidateNames = extractAuthoredTextNameCandidates(cleanAuthoredText);

  const targetObservations: TargetObservationInput[] = [];
  const targetCanonicalLinks: Array<Record<string, unknown>> = [];
  const scopeCandidates: ScopeCandidate[] = [];
  let hotelOrganizationLinks: readonly HotelOrganizationLink[] = [];
  // Only touch the catalog when there is something to actually match against
  // (EXTERNAL AUDIT AMENDMENT #1, Finding 4, widened by Amendment #4 Finding
  // 2): either a raw recipient-domain observation, OR the creator's own text
  // named something worth checking against real canonical inventory.
  let catalogEpoch: number;
  let catalog: CatalogSnapshot | null = null;

  if (rawObservations.length > 0 || authoredTextCandidateNames.length > 0) {
    catalog = await getCatalogSnapshot(deps, {
      associatedAddresses,
      observedDomains,
      authoredTextCandidateNames,
    });
    catalogEpoch = catalog.epoch;
    hotelOrganizationLinks = catalog.hotelOrganizationLinks;

    const storedByFingerprint = new Map(
      machineState.targetObservations.map((o) => [o.observationFingerprint, o]),
    );

    // EXTERNAL AUDIT AMENDMENT #2, Finding 4, staleness reasons (B)/(C): the
    // RELEVANT candidate-set fingerprint is cheap to recompute (a bounded
    // read already happened above) — it depends only on thread-level state
    // (the associated addresses and the catalog snapshot), so it is the same
    // for every observation on this thread and is computed exactly ONCE,
    // then compared against what was already stored BEFORE calling the full
    // matcher for each observation.
    const freshFingerprint = computeRelevantCandidateFingerprint(associatedAddresses, catalog);

    for (const raw of rawObservations) {
      const stored = storedByFingerprint.get(raw.observationFingerprint);

      // Reuse requires BOTH source AND matcher freshness: a source-stale
      // thread's raw observations may themselves be new/different, and a
      // matcher-version bump means the RULES that produced the stored
      // assessment changed — a byte-identical candidate-universe fingerprint
      // is not proof the old assessment is still correct under new rules.
      const canReuseMatch =
        !staleness.sourceStale &&
        !staleness.matcherStale &&
        stored !== undefined &&
        stored.candidateSetFingerprint === freshFingerprint &&
        stored.machineCanonicalLinkAssessment !== null;

      if (canReuseMatch) {
        const reused: TargetObservationInput = {
          ...raw,
          machineCanonicalLinkAssessment: stored!.machineCanonicalLinkAssessment!,
          candidateSetFingerprint: freshFingerprint,
        };
        targetObservations.push(reused);
        // No canonical links are sent for this observation — the commit RPC
        // leaves the EXISTING rows alone when it sees the same candidate_set_
        // fingerprint it already stored (see its own comment).
        const best = stored!.bestCanonicalLink;
        scopeCandidates.push({
          observation: reused,
          bestLink: best
            ? {
                observationFingerprint: raw.observationFingerprint,
                targetKind: best.targetKind,
                targetHotelId: best.targetHotelId ?? undefined,
                targetOrganizationId: best.targetOrganizationId ?? undefined,
                nameEvidence: "unavailable",
                domainEvidence: "unavailable",
                addressEvidence: "unavailable",
                contactEvidence: best.contactEvidence,
                authoredTextEvidence: "unavailable",
                rank: 0,
              }
            : null,
        });
        continue;
      }

      const matched = matchObservation(
        raw,
        associatedAddresses,
        catalog,
        authoredTextCandidateNames,
      );
      targetObservations.push(matched.observation);
      scopeCandidates.push(toScopeCandidate(matched.observation, matched.links));
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
          authored_text_evidence: link.authoredTextEvidence,
          rank: link.rank,
        });
      }
    }
  } else {
    catalogEpoch = await getCurrentCatalogEpoch(deps);
  }

  // EXTERNAL AUDIT AMENDMENT #4, Finding 1: D070 requires literal creator-
  // SENT evidence (A), creator-authored commercial-proposal evidence (B),
  // AND evidence the proposal was directed at a potential commercial target
  // or a representative of one (C) — jointly. `classify()` above can only
  // ever prove A+B (it has no recipient/target evidence at all), so it
  // never itself returns `qualified_outreach` any more (see interpreter.ts).
  // This is the ONE place C is independently established and the ONLY place
  // the upgrade to `qualified_outreach` may happen — conservatively, from
  // real evidence already computed above: at least one non-freemail `to`-
  // recipient domain observation (a plausible commercial target/
  // representative), or the creator's own authored text exactly naming a
  // REAL canonical hotel/organization. Absent BOTH, proposal language alone
  // stays `needs_review` — an honest abstention, never silently upgraded and
  // never silently discarded (a creator can still correct it either way).
  const authoredTextMatchedRealBusiness =
    catalog !== null &&
    (() => {
      const authoredEvidence = computeAuthoredTextTargetEvidence(
        authoredTextCandidateNames,
        catalog!,
      );
      return (
        authoredEvidence.matchedHotelIds.size > 0 ||
        authoredEvidence.matchedOrganizationIds.size > 0
      );
    })();
  const hasCommercialTargetEvidence = rawObservations.length > 0 || authoredTextMatchedRealBusiness;
  const outreachIsProposalLanguageOnly = outreach.reasonCodes.includes(
    "creator_commercial_proposal_language_detected",
  );
  const finalOutreach =
    outreachIsProposalLanguageOnly && hasCommercialTargetEvidence
      ? {
          status: "qualified_outreach" as const,
          reasonCodes: [...outreach.reasonCodes, "commercial_target_evidence_present"],
        }
      : outreach;

  // EXTERNAL AUDIT AMENDMENT #2, Finding 6: target-contact `strong_match` now
  // requires genuinely INDEPENDENT corroboration — an exact canonical-contact
  // match for a hotel/organization that a SEPARATE (domain/name) signal also
  // strongly identified as this thread's actual target — never address
  // morphology alone.
  const independentlyConfirmedAddresses = new Set<string>();
  if (catalog !== null) {
    for (const candidate of scopeCandidates) {
      if (candidate.observation.machineCanonicalLinkAssessment !== "strong_match") continue;
      const link = candidate.bestLink;
      if (!link || link.contactEvidence !== "agrees") continue;
      const targetId = link.targetKind === "hotel" ? link.targetHotelId : link.targetOrganizationId;
      if (!targetId) continue;
      const contactMap =
        link.targetKind === "hotel"
          ? catalog.hotelIdByContactEmail
          : catalog.organizationIdByContactEmail;
      for (const [addr, ids] of contactMap) {
        if (ids.has(targetId)) independentlyConfirmedAddresses.add(addr);
      }
    }
  }
  const contactAssessment = assessTargetContacts(
    evidence.sentRecipients,
    independentlyConfirmedAddresses,
  );
  const targetContactCandidates = contactAssessment.candidates.map((c) => ({
    source_participant_id: c.sourceParticipantId,
    role_evidence: c.roleEvidence,
    address_pattern_evidence: c.addressPatternEvidence,
    rank: c.rank,
  }));

  // EXTERNAL AUDIT AMENDMENT #2, Finding 5: intent-based, never a raw count
  // of observations. Portfolio/single-entity language is read from the SAME
  // clean (authored, non-quoted, non-uncertain-signature) text the outreach
  // classifier itself reads — never from a section of uncertain authorship
  // (Finding 7's own principle applied here too). `cleanAuthoredText` was
  // already computed once, above, for Finding 2's candidate-name extraction.
  const scopeLanguage = detectScopeLanguage(
    [...evidence.subjects.map((s) => s.rawValue), cleanAuthoredText].join(" \n "),
  );
  const machineScope = deriveMachineTargetScope(
    scopeCandidates,
    scopeLanguage,
    hotelOrganizationLinks,
  );

  const { data: rawData, error } = await deps.db.rpc("gmail_outreach_commit_interpretation", {
    p_user_id: input.userId,
    p_mail_account_id: input.mailAccountId,
    p_normalized_thread_id: input.normalizedThreadId,
    p_detector_version: requireVersionShape(OUTREACH_DETECTOR_VERSION, "detectorVersion"),
    p_matcher_version: requireVersionShape(TARGET_MATCHER_VERSION, "matcherVersion"),
    p_expected_evidence_digest: evidenceDigest,
    p_outreach_status: finalOutreach.status,
    p_reason_codes: finalOutreach.reasonCodes,
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
      return { result: "ok", outreachStatus: finalOutreach.status };
    case "stale_source":
      return { result: "stale_source", currentEvidenceDigest: data.current_evidence_digest! };
    case "stale_catalog":
      return { result: "stale_catalog", currentCatalogEpoch: data.current_catalog_epoch! };
    case "thread_not_found":
      return { result: "thread_not_found" };
    case "account_deleted":
      return { result: "account_deleted" };
    case "deletion_pending":
      return { result: "deletion_pending" };
    case "consent_missing":
      return { result: "consent_missing" };
    case "not_found":
      return { result: "not_found" };
    default:
      throw new OutreachStructuralError(
        `gmail_outreach_commit_interpretation returned unknown result: ${data.result}`,
      );
  }
}

/** Concatenates decoded clean text parts for scope-language detection (Finding 5/7). */
function buildScopeLanguageText(parts: readonly EvidenceTextPart[]): string {
  const byMessage = new Map<string, EvidenceTextPart[]>();
  for (const p of parts) {
    const list = byMessage.get(p.normalizedMessageId) ?? [];
    list.push(p);
    byMessage.set(p.normalizedMessageId, list);
  }
  const texts: string[] = [];
  for (const messagesParts of byMessage.values()) {
    const { cleanText } = buildClassifierInputForMessage(messagesParts);
    if (cleanText !== null) texts.push(cleanText);
  }
  return texts.join(" \n ");
}

// ---------------------------------------------------------------------------
// Bounded batch + until-idle worker — mirrors B04's normalizeMailboxUntilIdle
// ---------------------------------------------------------------------------

interface CandidatesResponse {
  result: string;
  candidates: Array<{
    normalized_thread_id: string;
    provider_thread_id: string;
    source_stale: boolean;
    matcher_stale: boolean;
    catalog_stale: boolean;
  }>;
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
  // A non-`ok` result (Finding 2: `account_deleted`/`deletion_pending`/
  // `consent_missing`) always carries an empty candidate list — nothing to
  // interpret this call, same as zero candidates being genuinely offered.
  summary.candidatesFound = data.result === "ok" ? data.candidates.length : 0;

  for (const candidate of data.result === "ok" ? data.candidates : []) {
    const outcome = await interpretOneThread(deps, {
      userId: input.userId,
      mailAccountId: input.mailAccountId,
      normalizedThreadId: candidate.normalized_thread_id,
      staleness: {
        sourceStale: candidate.source_stale,
        matcherStale: candidate.matcher_stale,
        catalogStale: candidate.catalog_stale,
      },
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
  | { result: "deletion_pending" }
  | { result: "consent_missing" }
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
    case "deletion_pending":
    case "consent_missing":
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
