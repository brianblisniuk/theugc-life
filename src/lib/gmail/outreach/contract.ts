/**
 * B05 shared types and version constants. See
 * docs/B05_GMAIL_OUTREACH_COMMERCIAL_TARGET_CONTRACT.md for the full contract
 * these types implement.
 */

/**
 * V1 deterministic outreach classifier. No external model call.
 * `_v2` (EXTERNAL AUDIT AMENDMENT #1, Finding 10): the classifier input now
 * has quoted history/signatures heuristically stripped before pattern
 * matching. `_v3` (EXTERNAL AUDIT AMENDMENT #2, Finding 7): positive
 * vocabulary appearing ONLY inside a heuristically-detected, non-RFC
 * signature tail (uncertain authorship) no longer qualifies a thread as
 * `qualified_outreach`. `_v4` (EXTERNAL AUDIT AMENDMENT #4, Finding 1):
 * creator-commercial-proposal LANGUAGE alone (`classifyOutreach`'s own
 * signal) no longer directly produces `qualified_outreach` — the final
 * status now also requires independently-established commercial-target/
 * representative evidence, resolved in `interpretOneThread`. Every
 * previously-classified thread is offered for re-evaluation via
 * `gmail_outreach_list_candidates`'s detector-version staleness check.
 */
export const OUTREACH_DETECTOR_VERSION = "gmail_outreach_rules_v4";
/**
 * V1 deterministic target/target-contact matcher. No external model call.
 * `_v2` (Finding 5/8/9): multimap contact-email evidence, a tightened
 * target-contact `strong_match` rule, and no domain-derived name evidence.
 * `_v3` (EXTERNAL AUDIT AMENDMENT #2, Findings 4/5/6/8): the relevant
 * candidate-set fingerprint now includes `hotel_organizations` portfolio
 * relationships, machine target-scope is intent-based rather than a
 * cardinality count, target-contact `strong_match` requires independent
 * canonical-contact + target corroboration rather than address morphology,
 * and the catalog snapshot query is exact-match rather than `ilike`. `_v4`
 * (EXTERNAL AUDIT AMENDMENT #4, Finding 2): a deterministic exact-name match
 * between the creator's own authored text and a real canonical business is
 * now an independent evidence dimension that can also enter a business into
 * the candidate universe regardless of recipient domain/contact, and a
 * candidate the authored text explicitly contradicts can never be assessed
 * `strong_match`.
 */
export const TARGET_MATCHER_VERSION = "gmail_outreach_match_rules_v4";
/**
 * Versioned heuristic classifier-input transform (quote/HTML handling,
 * signature stripping). `_v3` (Finding 7): also splits a message into a
 * confident-authorship `cleanText` and an `uncertainAuthorshipText` tail
 * (a heuristically-detected, non-RFC valediction/signature block). `_v4`
 * (EXTERNAL AUDIT AMENDMENT #4, Finding 3): the HTML fallback now preserves
 * block-level structure (cutting at the first `<blockquote>`, turning `<br>`/
 * block-closing tags into real newlines) BEFORE collapsing whitespace, so
 * the line-based quote/signature heuristics can still see an HTML message's
 * actual shape instead of one run-on line.
 */
export const CLASSIFIER_INPUT_TRANSFORM_VERSION = "gmail_outreach_text_v4";

export type OutreachStatus =
  "qualified_outreach" | "not_outreach" | "needs_review" | "insufficient_evidence";

export type MatchQuality = "strong_match" | "needs_review" | "ambiguous" | "insufficient_evidence";

export type TargetScope = "single_target" | "multiple_targets" | "portfolio_target" | "unresolved";

export type TargetKind = "hotel" | "organization";

export type CanonicalContactKind = "hotel_contact" | "organization_contact";

export type EvidenceAgreement = "agrees" | "differs" | "unavailable";

export type RecipientRole = "to" | "cc" | "bcc";

export type ParseStatus = "parsed" | "malformed" | "empty_group";

export type CreatorDecisionAxis = "outreach" | "target_scope" | "target" | "target_contact";

export type OutreachDecisionValue = "outreach_confirmed" | "not_outreach_confirmed";

export type TargetAction = "confirm" | "remove";

/** Reject, do not clamp — the same true-entry-point discipline as B04. */
export function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
  return value;
}

const VERSION_SHAPE = /^[a-z][a-z0-9_]{0,63}$/;

