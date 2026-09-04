import { TARGET_MATCHER_VERSION } from "@/lib/gmail/outreach/contract";
import type {
  EvidenceAgreement,
  EvidenceRecipient,
  MachineTargetScopeResult,
  MatchQuality,
  TargetCanonicalLinkCandidateInput,
  TargetKind,
  TargetObservationInput,
} from "@/lib/gmail/outreach/contract";
import { digestOfSortedStrings, digestOfString } from "@/lib/gmail/outreach/digest";

export { TARGET_MATCHER_VERSION };

/**
 * Free/consumer mail providers can never identify a business by domain alone
 * (D028) — excluded from target-observation extraction entirely, not merely
 * scored low.
 */
const FREEMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "icloud.com",
  "aol.com",
  "protonmail.com",
  "live.com",
  "msn.com",
]);

export interface CatalogHotel {
  id: string;
  name: string;
  websiteDomain: string | null;
}

export interface CatalogOrganization {
  id: string;
  name: string;
  websiteDomain: string | null;
}

/**
 * A bounded, deterministic snapshot of catalog rows relevant to one thread's
 * evaluation.
 *
 * EXTERNAL AUDIT AMENDMENT #1, Finding 5: `hotelIdByContactEmail`/
 * `organizationIdByContactEmail` are MULTIMAPS (one email can legitimately
 * belong to several hotel_contacts rows — a shared inbox, a duplicate
 * import, an agency contact representing several properties; the table
 * carries no unique constraint on email for exactly this reason). A plain
 * `Map<string, string>` here would silently collapse that ambiguity to
 * whichever row happened to be written last, and could report `contact_
 * evidence: agrees` for the WRONG business.
 */
