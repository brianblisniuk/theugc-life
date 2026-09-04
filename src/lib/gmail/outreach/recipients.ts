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
 * canonical contact. `matchQuality` is the thread-level aggregate; `strong_
 * match` requires at least one `to` recipient, `ambiguous` requires two or
 * more `to` recipients at genuinely different domains (a materially
 * different, less certain case than several people at one company).
 */
export function assessTargetContacts(
  recipients: readonly EvidenceRecipient[],
): TargetContactAssessment {
  const scored = recipients.map((r, index) => ({
    sourceParticipantId: r.sourceParticipantId,
    roleEvidence: roleEvidence(r.role),
    addressPatternEvidence: addressPatternEvidence(r.localPart),
    role: r.role,
    domainLower: r.domainLower,
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

  // EXTERNAL AUDIT AMENDMENT #1, Finding 8: `to` role ALONE is not enough for
  // `strong_match` — that made this table's real behavior "to === target"
  // despite its own documented intent never to assume that. `strong_match`
  // now requires role evidence PLUS a corroborating signal: either two or
  // more `to` recipients at the SAME domain (independently coordinated
  // addressing of real people is stronger than one address), or a single
  // `to` recipient whose local part reads as a named individual rather than
  // a generic/shared inbox. A lone generic-inbox `to` is a real, legitimate
  // signal — just not a CONFIDENT one — so it lands at `needs_review`,
  // exactly like a lone `cc`, rather than being silently upgraded.
  let matchQuality: MatchQuality;
  if (toCount > 0 && toDomains.size >= 2) {
    matchQuality = "ambiguous";
  } else if (toCount >= 2) {
    matchQuality = "strong_match";
  } else if (toCount === 1 && toRecipients[0]!.addressPatternEvidence === "named_person") {
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