export function requireVersionShape(value: string, name: string): string {
  if (!VERSION_SHAPE.test(value)) {
    throw new RangeError(`${name} must match ${VERSION_SHAPE}, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** One SENT message's evidence, as returned by `gmail_outreach_get_thread_evidence`. */
export interface EvidenceMessage {
  normalizedMessageId: string;
  providerMessageId: string;
  providerSent: boolean;
  internalDateMs: number;
  sourcePayloadSha256: string;
}

export interface EvidenceTextPart {
  normalizedMessageId: string;
  partPath: readonly number[];
  mimeType: "text/plain" | "text/html";
  decodeStatus: string;
  decodedText: string | null;
}

export interface EvidenceRecipient {
  normalizedMessageId: string;
  sourceHeaderId: string;
  sourceParticipantId: string;
  role: RecipientRole;
  displayName: string | null;
  addrSpec: string | null;
  localPart: string | null;
  domain: string | null;
  domainLower: string | null;
  parseStatus: ParseStatus;
}

export interface EvidenceSubject {
  normalizedMessageId: string;
  rawValue: string;
}

export interface ThreadEvidence {
  normalizedThreadId: string;
  providerThreadId: string;
  messages: readonly EvidenceMessage[];
  sentTextParts: readonly EvidenceTextPart[];
  sentRecipients: readonly EvidenceRecipient[];
  subjects: readonly EvidenceSubject[];
}

/**
 * WHY a thread was offered for re-evaluation (EXTERNAL AUDIT AMENDMENT #2,
 * Finding 4) — lets `interpretOneThread` pick the cheapest honest path
 * instead of always rerunning full interpretation. `sourceStale` implies the
 * classifier must rerun; `matcherStale`/`catalogStale` (with `sourceStale`
 * false) mean the classifier's own result may be reused unchanged, and only
 * matching may need to rerun.
 */
export interface CandidateStaleness {
  sourceStale: boolean;
  matcherStale: boolean;
  catalogStale: boolean;
}

/** The currently-stored MACHINE state for one thread, as returned by `gmail_outreach_get_thread_evidence` (Finding 4). Null fields mean "never evaluated". */
export interface MachineStateSnapshot {
  threadSignal: {
    outreachStatus: OutreachStatus;
    reasonCodes: readonly string[];
    detectorVersion: string;
  } | null;
  targetContactSignal: {
    matchQuality: MatchQuality;
    matcherVersion: string;
    evaluatedEpoch: number;
    candidateSetFingerprint: string;
  } | null;
  targetScopeSignal: {
    machineTargetScope: TargetScope;
    matcherVersion: string;
    evaluatedEpoch: number;
  } | null;
  targetObservations: readonly {
    observationFingerprint: string;
    matcherVersion: string | null;
    evaluatedEpoch: number | null;
    candidateSetFingerprint: string | null;
    machineCanonicalLinkAssessment: MatchQuality | null;
    bestCanonicalLink: {
      targetKind: TargetKind;
      targetHotelId: string | null;
      targetOrganizationId: string | null;
      contactEvidence: EvidenceAgreement;
    } | null;
  }[];
}

export interface TargetContactCandidateInput {
  sourceParticipantId: string;
  roleEvidence: EvidenceAgreement;
  addressPatternEvidence: "named_person" | "generic_inbox" | "unavailable";
  rank: number;
}

export interface TargetCanonicalLinkCandidateInput {
  observationFingerprint: string;
  targetKind: TargetKind;
  targetHotelId?: string;
  targetOrganizationId?: string;
  nameEvidence: EvidenceAgreement;
  domainEvidence: EvidenceAgreement;
  addressEvidence: EvidenceAgreement;
  contactEvidence: EvidenceAgreement;
  /**
   * EXTERNAL AUDIT AMENDMENT #4, Finding 2: an exact-name match between the
   * creator's own authored SENT text and this real canonical business — an
   * independent dimension from `nameEvidence` (which reads a RECIPIENT's
   * display name, not the message body). `differs` means the text explicitly
   * named a DIFFERENT real business instead, a genuine contradiction with
   * this row's other evidence.
   */
  authoredTextEvidence: EvidenceAgreement;
  rank: number;
}

export interface TargetObservationInput {
  observationFingerprint: string;
  observedName: string | null;
  observedDomain: string | null;
  targetKindHint: TargetKind | "unknown";
  /**
   * Gmail's own permanent message ids (never a B04 row uuid) — durable
   * provenance that survives a B04 rebuild, and verified server-side against
   * this exact thread/account before the observation row can be created
   * (EXTERNAL AUDIT AMENDMENT #1, Finding 1/12).
   */
  sourceProviderMessageIds: readonly string[];
  machineCanonicalLinkAssessment: MatchQuality;
  candidateSetFingerprint: string;
}

/** A conservative, advisory, thread-level target-scope hint (Finding 6). Never authoritative — see the creator's own target_scope_decision. */
export interface MachineTargetScopeResult {
  scope: TargetScope;
  reasonCodes: readonly string[];
}
