/**
 * Conservative, explainable entity resolution (IMPORT_SPEC.md §7, D028).
 *
 * Rules:
 *  - Safe auto-match ONLY on deterministic evidence (exact normalized name +
 *    same canonical destination, or exact property-specific canonical URL +
 *    compatible name).
 *  - Fuzzy similarity produces REVIEW CANDIDATES ONLY — never an auto-merge.
 *  - A hotel is NEVER identified solely by email, brand, chain domain, contact
 *    name, agency, or city. This module only ever considers name + destination
 *    + property-specific URL, so those forbidden keys cannot drive identity.
 *  - False merges are worse than temporary duplicates.
 */
import { foldForMatch } from "./normalize";
import type { ContactRecord, PropertyRecord } from "./contract";
import { resolveDestination as resolveDestinationCatalog, type CatalogAlias } from "./destination";
import type { StagedRow } from "./stage";

export interface ExistingHotel {
  id: string;
  name: string;
  nameMatchKey: string;
  destinationId: string | null;
  /** Canonical hotel country (review F2): required for country-scoped fuzzy. */
  countryCode: string | null;
  websiteNormalized: string | null;
  websiteHost: string | null;
}

export interface ExistingDestination {
  id: string;
  name: string;
  nameFold: string;
  slug: string;
  countryCode: string | null;
}

export interface ExistingData {
  hotels: ExistingHotel[];
  destinations: ExistingDestination[];
  /** Active destination aliases (Sprint 1B). Optional for legacy callers. */
  aliases?: CatalogAlias[];
}

export interface MatchCandidate {
  candidateEntityType: "hotel" | "destination" | "organization";
  candidateEntityId: string | null;
  score: number;
  matchMethod: string;
  explanation: string;
  /** True only for approved deterministic rules (safe to auto-match). */
  deterministicSafe: boolean;
}

export interface PropertyResolution {
  stagedRow: StagedRow;
  property: PropertyRecord;
  destinationId: string | null;
  destinationMethod: string | null;
  destinationUnresolved: boolean;
  hotelCandidates: MatchCandidate[];
}

export interface OrganizationCandidate {
  name: string;
  inferredType: string;
  scope: string;
  sourcePropertyKey: string;
  sheetName: string;
  sourceRowNumber: number;
  reason: string;
}

export interface ResolutionResult {
  properties: PropertyResolution[];
  organizationCandidates: OrganizationCandidate[];
}

const FUZZY_THRESHOLD = 0.82;

/** Dice coefficient over character bigrams (0..1). */
export function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      m.set(bg, (m.get(bg) ?? 0) + 1);
    }
    return m;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let overlap = 0;
  let total = 0;
  for (const count of A.values()) total += count;
  for (const count of B.values()) total += count;
  for (const [bg, countA] of A) {
    const countB = B.get(bg) ?? 0;
    overlap += Math.min(countA, countB);
  }
  return (2 * overlap) / total;
}

/**
 * Hosts that back more than one distinct hotel are treated as chain/shared
 * domains: a root-URL match on such a host is NOT a property identity.
 */
function computeChainHosts(existing: ExistingData, stagedProps: PropertyRecord[]): Set<string> {
  const hostCount = new Map<string, Set<string>>();
  const add = (host: string | null, id: string) => {
    if (!host) return;
    if (!hostCount.has(host)) hostCount.set(host, new Set());
    hostCount.get(host)!.add(id);
  };
  existing.hotels.forEach((h) => add(h.websiteHost, `db:${h.id}`));
  stagedProps.forEach((p, i) => {
    const host = p.websiteHost;
    add(host, `stg:${p.sourcePropertyKey}:${i}`);
  });
  const chain = new Set<string>();
  for (const [host, ids] of hostCount) {
    if (ids.size > 1) chain.add(host);
  }
  return chain;
}

function isRootUrl(url: string | null): boolean {
  if (!url) return true;
  try {
    const u = new URL(url);
    return u.pathname === "/" || u.pathname === "";
  } catch {
    return true;
  }
}

function resolveDestination(
  property: PropertyRecord,
  existing: ExistingData,
): { id: string | null; method: string | null } {
  // Single deterministic resolver (DESTINATION_CATALOG.md §5): slug → alias+
  // country → name+country → unresolved. No fuzzy geography.
  const res = resolveDestinationCatalog(
    {
      slug: property.destinationSlug,
      name: property.destinationName,
      countryCode: property.countryCode,
    },
    { destinations: existing.destinations, aliases: existing.aliases ?? [] },
  );
  return { id: res.destinationId, method: res.method };
}

