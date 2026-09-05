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
 * `strong_match`. `_v5` (EXTERNAL AUDIT AMENDMENT #5, Findings 1/2/3): a
 * creator-authored-text business match is now (a) gated on a conservative,
 * deterministic target-directed-context pattern around the exact name match
 * — a bare historical mention ("I worked with Marriott last year") is no
 * longer target evidence at all (Finding 3); (b) only ever `differs` when a
 * phrase actually resolved to a real, different, target-directed business —
 * never merely because SOME capitalized phrase existed in the text (Finding
 * 2); and (c) no longer alone justifies a business entering an UNRELATED
 * recipient-domain observation's candidate set — a real target-directed
 * authored-text match instead becomes its OWN independent private target
 * observation (`observation_source_kind = 'authored_text_name'`), never
 * canonical-link evidence bolted onto a different observation's identity
 * (Finding 1). Authored-text evidence remains available as an EXTRA
 * corroboration dimension for a domain-based observation's candidate that is
 * already independently relevant via domain/name/contact evidence.
 * `_v6` (EXTERNAL AUDIT AMENDMENT #6, Findings 1/2/4): (a) a target-directed
 * authored-text match now recognizes every member of a bounded, conservative
 * coordinated list following the verb phrase ("collaborate with Hotel A and
 * Hotel B"), not only the item immediately adjacent to it; (b) a
 * `recipient_domain` observation's identity and matching no longer depend on
 * a recipient's display NAME at all — it is contact/person evidence, never
 * business identity, so `nameEvidence` is always `unavailable` in V1 and a
 * contact-person change at the same domain can never fork or falsely
 * corroborate a target fact; (c) an `authored_text_name` observation's
 * identity now normalizes with the exact same `normalizeName()` definition
 * canonical exact-matching already uses, so a punctuation/case-only variant
 * of the same authored name reconciles onto the same private fact instead of
 * forking a spurious duplicate. (Finding 3's explicit machine current-
 * membership flag is a schema/bookkeeping addition, not a classification or
 * matching RULE change, so it does not itself trigger this version bump.)
 * `_v7` (EXTERNAL AUDIT AMENDMENT #7, Findings 1/2): (a) a target-directed
 * authored name that matches ZERO real canonical businesses today is no
 * longer discarded — it is preserved as its own private target-observation
 * fact with `insufficient_evidence`/zero links, reconciling onto the SAME
 * fingerprint if a matching canonical row is later added or removed (D070:
 * a commercial target is first a private fact, independent of canonical
 * inventory); (b) coordinated-list segmentation is now catalog-aware and
 * conservative — `of`/`the`/`de`/`la` are never split points at all (never
 * again fabricating a fragment like "America" from "Bank of America"), and
 * the ambiguous `and`/`&` connectors split into a genuine multi-target list
 * when AT LEAST ONE resulting segment matches a real canonical business (a
 * non-matching segment is not thereby discarded — it still becomes its own
 * unresolved private observation), or are preserved undivided when the whole
 * span itself matches one real business ("Johnson & Johnson" is never split
 * into "Johnson" + "Johnson"); a span where NEITHER the whole nor any segment
 * matches anything real is preserved as ONE unresolved phrase rather than
 * fabricating a split. (Finding 3's current-only
 * machine-state read surface is a read-path change, not a matching rule, so
 * it alone would not require a bump — it is bumped anyway because Findings
 * 1/2 already require it.)
 * `_v8` (EXTERNAL AUDIT AMENDMENT #8, Finding 1): `_v7`'s coordinated-list
 * segmentation was ITSELF still a D070 §8 violation — canonical inventory
 * (whether "at least one segment" happened to match a real business) decided
 * the SHAPE/IDENTITY of a private Gmail fact, so adding or removing an
 * unrelated canonical row could change which private facts exist and their
 * current-vs-historical membership, never just their resolution. Source-fact
 * segmentation (`resolveTargetDirectedPhrases`/`computeTargetDirectedPhrases`)
 * no longer accepts a catalog parameter AT ALL — it is now a pure function of
 * the source text alone, so the exact same private-observation-fingerprint
 * set is produced for any catalog state. `&` is now NEVER a split point
 * (more conservative than `and` — "Johnson & Johnson", "Smith & Jones" are
 * always one phrase, regardless of what canonical inventory contains); `and`
 * only splits when the source text itself shows two multi-word segments
 * sharing an identical leading word ("Hotel A and Hotel B", "Resort Alpha and
 * Resort Beta") — real, deterministic, source-only structural evidence of a
 * parallel list. Any other `and`/`&` span with no such source-only evidence
 * ("Nike and Adidas") is preserved as ONE unresolved private fact — a
 * conservative abstention, not a guess informed by canonical inventory.
 */
export const TARGET_MATCHER_VERSION = "gmail_outreach_match_rules_v8";
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

/**
 * EXTERNAL AUDIT AMENDMENT #5, Finding 1: the explicit observation-source
 * distinction. `recipient_domain` — the historical shape — is derived purely
 * from a non-freemail `to`-recipient's domain. `authored_text_name` is a
 * commercial target the creator's OWN authored SENT text explicitly, exactly
 * named in a target-directed context, independent of any recipient's
 * address/domain — never keyed on a canonical hotel/organization id (the
 * canonical row is only ever a 0..N LINK, exactly like a recipient-domain
 * observation's). Never rewritten once an observation is created.
 */
export type ObservationSourceKind = "recipient_domain" | "authored_text_name";

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
  /**
   * A RECIPIENT's display-name evidence dimension — always `unavailable` in
   * V1 (EXTERNAL AUDIT AMENDMENT #6, Finding 2): a recipient's display name
   * is contact/person evidence (a human's name — "Jane Smith"), never
   * business-name evidence, and treating it as the latter let a person
   * literally named after (or a fuzzy substring of) a real property's name
   * falsely corroborate that property as the commercial target. Kept in the
   * shape, never removed, so a future, separately-contracted, explicitly
   * BUSINESS-name evidence source can populate it without a schema change.
   */
  nameEvidence: EvidenceAgreement;
  domainEvidence: EvidenceAgreement;
  addressEvidence: EvidenceAgreement;
  contactEvidence: EvidenceAgreement;
  /**
   * EXTERNAL AUDIT AMENDMENT #4, Finding 2: an exact-name match between the
   * creator's own authored SENT text and this real canonical business — an
   * independent dimension from `nameEvidence` (which, when populated, would
   * read a RECIPIENT's display name, not the message body). `differs` means
   * the text explicitly named a DIFFERENT real, target-directed business
   * instead, a genuine contradiction with this row's other evidence.
   */
  authoredTextEvidence: EvidenceAgreement;
  rank: number;
}

export interface TargetObservationInput {
  observationFingerprint: string;
  observedName: string | null;
  observedDomain: string | null;
  targetKindHint: TargetKind | "unknown";
  /** EXTERNAL AUDIT AMENDMENT #5, Finding 1 — see `ObservationSourceKind`. */
  observationSourceKind: ObservationSourceKind;
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
