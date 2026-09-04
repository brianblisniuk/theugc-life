import { TARGET_MATCHER_VERSION } from "@/lib/gmail/outreach/contract";
import type {
  EvidenceAgreement,
  EvidenceRecipient,
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

/** A bounded, deterministic snapshot of catalog rows relevant to one thread's evaluation. */
export interface CatalogSnapshot {
  epoch: number;
  hotels: readonly CatalogHotel[];
  organizations: readonly CatalogOrganization[];
  /** lower-cased email -> hotel id, from an exact hotel_contacts match. */
  hotelIdByContactEmail: ReadonlyMap<string, string>;
  /** lower-cased email -> organization id, from an exact organization_contacts match. */
  organizationIdByContactEmail: ReadonlyMap<string, string>;
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
 */
export function extractTargetObservations(
  recipients: readonly EvidenceRecipient[],
): TargetObservationInput[] {
  const byDomain = new Map<string, { sourceMessageIds: Set<string>; displayName: string | null }>();

  for (const r of recipients) {
    if (r.role !== "to") continue;
    const domain = r.domainLower;
    if (!domain || FREEMAIL_DOMAINS.has(domain)) continue;
    const entry = byDomain.get(domain) ?? {
      sourceMessageIds: new Set<string>(),
      displayName: null,
    };
    entry.sourceMessageIds.add(r.normalizedMessageId);
    entry.displayName ??= r.displayName;
    byDomain.set(domain, entry);
  }

  const observations: TargetObservationInput[] = [];
  for (const [domain, entry] of byDomain) {
    const label = domain.split(".")[0] ?? domain;
    const observedName = label.charAt(0).toUpperCase() + label.slice(1);
    observations.push({
      observationFingerprint: digestOfString(domain),
      observedName,
      observedDomain: domain,
      targetKindHint: "unknown",
      sourceMessageIds: [...entry.sourceMessageIds],
      // Filled in by matchTargetObservation below.
      machineCanonicalLinkAssessment: "insufficient_evidence",
      candidateSetFingerprint: digestOfString(""),
    });
  }
  return observations;
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
  const contactEvidence: EvidenceAgreement = addresses.some((a) => contactMap.get(a) === id)
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

  const universeIds = [
    ...catalog.hotels.map((h) => `hotel:${h.id}`),
    ...catalog.organizations.map((o) => `org:${o.id}`),
  ];
  const candidateSetFingerprint = digestOfSortedStrings(universeIds);

  return {
    observation: {
      ...observation,
      machineCanonicalLinkAssessment: assessment,
      candidateSetFingerprint,
    },
    links: scored.map((s) => s.candidate),
  };
}
