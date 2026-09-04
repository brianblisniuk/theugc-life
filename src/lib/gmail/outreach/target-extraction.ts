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
export interface HotelOrganizationLink {
  hotelId: string;
  organizationId: string;
  relationship: string;
}

export interface CatalogSnapshot {
  epoch: number;
  hotels: readonly CatalogHotel[];
  organizations: readonly CatalogOrganization[];
  /** lower-cased email -> every hotel id it exactly matches in hotel_contacts. */
  hotelIdByContactEmail: ReadonlyMap<string, ReadonlySet<string>>;
  /** lower-cased email -> every organization id it exactly matches in organization_contacts. */
  organizationIdByContactEmail: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * `hotel_organizations` rows relevant to the bounded hotel/organization
   * universe above (EXTERNAL AUDIT AMENDMENT #2, Finding 4/5) — portfolio
   * relationship evidence (e.g. "this organization is the corporate_group of
   * N of these hotels"), used by `deriveMachineTargetScope` to distinguish a
   * genuine portfolio ask from a single-property one, and folded into the
   * relevant candidate-set fingerprint since the catalog-epoch trigger
   * watches `hotel_organizations` for exactly this reason.
   */
  hotelOrganizationLinks: readonly HotelOrganizationLink[];
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

function namesMatchExactly(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  return na.length > 0 && na === nb;
}

/**
 * EXTERNAL AUDIT AMENDMENT #4, Finding 2: a deterministic, non-NER candidate-
 * phrase extractor over creator-authored (clean, non-quoted, non-uncertain-
 * signature) text — contiguous runs of 1-6 capitalized words, allowing a
 * handful of common lower-case connectors inside a phrase ("Bank of
 * America"). This NEVER by itself asserts that a business exists: a phrase
 * is only meaningful evidence once it is compared, via `computeAuthoredText
 * TargetEvidence` below, against a REAL canonical hotel/organization name for
 * EXACT equality — a false-positive phrase (a person's name, "Thanks Best")
 * simply matches nothing and contributes no evidence.
 */
const CAPITALIZED_WORD = /^[A-Z][A-Za-z0-9''-]*$/;
const PHRASE_CONNECTOR_WORDS = new Set(["of", "and", "the", "de", "la", "&"]);
const TRAILING_CONNECTOR = /(?:\s+(?:of|and|the|de|la|&))+$/i;

export function extractAuthoredTextNameCandidates(text: string): string[] {
  const phrases = new Set<string>();
  let current: string[] = [];

  const flush = () => {
    if (current.length > 0) phrases.add(current.join(" "));
    current = [];
  };

  for (const rawWord of text.split(/\s+/)) {
    const word = rawWord.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9''-]+$/g, "");
    if (word === "") {
      flush();
      continue;
    }
    if (CAPITALIZED_WORD.test(word)) {
      current.push(word);
    } else if (PHRASE_CONNECTOR_WORDS.has(word.toLowerCase()) && current.length > 0) {
      current.push(word);
    } else {
      flush();
    }
  }
  flush();

  // A connector can legitimately extend a single institutional name ("Bank
  // of America") or join two SEPARATE ones ("Hotel Alpha and Hotel Beta") —
  // this cannot be told apart deterministically without knowing the real
  // names in advance. Rather than guess, ALSO decompose every recorded
  // phrase on its connector words and keep both the joined and the split
  // forms as candidates: over-generating is harmless (only an exact match
  // against a REAL catalog name ever becomes evidence), but silently
  // dropping one of two conjunction-joined business names would not be.
  const decomposed = new Set<string>();
  for (const phrase of phrases) {
    decomposed.add(phrase);
    for (const piece of phrase.split(/\s+(?:of|and|the|de|la|&)\s+/i)) {
      if (piece.trim() !== "") decomposed.add(piece.trim());
    }
  }

  return [...decomposed]
    .map((p) => p.replace(TRAILING_CONNECTOR, "").trim())
    .filter((p) => p.length > 0 && p.split(" ").length <= 6);
}

/**
 * Which real canonical hotels/organizations the creator's own authored text
 * explicitly, exactly named — computed against the (possibly authored-text-
 * extended) bounded catalog snapshot. `hasAnyCandidatePhrase` distinguishes
 * "the text named nothing at all" (evidence stays `unavailable` for every
 * candidate) from "the text named something, just not THIS candidate"
 * (evidence becomes `differs` for every candidate it didn't name — see
 * `evaluateCandidate`).
 */
export interface AuthoredTextTargetEvidence {
  matchedHotelIds: ReadonlySet<string>;
  matchedOrganizationIds: ReadonlySet<string>;
  hasAnyCandidatePhrase: boolean;
}

export function computeAuthoredTextTargetEvidence(
  candidatePhrases: readonly string[],
  catalog: Pick<CatalogSnapshot, "hotels" | "organizations">,
): AuthoredTextTargetEvidence {
  const matchedHotelIds = new Set<string>();
  const matchedOrganizationIds = new Set<string>();
  for (const phrase of candidatePhrases) {
    for (const h of catalog.hotels) {
      if (namesMatchExactly(phrase, h.name)) matchedHotelIds.add(h.id);
    }
    for (const o of catalog.organizations) {
      if (namesMatchExactly(phrase, o.name)) matchedOrganizationIds.add(o.id);
    }
  }
  return {
    matchedHotelIds,
    matchedOrganizationIds,
    hasAnyCandidatePhrase: candidatePhrases.length > 0,
  };
}

/**
 * EXTERNAL AUDIT AMENDMENT #3, Finding 3: the private target fact's
 * reconciliation key must incorporate every MATERIAL semantic-matching
 * evidence dimension, exactly the same epistemic principle Amendment #2's
 * Finding 1 already applied to observed recipients. `observedName` is not
 * cosmetic here — `matchTargetObservation` reads it as an independent
 * canonical-matching evidence dimension (`nameEvidence`) — so a domain whose
 * evidence changes from "Hotel A" to a materially different "Hotel B" is a
 * DIFFERENT private fact, never a silent rewrite of the first one's identity
 * while its advisory (machine) fields drift to reflect the second. Lower-
 * cased/trimmed before hashing so cosmetic capitalization differences across
 * two otherwise-identical extractions don't fork a fact that didn't actually
 * change.
 */
export function computeTargetObservationFingerprint(
  domain: string,
  observedName: string | null,
): string {
  const normalizedName = (observedName ?? "").trim().toLowerCase();
  return digestOfString(`${domain}|${normalizedName}`);
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
      observationFingerprint: computeTargetObservationFingerprint(domain, entry.displayName),
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
 * Portfolio/group language: the creator is asking about MULTIPLE properties
 * under one umbrella, not the one business the recipient's own address
 * belongs to. Single-entity language: the creator is addressing ONE specific
 * property/business by name ("your hotel", not "your hotels").
 *
 * EXTERNAL AUDIT AMENDMENT #2, Finding 5: these are real, if crude, evidence
 * of the creator's actual COMMERCIAL INTENT — the same kind of versioned
 * heuristic `interpreter.ts`'s outreach classifier already uses — rather
 * than a mechanical count of how many domains `extractTargetObservations`
 * happened to bucket recipients into, which cannot honestly distinguish "one
 * property" from "one corporate parent representing many properties".
 */
const PORTFOLIO_LANGUAGE_PATTERNS: readonly RegExp[] = [
  /\bportfolio\b/,
  /\byour (hotels|properties|resorts|locations)\b/,
  /\beach of your (hotels|properties|resorts|locations)\b/,
  /\bacross your (portfolio|hotels|properties|resorts|group)\b/,
  /\byour (hotel|property) group\b/,
  /\byour brand'?s? propert(y|ies)\b/,
  /\bgroup[- ]wide\b/,
  /\bmultiple (properties|hotels|locations)\b/,
  /\ball your (hotels|properties|locations)\b/,
  /\byour corporate (group|portfolio)\b/,
];

const SINGLE_ENTITY_LANGUAGE_PATTERNS: readonly RegExp[] = [
  /\byour hotel\b/,
  /\byour property\b/,
  /\byour resort\b/,
  /\bstay at your (hotel|property|resort)\b/,
  /\bfeature your (hotel|property|resort|brand)\b/,
];

export interface ScopeLanguageEvidence {
  hasPortfolioLanguage: boolean;
  hasSingleEntityLanguage: boolean;
}

/** Scans creator-authored text for portfolio-vs-single-property commercial-intent language (Finding 5). */
export function detectScopeLanguage(text: string): ScopeLanguageEvidence {
  const lower = text.toLowerCase();
  return {
    hasPortfolioLanguage: PORTFOLIO_LANGUAGE_PATTERNS.some((p) => p.test(lower)),
    hasSingleEntityLanguage: SINGLE_ENTITY_LANGUAGE_PATTERNS.some((p) => p.test(lower)),
  };
}

export interface ScopeCandidate {
  observation: TargetObservationInput;
  /** The observation's rank-0 (best) canonical link, if it matched one. */
  bestLink: TargetCanonicalLinkCandidateInput | null;
}

/**
 * Conservative, thread-level MACHINE target-scope hint. Never authoritative
 * and never duplicated per observation.
 *
 * EXTERNAL AUDIT AMENDMENT #2, Finding 5: D070 explicitly rejected deriving
 * this from observation CARDINALITY (0/1/2+) — one organization observation
 * can mean either a direct single-property proposal or a portfolio-level ask
 * to a corporate parent, and counting domains cannot tell those apart. This
 * now uses actual commercial-intent evidence instead: portfolio/group
 * language in the creator's own sent text, or an organization candidate with
 * independently-verified multi-hotel portfolio evidence (`hotel_
 * organizations`). When neither is honestly present, it returns
 * `unresolved` rather than guessing from a count.
 */
export function deriveMachineTargetScope(
  candidates: readonly ScopeCandidate[],
  language: ScopeLanguageEvidence,
  hotelOrganizationLinks: readonly HotelOrganizationLink[],
): MachineTargetScopeResult {
  if (candidates.length === 0) {
    return { scope: "unresolved", reasonCodes: ["no_target_observation"] };
  }

  const strong = candidates.filter(
    (c) => c.observation.machineCanonicalLinkAssessment === "strong_match",
  );

  if (language.hasPortfolioLanguage) {
    const portfolioOrganization = strong.find(
      (c) =>
        c.bestLink?.targetKind === "organization" &&
        c.bestLink.targetOrganizationId !== undefined &&
        hotelOrganizationLinks.filter((l) => l.organizationId === c.bestLink!.targetOrganizationId)
          .length >= 2,
    );
    if (portfolioOrganization) {
      return {
        scope: "portfolio_target",
        reasonCodes: ["portfolio_language", "organization_portfolio_evidence"],
      };
    }
    // Portfolio LANGUAGE is itself real, independent evidence of a
    // group-level ask — it does not need catalog corroboration to be
    // honest, since a portfolio the catalog doesn't yet know about is still
    // a portfolio in the creator's own words.
    return { scope: "portfolio_target", reasonCodes: ["portfolio_language"] };
  }

  if (language.hasSingleEntityLanguage && candidates.length === 1 && strong.length === 1) {
    return {
      scope: "single_target",
      reasonCodes: ["single_entity_language", "strong_canonical_match"],
    };
  }

  if (strong.length >= 2) {
    return { scope: "multiple_targets", reasonCodes: ["multiple_strong_target_matches"] };
  }

  return { scope: "unresolved", reasonCodes: ["no_conclusive_scope_language"] };
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
  /** EXTERNAL AUDIT AMENDMENT #4, Finding 2: the creator's own authored text explicitly named a DIFFERENT real business than this one. */
  textContradicted: boolean;
}

function evaluateCandidate(
  observation: TargetObservationInput,
  addresses: readonly string[],
  catalog: CatalogSnapshot,
  authoredTextEvidence: AuthoredTextTargetEvidence,
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

  const matchedIds =
    kind === "hotel"
      ? authoredTextEvidence.matchedHotelIds
      : authoredTextEvidence.matchedOrganizationIds;
  const authoredText: EvidenceAgreement = matchedIds.has(id)
    ? "agrees"
    : authoredTextEvidence.hasAnyCandidatePhrase
      ? "differs"
      : "unavailable";

  const agreements = [domainEvidence, nameEvidence, contactEvidence, authoredText].filter(
    (e) => e === "agrees",
  ).length;
  // A candidate the creator's own text explicitly named enters the universe
  // even with zero other agreements (Finding 2) — the domain/contact
  // evidence alone would otherwise have excluded it entirely.
  if (agreements === 0) return null;

  const candidate: TargetCanonicalLinkCandidateInput = {
    observationFingerprint: observation.observationFingerprint,
    targetKind: kind,
    ...(kind === "hotel" ? { targetHotelId: id } : { targetOrganizationId: id }),
    nameEvidence,
    domainEvidence,
    addressEvidence: "unavailable",
    contactEvidence,
    authoredTextEvidence: authoredText,
    rank: 0,
  };
  return { candidate, agreements, textContradicted: authoredText === "differs" };
}

/**
 * The RELEVANT candidate-set fingerprint alone — no scoring — so a caller can
 * cheaply detect "did anything matching-relevant actually change for this
 * observation" without running `matchTargetObservation`'s full evaluation
 * loop (EXTERNAL AUDIT AMENDMENT #2, Finding 4's two-level fast path:
 * `interpretOneThread` calls this first when only the catalog epoch moved,
 * and only calls the full matcher when the fingerprint differs from what was
 * already stored).
 */
export function computeRelevantCandidateFingerprint(
  associatedAddresses: readonly string[],
  catalog: CatalogSnapshot,
): string {
  const addresses = associatedAddresses.map((a) => a.toLowerCase());

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
  // EXTERNAL AUDIT AMENDMENT #2, Finding 4: `hotel_organizations` rows are
  // part of the relevant candidate universe (portfolio-scope evidence,
  // Finding 5) and §1's catalog-epoch trigger already watches that table —
  // the fingerprint must include them or a portfolio-relationship change
  // would silently never register as "the relevant universe changed".
  const relevantState = [
    ...catalog.hotels.map((h) => `hotel:${h.id}:${h.name}:${h.websiteDomain ?? ""}`),
    ...catalog.organizations.map((o) => `org:${o.id}:${o.name}:${o.websiteDomain ?? ""}`),
    ...relevantContactPairs,
    ...catalog.hotelOrganizationLinks.map(
      (l) => `hotel_org:${l.hotelId}:${l.organizationId}:${l.relationship}`,
    ),
  ];
  return digestOfSortedStrings(relevantState);
}

export function matchTargetObservation(
  observation: TargetObservationInput,
  associatedAddresses: readonly string[],
  catalog: CatalogSnapshot,
  authoredTextCandidateNames: readonly string[] = [],
): TargetMatchResult {
  const addresses = associatedAddresses.map((a) => a.toLowerCase());
  const authoredTextEvidence = computeAuthoredTextTargetEvidence(
    authoredTextCandidateNames,
    catalog,
  );
  const scored: ScoredCandidate[] = [];

  for (const h of catalog.hotels) {
    const result = evaluateCandidate(
      observation,
      addresses,
      catalog,
      authoredTextEvidence,
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
      authoredTextEvidence,
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
  const topScored = scored.filter((s) => s.agreements === maxAgreements);

  // EXTERNAL AUDIT AMENDMENT #4, Finding 2: the candidate(s) that would
  // otherwise be the STRONGEST (or tied-strongest) by domain/name/contact
  // evidence alone can never win an assessment when the creator's own
  // authored text explicitly contradicts them — weaker positional evidence
  // (a shared recipient domain, a contact-email match) must never silently
  // overrule what the creator plainly wrote. This is checked BEFORE the
  // ordinary strong/ambiguous/needs_review ladder below, not folded into the
  // additive agreement count, so a contradiction can never be masked by an
  // otherwise-high score.
  const topContradicted = topScored.some((s) => s.textContradicted);

  let assessment: MatchQuality;
  if (scored.length === 0) {
    assessment = "insufficient_evidence";
  } else if (topContradicted) {
    assessment = "needs_review";
  } else if (topScored.length > 1) {
    assessment = "ambiguous";
  } else if (maxAgreements >= 2) {
    assessment = "strong_match";
  } else {
    assessment = "needs_review";
  }

  const candidateSetFingerprint = computeRelevantCandidateFingerprint(associatedAddresses, catalog);

  return {
    observation: {
      ...observation,
      machineCanonicalLinkAssessment: assessment,
      candidateSetFingerprint,
    },
    links: scored.map((s) => s.candidate),
  };
}
