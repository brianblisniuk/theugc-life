/**
 * Discover search/filter parameter parsing (PRD §7.2, §22; ROUTES.md §10).
 *
 * Pure and framework-free so it can be unit-tested without a database: URL
 * search params in, a validated, bounded query object out. Unknown or malformed
 * values are dropped rather than passed to the database, and the result set is
 * always bounded — Discover must never attempt to load the whole dataset
 * (PRD §22: "Do not load every hotel/contact record into browser memory").
 */
import { HOTEL_TYPES } from "@/lib/import/contract";

/** Canonical hotel-type vocabulary the importer writes (HOTEL_DATA_CONTRACT §3). */
export const HOTEL_TYPE_FILTERS = HOTEL_TYPES;

/** editorial_verification_status values allowed by the hotels CHECK constraint. */
export const VERIFICATION_FILTERS = ["verified", "needs_review", "stale", "unverified"] as const;
export type VerificationFilter = (typeof VERIFICATION_FILTERS)[number];

/** Star filter is a MINIMUM rating ("4" means 4 stars and above). */
export const STAR_FILTERS = ["3", "4", "5"] as const;

/** Default page size, and the hard ceiling a caller can request. */
export const DISCOVER_PAGE_SIZE = 24;
export const DISCOVER_MAX_PAGE_SIZE = 50;

/** Longest search term we forward to the database. */
export const MAX_SEARCH_LENGTH = 80;

export interface DiscoverQuery {
  /** Sanitized free-text term, or null when absent. */
  q: string | null;
  /** Canonical hotel_type, or null. */
  type: string | null;
  /** Minimum star rating (3, 4, or 5), or null. */
  minStars: number | null;
  /** editorial_verification_status, or null. */
  verification: VerificationFilter | null;
  /**
   * Canonical destination slug (ROUTES.md §10). Null when absent or malformed.
   * A well-formed slug that matches no destination is still a filter: Discover
   * must not fall open to the whole catalog.
   */
  destination: string | null;
  /** 1-based page number. */
  page: number;
  /** Bounded page size. */
  pageSize: number;
}

/** Destination slugs are lowercase words separated by single hyphens. */
const DESTINATION_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseDestinationSlug(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const slug = raw.trim().toLowerCase();
  if (slug.length < 1 || slug.length > 80) return null;
  return DESTINATION_SLUG.test(slug) ? slug : null;
}

export interface DestinationNode {
  id: string;
  slug: string;
  parentId: string | null;
}

/**
 * The destination itself plus descendants, depth-capped at 20 — the same cap
 * as `_destination_is_descendant` (D013: a destination is a hierarchy).
 */
export function destinationSelfAndDescendants(
  nodes: readonly DestinationNode[],
  rootId: string,
): string[] {
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node.id);
    children.set(node.parentId, list);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  let frontier = [rootId];
  for (let depth = 0; depth < 20 && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      for (const child of children.get(id) ?? []) next.push(child);
    }
    frontier = next;
  }
  return out;
}

export type RawSearchParams = Record<string, string | string[] | undefined>;

/** Take the first value when Next.js hands us a repeated query param. */
function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * Normalize a user search term. Collapses whitespace, caps length, and strips
 * characters that carry meaning in a PostgREST `or=(...)` filter so a term can
 * never break out of the value it is bound to.
 */
export function sanitizeSearchTerm(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    // `%` and `_` are ILIKE wildcards; `(),*\\"'` carry meaning in a
    // PostgREST or=(...) filter. Strip them so a term is matched literally.
    .replace(/[(),*%_\\"']/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SEARCH_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}

/** Parse raw URL search params into a validated, bounded Discover query. */
export function parseDiscoverQuery(params: RawSearchParams = {}): DiscoverQuery {
  const q = sanitizeSearchTerm(first(params.q));

  const rawType = first(params.type);
  const type =
    rawType && (HOTEL_TYPE_FILTERS as readonly string[]).includes(rawType) ? rawType : null;

  const rawStars = first(params.stars);
  const minStars =
    rawStars && (STAR_FILTERS as readonly string[]).includes(rawStars) ? Number(rawStars) : null;

  const rawVerification = first(params.verified);
  const verification =
    rawVerification && (VERIFICATION_FILTERS as readonly string[]).includes(rawVerification)
      ? (rawVerification as VerificationFilter)
      : null;

  const destination = parseDestinationSlug(first(params.destination));

  const rawPage = Number(first(params.page));
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;

  const rawSize = Number(first(params.pageSize));
  const pageSize =
    Number.isInteger(rawSize) && rawSize >= 1
      ? Math.min(rawSize, DISCOVER_MAX_PAGE_SIZE)
      : DISCOVER_PAGE_SIZE;

  return { q, type, minStars, verification, destination, page, pageSize };
}

/** True when any user-controlled narrowing is active (drives the reset CTA). */
export function hasActiveFilters(query: DiscoverQuery): boolean {
  return Boolean(
    query.q || query.type || query.minStars || query.verification || query.destination,
  );
}

/** Build a `/app/discover` href from a query, omitting defaults. */
export function buildDiscoverHref(query: Partial<DiscoverQuery>): string {
  const sp = new URLSearchParams();
  if (query.q) sp.set("q", query.q);
  if (query.type) sp.set("type", query.type);
  if (query.minStars) sp.set("stars", String(query.minStars));
  if (query.verification) sp.set("verified", query.verification);
  if (query.destination) sp.set("destination", query.destination);
  if (query.page && query.page > 1) sp.set("page", String(query.page));
  // Preserve a non-default page size, otherwise paging would silently change
  // the window and skip or repeat rows.
  if (query.pageSize && query.pageSize !== DISCOVER_PAGE_SIZE) {
    sp.set("pageSize", String(query.pageSize));
  }
  const qs = sp.toString();
  return qs ? `/app/discover?${qs}` : "/app/discover";
}

/** Human label for a canonical hotel_type ("boutique_hotel" → "Boutique hotel"). */
export function hotelTypeLabel(type: string | null): string | null {
  if (!type) return null;
  const spaced = type.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Human label for editorial_verification_status. */
export function verificationLabel(status: string | null): string {
  switch (status) {
    case "verified":
      return "Editorially verified";
    case "needs_review":
      return "Needs review";
    case "stale":
      return "Verification stale";
    default:
      return "Unverified";
  }
}