export interface CatalogSnapshot {
  epoch: number;
  hotels: readonly CatalogHotel[];
  organizations: readonly CatalogOrganization[];
  /** lower-cased email -> every hotel id it exactly matches in hotel_contacts. */
  hotelIdByContactEmail: ReadonlyMap<string, ReadonlySet<string>>;
  /** lower-cased email -> every organization id it exactly matches in organization_contacts. */
  organizationIdByContactEmail: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Extracts hostname (lower-cased, no scheme/www) from a URL-ish string. Returns null if unparseable. */
export function extractDomain(urlOrDomain: string | null | undefined): string | null {
  if (!urlOrDomain) return null;
  const trimmed = urlOrDomain.trim();
  if (trimmed === "") return null;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const host = new URL(withScheme).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function nameOverlap(a: string | null, b: string): boolean {
  if (!a) return false;
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na.length === 0 || nb.length === 0) return false;
  return na.includes(nb) || nb.includes(na);
}

/**
 * One private target observation per distinct non-freemail domain among
 * `to`-role SENT recipients. `cc`/`bcc` recipients never independently
 * generate a target observation — being copied is not evidence of being the
 * pitch's destination.
 *
 * `messageIdToProviderId` maps each recipient's `normalizedMessageId` to
 * Gmail's own permanent `provider_message_id` (EXTERNAL AUDIT AMENDMENT #1,
 * Finding 1/12) — the durable provenance the commit RPC verifies
 * server-side, so `sourceProviderMessageIds` never asserts a B04 row id that
 * a rebuild could invalidate.
 */
export function extractTargetObservations(
  recipients: readonly EvidenceRecipient[],
  messageIdToProviderId: ReadonlyMap<string, string>,
): TargetObservationInput[] {
  const byDomain = new Map<
    string,
    { sourceProviderMessageIds: Set<string>; displayName: string | null }
  >();

  for (const r of recipients) {
    if (r.role !== "to") continue;
    const domain = r.domainLower;
    if (!domain || FREEMAIL_DOMAINS.has(domain)) continue;
    const providerMessageId = messageIdToProviderId.get(r.normalizedMessageId);
    if (!providerMessageId) continue;
    const entry = byDomain.get(domain) ?? {
      sourceProviderMessageIds: new Set<string>(),
      displayName: null,
    };
    entry.sourceProviderMessageIds.add(providerMessageId);
    // A recipient's display name is genuine, independently-observed name
    // evidence (a human wrote it) — unlike a label mechanically derived from
    // the domain string itself, which would let ONE signal (the domain)
    // masquerade as two independent agreements once compared against a
    // catalog row's name (Finding 9). No domain-derived fallback: absent
    // real display-name evidence, `observedName` stays null — an honest
    // abstention, not a fabricated signal.
    entry.displayName ??= r.displayName;
    byDomain.set(domain, entry);
  }

  const observations: TargetObservationInput[] = [];
  for (const [domain, entry] of byDomain) {
    observations.push({
      observationFingerprint: digestOfString(domain),
      observedName: entry.displayName,
      observedDomain: domain,
      targetKindHint: "unknown",
      sourceProviderMessageIds: [...entry.sourceProviderMessageIds],
      // Filled in by matchTargetObservation below.
      machineCanonicalLinkAssessment: "insufficient_evidence",
      candidateSetFingerprint: digestOfString(""),
    });
  }
  return observations;
}

/**
 * Conservative, thread-level MACHINE target-scope hint (Finding 6). Never
 * authoritative and never duplicated per observation. V1 uses only the one
 * signal it can honestly support — how many distinct commercial targets the
 * thread's own extraction found — and never invents a `portfolio_target`
 * classification, since no portfolio/property-group language detector exists
 * in this baseline; that value remains reachable only through the creator's
 * own decision.
 */
export function deriveMachineTargetScope(
  observations: readonly TargetObservationInput[],
): MachineTargetScopeResult {
  if (observations.length === 0) {
    return { scope: "unresolved", reasonCodes: ["no_target_observation"] };
  }
  if (observations.length === 1) {
    return { scope: "single_target", reasonCodes: ["one_target_observation"] };
  }
  return { scope: "multiple_targets", reasonCodes: ["multiple_target_observations"] };
}

export interface TargetMatchResult {
  observation: TargetObservationInput;
  links: readonly TargetCanonicalLinkCandidateInput[];
}

/**
 * Conservative canonical matching (D028/D063: no universal threshold, no
 * single-signal auto-resolution). A candidate is produced only when at least
 * one evidence dimension agrees. `address_evidence` is always `unavailable`
 * in V1 — no physical-address evidence source is implemented, and an honest
 * abstention is preferred over fabricating a redundant signal.
 */
interface ScoredCandidate {
  candidate: TargetCanonicalLinkCandidateInput;
  agreements: number;
}

function evaluateCandidate(
  observation: TargetObservationInput,
  addresses: readonly string[],
  catalog: CatalogSnapshot,
  kind: TargetKind,
  id: string,
  name: string,
  websiteDomain: string | null,
): ScoredCandidate | null {
  const domainEvidence: EvidenceAgreement =
    websiteDomain === null
      ? "unavailable"
      : observation.observedDomain && websiteDomain === observation.observedDomain
        ? "agrees"
        : observation.observedDomain
          ? "differs"
          : "unavailable";

  const nameEvidence: EvidenceAgreement = observation.observedName
    ? nameOverlap(observation.observedName, name)
      ? "agrees"
      : "differs"
    : "unavailable";

  const contactMap =
    kind === "hotel" ? catalog.hotelIdByContactEmail : catalog.organizationIdByContactEmail;
  const contactEvidence: EvidenceAgreement = addresses.some((a) => contactMap.get(a)?.has(id))
    ? "agrees"
    : "unavailable";

  const agreements = [domainEvidence, nameEvidence, contactEvidence].filter(
    (e) => e === "agrees",
  ).length;
  if (agreements === 0) return null;

  const candidate: TargetCanonicalLinkCandidateInput = {
    observationFingerprint: observation.observationFingerprint,
    targetKind: kind,
    ...(kind === "hotel" ? { targetHotelId: id } : { targetOrganizationId: id }),
    nameEvidence,
    domainEvidence,
    addressEvidence: "unavailable",
    contactEvidence,
    rank: 0,
  };
  return { candidate, agreements };
}

export function matchTargetObservation(
  observation: TargetObservationInput,
  associatedAddresses: readonly string[],
  catalog: CatalogSnapshot,
): TargetMatchResult {
  const addresses = associatedAddresses.map((a) => a.toLowerCase());
  const scored: ScoredCandidate[] = [];

  for (const h of catalog.hotels) {
    const result = evaluateCandidate(
      observation,
      addresses,
      catalog,
      "hotel",
      h.id,
      h.name,
      h.websiteDomain,
    );
    if (result) scored.push(result);
  }
  for (const o of catalog.organizations) {
    const result = evaluateCandidate(
      observation,
      addresses,
      catalog,
      "organization",
      o.id,
      o.name,
      o.websiteDomain,
    );
    if (result) scored.push(result);
  }

  scored.sort((a, b) => b.agreements - a.agreements);
  scored.forEach((s, i) => {
    s.candidate.rank = i;
  });

  const maxAgreements = scored.length > 0 ? Math.max(...scored.map((s) => s.agreements)) : 0;
  const strongCandidates = scored.filter((s) => s.agreements === maxAgreements);

  let assessment: MatchQuality;
  if (scored.length === 0) {
    assessment = "insufficient_evidence";
  } else if (strongCandidates.length > 1) {
    assessment = "ambiguous";
  } else if (maxAgreements >= 2) {
    assessment = "strong_match";
  } else {
    assessment = "needs_review";
  }

  // EXTERNAL AUDIT AMENDMENT #1, Finding 4: the fingerprint must encode the
  // MATCHING-RELEVANT state the matcher actually read — name and website
  // domain, not just an id that a name/domain edit would leave unchanged —
  // plus the exact contact-email relationships evaluated against THIS
  // observation's addresses, so a relevant contact-relation change (a new
  // hotel_contacts row for one of these addresses, or one removed) also
  // changes the fingerprint even when no hotel/organization row itself
  // changed shape.
  const relevantContactPairs = addresses.flatMap((a) => [
    ...[...(catalog.hotelIdByContactEmail.get(a) ?? [])].map((id) => `contact:hotel:${a}:${id}`),
    ...[...(catalog.organizationIdByContactEmail.get(a) ?? [])].map(
      (id) => `contact:org:${a}:${id}`,
    ),
  ]);
  const relevantState = [
    ...catalog.hotels.map((h) => `hotel:${h.id}:${h.name}:${h.websiteDomain ?? ""}`),
    ...catalog.organizations.map((o) => `org:${o.id}:${o.name}:${o.websiteDomain ?? ""}`),
    ...relevantContactPairs,
  ];
  const candidateSetFingerprint = digestOfSortedStrings(relevantState);

  return {
    observation: {
      ...observation,
      machineCanonicalLinkAssessment: assessment,
      candidateSetFingerprint,
    },
    links: scored.map((s) => s.candidate),
  };
}