/** Resolve one property against existing entities. */
function resolveProperty(
  stagedRow: StagedRow,
  property: PropertyRecord,
  existing: ExistingData,
  chainHosts: Set<string>,
): PropertyResolution {
  const dest = resolveDestination(property, existing);
  const candidates: MatchCandidate[] = [];

  for (const hotel of existing.hotels) {
    // Deterministic: exact normalized name + same canonical destination.
    if (
      dest.id &&
      hotel.destinationId === dest.id &&
      hotel.nameMatchKey === property.nameMatchKey
    ) {
      candidates.push({
        candidateEntityType: "hotel",
        candidateEntityId: hotel.id,
        score: 1,
        matchMethod: "exact_name_plus_destination",
        explanation: `Exact normalized name "${property.nameMatchKey}" in the same canonical destination.`,
        deterministicSafe: true,
      });
      continue;
    }

    // Deterministic: exact property-specific canonical URL + compatible name.
    const urlEqual =
      property.websiteUrl !== null &&
      hotel.websiteNormalized !== null &&
      property.websiteUrl === hotel.websiteNormalized;
    if (urlEqual) {
      const sim = diceSimilarity(property.nameMatchKey, hotel.nameMatchKey);
      const host = property.websiteHost;
      const chainCollision =
        host !== null && chainHosts.has(host) && isRootUrl(property.websiteUrl);
      if (chainCollision) {
        // Shared chain domain root — must NOT auto-match. Review candidate only.
        candidates.push({
          candidateEntityType: "hotel",
          candidateEntityId: hotel.id,
          score: Number(sim.toFixed(3)),
          matchMethod: "chain_domain_collision",
          explanation: `Same chain/shared host "${host}" at root path — not a property identity; needs review.`,
          deterministicSafe: false,
        });
      } else if (sim >= 0.5) {
        candidates.push({
          candidateEntityType: "hotel",
          candidateEntityId: hotel.id,
          score: Number(Math.max(0.95, sim).toFixed(3)),
          matchMethod: "canonical_url_plus_name",
          explanation: `Exact property-specific URL match with compatible name (similarity ${sim.toFixed(2)}).`,
          deterministicSafe: true,
        });
      }
      continue;
    }

    // Fuzzy: name similarity within the same destination, or — when the
    // destination is unresolved — ONLY within the same non-null country
    // (review F2). Never fuzzy-match globally when country is unknown.
    // Candidate ONLY — never auto-merge.
    const sameArea = dest.id
      ? hotel.destinationId === dest.id
      : property.countryCode !== null &&
        hotel.countryCode !== null &&
        property.countryCode === hotel.countryCode;
    if (sameArea) {
      const sim = diceSimilarity(property.nameMatchKey, hotel.nameMatchKey);
      if (sim >= FUZZY_THRESHOLD && sim < 1) {
        candidates.push({
          candidateEntityType: "hotel",
          candidateEntityId: hotel.id,
          score: Number(sim.toFixed(3)),
          matchMethod: "fuzzy_name",
          explanation: `Fuzzy name similarity ${sim.toFixed(2)} ${
            dest.id ? "in same destination" : `in same country (${property.countryCode})`
          } — review required (never auto-merged).`,
          deterministicSafe: false,
        });
      }
    }
  }

  // Highest score first for readability.
  candidates.sort((a, b) => b.score - a.score);

  return {
    stagedRow,
    property,
    destinationId: dest.id,
    destinationMethod: dest.method,
    destinationUnresolved: dest.id === null,
    hotelCandidates: candidates,
  };
}

/**
 * Derive organization candidates ONLY from an EXPLICIT organization name plus a
 * broader-than-property scope (review F1). A person's name, email, or the
 * property key is NEVER used as an organization identity. Rows with an org-like
 * scope but no organization_name are left flagged (organization_identity_missing)
 * in staging and produce no candidate here.
 */
function deriveOrganizationCandidates(contactRows: StagedRow[]): OrganizationCandidate[] {
  const out: OrganizationCandidate[] = [];
  const seen = new Set<string>();
  const scopeToType: Record<string, string> = {
    group: "hotel_group",
    operator: "operator",
    agency: "pr_agency",
    brand: "hotel_group",
  };
  for (const row of contactRows) {
    const c = row.normalized as unknown as ContactRecord;
    if (!c.contactScope || !(c.contactScope in scopeToType)) continue;
    // Explicit organization name is required — never inferred.
    if (!c.organizationName) continue;
    const key = `${c.contactScope}:${foldForMatch(c.organizationName)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: c.organizationName,
      inferredType: scopeToType[c.contactScope]!,
      scope: c.contactScope,
      sourcePropertyKey: c.sourcePropertyKey,
      sheetName: row.sheetName,
      sourceRowNumber: row.sourceRowNumber,
      reason: `Explicit organization_name with "${c.contactScope}" scope (broader than one property).`,
    });
  }
  return out;
}

/** Resolve all staged property rows + surface organization candidates. */
export function resolveEntities(staged: StagedRow[], existing: ExistingData): ResolutionResult {
  const propertyRows = staged.filter(
    (r) => r.rowKind === "property" && r.normalized !== null && r.status !== "rejected",
  );
  const contactRows = staged.filter(
    (r) => r.rowKind === "contact" && r.normalized !== null && r.status !== "rejected",
  );

  const stagedProps = propertyRows.map((r) => r.normalized as unknown as PropertyRecord);
  const chainHosts = computeChainHosts(existing, stagedProps);

  const properties = propertyRows.map((r) =>
    resolveProperty(r, r.normalized as unknown as PropertyRecord, existing, chainHosts),
  );

  return {
    properties,
    organizationCandidates: deriveOrganizationCandidates(contactRows),
  };
}
