import type {
  EvidenceRecipient,
  MatchQuality,
  TargetContactCandidateInput,
} from "@/lib/gmail/outreach/contract";
import { digestOfSortedStrings } from "@/lib/gmail/outreach/digest";

/**
 * WHO WROTE ITSELF INTO THE HEADERS ("observed recipient") IS DETERMINISTIC
 * AND NEEDS NO JUDGEMENT — B04 already parsed it, and B05 preserves it
 * unfiltered (`gmail_outreach_observed_recipients`, every SENT to/cc/bcc
 * occurrence). WHICH RECIPIENT WAS ACTUALLY THE COMMERCIAL TARGET CONTACT is
 * a separate judgement, computed here. Never assumes `to === target` or
 * `cc/bcc === not target` — those are evidence, scored, not rules.
 */

const GENERIC_LOCAL_PARTS = new Set([
  "info",
  "contact",
  "hello",
  "hi",
  "partnerships",
  "partnership",
  "marketing",
  "media",
  "press",
  "pr",
  "sales",
  "support",
  "admin",
  "office",
  "reservations",
  "reservation",
  "bookings",
  "booking",
  "frontdesk",
  "front-desk",
  "concierge",
  "no-reply",
  "noreply",
  "newsletter",
  "hello@",
]);

function addressPatternEvidence(
  localPart: string | null,
): "named_person" | "generic_inbox" | "unavailable" {
  if (!localPart) return "unavailable";
  const normalized = localPart.toLowerCase().trim();
  if (GENERIC_LOCAL_PARTS.has(normalized)) return "generic_inbox";
  // A dotted or dashed two-token local part ("jane.doe", "jane-doe") reads as
  // a named person; a bare single alphabetic token that isn't in the generic
  // list is treated as unavailable — genuinely ambiguous either way.
  if (/^[a-z]+[._-][a-z]+$/i.test(normalized)) return "named_person";
  return "unavailable";
}

function roleEvidence(role: EvidenceRecipient["role"]): "agrees" | "differs" | "unavailable" {
  if (role === "to") return "agrees";
  if (role === "bcc") return "differs";
  return "unavailable";
}

export interface TargetContactAssessment {
  matchQuality: MatchQuality;
  candidates: readonly TargetContactCandidateInput[];
  candidateSetFingerprint: string;
}

/**
 * Scores every observed SENT recipient as a target-contact candidate. Every
 * candidate references a real observed-recipient participant id — never a
 * canonical contact.
 *
 * `independentlyConfirmedAddresses` (EXTERNAL AUDIT AMENDMENT #2, Finding 6)
 * — lower-cased addresses with GENUINELY INDEPENDENT commercial-target
 * corroboration: an exact canonical-contact-record match (`gmail_outreach_
 * observed_recipient_canonical_links`'s own evidence) for a hotel/
 * organization that a SEPARATE, independent signal (domain or name
 * agreement) also identified as this thread's actual commercial target
 * (`matchTargetObservation`'s `strong_match`). Two unrelated extraction
 * pathways agreeing is real evidence; ADDRESS MORPHOLOGY (a dotted local
 * part "looks like" a person, or several `to` recipients share a domain) is
 * not — a `jane.doe@` address could just as easily be a manager, assistant,
 * or colleague with no commercial role at all. The previous version treated
 * morphology as sufficient for `strong_match`; this one never does — absent
 * independent corroboration, `needs_review` is the honest ceiling.
 */
export function assessTargetContacts(
  recipients: readonly EvidenceRecipient[],
  independentlyConfirmedAddresses: ReadonlySet<string>,
): TargetContactAssessment {
  const scored = recipients.map((r, index) => ({
    sourceParticipantId: r.sourceParticipantId,
    roleEvidence: roleEvidence(r.role),
    addressPatternEvidence: addressPatternEvidence(r.localPart),
    role: r.role,
    domainLower: r.domainLower,
    addrLower: r.addrSpec ? r.addrSpec.toLowerCase() : null,
    originalIndex: index,
  }));

  const rankOrder = { to: 0, cc: 1, bcc: 2 } as const;
  const ranked = [...scored].sort(
    (a, b) => rankOrder[a.role] - rankOrder[b.role] || a.originalIndex - b.originalIndex,
  );

  const candidates: TargetContactCandidateInput[] = ranked.map((r, rank) => ({
    sourceParticipantId: r.sourceParticipantId,
    roleEvidence: r.roleEvidence,
    addressPatternEvidence: r.addressPatternEvidence,
    rank,
  }));

  const toRecipients = scored.filter((r) => r.role === "to");
  const toDomains = new Set(toRecipients.filter((r) => r.domainLower).map((r) => r.domainLower!));
  const toCount = toRecipients.length;
  const ccCount = scored.filter((r) => r.role === "cc").length;
  const corroboratedToCount = toRecipients.filter(
    (r) => r.addrLower !== null && independentlyConfirmedAddresses.has(r.addrLower),
  ).length;

  // `ambiguous` (genuinely different businesses addressed) is still decided
  // by domain plurality — a real scope signal, unrelated to Finding 6's
  // complaint about morphology-based CONFIDENCE. `strong_match` now requires
  // independent corroboration; address shape alone never earns it.
  let matchQuality: MatchQuality;
  if (toCount > 0 && toDomains.size >= 2) {
    matchQuality = "ambiguous";
  } else if (corroboratedToCount > 0) {
    matchQuality = "strong_match";
  } else if (toCount > 0 || ccCount > 0) {
    matchQuality = "needs_review";
  } else {
    matchQuality = "insufficient_evidence";
  }

  const candidateSetFingerprint = digestOfSortedStrings(
    recipients.map((r) => r.sourceParticipantId),
  );

  return { matchQuality, candidates, candidateSetFingerprint };
}
