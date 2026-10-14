/**
 * Server-only hotel data access (PRD §7.2, §7.3; PERMISSIONS.md §7).
 *
 * Every function here uses the cookie-bound Supabase client, so RLS evaluates
 * with the caller's identity (`auth.uid()`) and remains authoritative. The
 * service-role client is never used for creator-facing reads.
 *
 * Security model for hotel contacts (D100):
 *   1. `getHotelContactAccess` asks whether this user owns an unlock, or is
 *      admin/editor. A Pass or Pro row is not enough.
 *   2. Only then does `getHotelContactsIfAuthorized` query `hotel_contacts`.
 *      A locked caller never loads an email.
 *   3. `hotel_contacts` RLS (own `contact_unlocks` row, or admin/editor) is
 *      the backstop. `has_premium_hotel_access` still gates intelligence.
 */
import "server-only";

import {
  configuredUnlockCost,
  getOwnCreditBalance,
  getUnlockedCacheEmail,
} from "@/lib/credits/queries";
import { resolveSession } from "@/lib/auth/guards";
import { publicMapPin, type PublicMapPin } from "@/lib/maps/pins";
import { createClient } from "@/lib/supabase/server";

import { mapContactAccess, mayQueryContacts, type ContactAccessResult } from "./access";
import {
  assembleCreatorBadges,
  PUBLIC_CARD_INTELLIGENCE_COLUMNS,
  publicCardSignal,
  type CreatorBadge,
  type PublicCardSignal,
} from "./card-signal";
import { HOTEL_CONTACT_COLUMNS, HOTEL_PUBLIC_COLUMNS } from "./columns";
import {
  destinationSelfAndDescendants,
  DISCOVER_MAX_PAGE_SIZE,
  hasDiscoverNarrowing,
  type DestinationNode,
  type DiscoverQuery,
} from "./filters";
import { isUuid } from "./ids";
import type {
  IntelligenceResult,
  PremiumIntelligenceResult,
  PremiumIntelligenceSignal,
} from "./intelligence";
import {
  isPublishedCanonicalHotel,
  PUBLISHED_ACTIVE_STATUSES,
  PUBLISHABLE_STAR_PROVENANCE_OR,
  PUBLISHED_STAR_RATINGS,
} from "./publication";

export { HOTEL_CONTACT_COLUMNS, HOTEL_PUBLIC_COLUMNS, PREMIUM_CONTACT_FIELDS } from "./columns";
export { isUuid } from "./ids";
export type { ContactAccessResult } from "./access";

/**
 * Latitude and longitude are selected so the read path can apply D062/D054
 * and so a published row can become a map pin (D079). They are not copied
 * onto `HotelSummary`. The pin is a separate object with only public location
 * fields, and it is sent to Google only as a marker position.
 */
const HOTEL_SELECT = `${HOTEL_PUBLIC_COLUMNS.join(", ")}, latitude, longitude, star_rating_source, star_rating_confidence, destination:destinations(id, name, slug, country_code)`;

/**
 * The Supabase client surface these queries use. Aliasing it lets tests inject
 * a stand-in without loosening the production type.
 */
export type HotelQueryClient = Awaited<ReturnType<typeof createClient>>;

/** Upper bound on destinations resolved for a free-text search. */
const DESTINATION_MATCH_LIMIT = 200;

/**
 * Cap on the destination catalog loaded to resolve a slug and its descendants.
 * Hitting the cap fails the search instead of filtering with a truncated tree.
 */
const DESTINATION_CATALOG_LIMIT = 5000;

function emptySearch(page: number, pageSize: number): HotelSearchResult {
  return { hotels: [], pins: [], total: 0, page, pageSize, hasMore: false };
}

/**
 * Contact lifecycle states that must not be shown as a current contact:
 * `replaced` (superseded by a newer row) and `invalid` (known bad).
 */
const RETIRED_CONTACT_STATUSES = new Set(["replaced", "invalid"]);

/** Display priority — most trustworthy contact first. */
const VERIFICATION_RANK: Record<string, number> = {
  verified: 0,
  probable: 1,
  unverified: 2,
  inferred: 3,
  invalid: 4,
};

export interface HotelDestination {
  id: string;
  name: string;
  slug: string;
  countryCode: string | null;
}

export interface HotelSummary {
  id: string;
  name: string;
  slug: string;
  hotelType: string | null;
  starRating: number | null;
  countryCode: string | null;
  websiteUrl: string | null;
  instagramUrl: string | null;
  address: string | null;
  activeStatus: string;
  verificationStatus: string;
  verifiedAt: string | null;
  destination: HotelDestination | null;
}

export interface PublishedHotelView {
  hotel: HotelSummary;
  /** Public location for the map. Not a field of the card. */
  mapPin: PublicMapPin;
}

export interface HotelSearchResult {
  hotels: HotelSummary[];
  /**
   * One pin per hotel, same order. The current filtered page only: Discover
   * does not load the rest of the catalog into the browser (PRD §22).
   */
  pins: PublicMapPin[];
  /** Total matching rows (for pagination), or null when unavailable. */
  total: number | null;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface HotelContact {
  id: string;
  displayName: string | null;
  jobTitle: string | null;
  department: string | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  organizationName: string | null;
  verificationStatus: string | null;
  verifiedAt: string | null;
  status: string | null;
}

/**
 * Coarse PUBLIC intelligence (view `hotel_public_intelligence`). `null` means
 * there is no intelligence row for the hotel — an insufficient-data state, not
 * a zero metric.
 *
 * Reply rate and reply timing are deliberately absent: since 0026 they are
 * premium, and the public view does not project them at all (D050).
 */
export interface HotelIntelligence {
  activityLevel: string | null;
  confidenceLevel: string | null;
  hasObservedCollaboration: boolean | null;
  recencyBand: string | null;
}

/** `pg`/PostgREST may hand back numerics as strings; normalize defensively. */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

type RawDestination = {
  id: string;
  name: string;
  slug: string;
  country_code: string | null;
};

type RawHotel = Record<string, unknown> & {
  destination?: RawDestination | RawDestination[] | null;
};

function mapDestination(raw: RawHotel["destination"]): HotelDestination | null {
  const d = Array.isArray(raw) ? raw[0] : raw;
  if (!d) return null;
  return { id: d.id, name: d.name, slug: d.slug, countryCode: d.country_code ?? null };
}

function publicationFacts(row: RawHotel) {
  return {
    destinationId: typeof row.destination_id === "string" ? row.destination_id : null,
    starRating: toNumber(row.star_rating),
    latitude: toNumber(row.latitude),
    longitude: toNumber(row.longitude),
    activeStatus: typeof row.active_status === "string" ? row.active_status : null,
    starRatingSource:
      row.star_rating_source === undefined
        ? undefined
        : typeof row.star_rating_source === "string"
          ? row.star_rating_source
          : null,
    starRatingConfidence:
      row.star_rating_confidence === undefined
        ? undefined
        : typeof row.star_rating_confidence === "string"
          ? row.star_rating_confidence
          : null,
  };
}

function mapPublished(row: RawHotel): PublishedHotelView | null {
  const facts = publicationFacts(row);
  const latitude = facts.latitude;
  const longitude = facts.longitude;
  if (!isPublishedCanonicalHotel(facts) || latitude === null || longitude === null) return null;
  const hotel: HotelSummary = {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    hotelType: (row.hotel_type as string | null) ?? null,
    starRating: toNumber(row.star_rating),
    countryCode: (row.country_code as string | null) ?? null,
    websiteUrl: (row.website_url as string | null) ?? null,
    instagramUrl: (row.instagram_url as string | null) ?? null,
    address: (row.address as string | null) ?? null,
    activeStatus: (row.active_status as string | null) ?? "unknown",
    verificationStatus: (row.editorial_verification_status as string | null) ?? "unverified",
    verifiedAt: (row.editorial_verified_at as string | null) ?? null,
    destination: mapDestination(row.destination),
  };
  return {
    hotel,
    mapPin: publicMapPin({
      id: hotel.id,
      name: hotel.name,
      latitude,
      longitude,
    }),
  };
}

/**
 * Narrow builder used only so the publication filters can be shared.
 * The Supabase client's own generic instantiates without bound if a helper
 * tries to return it, so call sites cast into this shape.
 */
interface HotelReadBuilder {
  in(column: string, values: readonly (string | number)[]): HotelReadBuilder;
  gte(column: string, value: number): HotelReadBuilder;
  lte(column: string, value: number): HotelReadBuilder;
  eq(column: string, value: string): HotelReadBuilder;
  or(filters: string): HotelReadBuilder;
  order(column: string, options: { ascending: boolean }): HotelReadBuilder;
  range(
    from: number,
    to: number,
  ): Promise<{ data: unknown[] | null; error: { code?: string } | null; count: number | null }>;
  maybeSingle(): Promise<{ data: unknown; error: { code?: string } | null }>;
}

/** D062 column predicate. Applied to every creator-facing hotel read. */
function applyPublishedFilters(builder: HotelReadBuilder): HotelReadBuilder {
  return builder
    .in("star_rating", PUBLISHED_STAR_RATINGS)
    .gte("latitude", -90)
    .lte("latitude", 90)
    .gte("longitude", -180)
    .lte("longitude", 180)
    .in("active_status", PUBLISHED_ACTIVE_STATUSES)
    .or(PUBLISHABLE_STAR_PROVENANCE_OR);
}

const INTELLIGENCE_FILTER_LIMIT = 5000;

/**
 * Hotel ids whose PUBLIC projection discloses the requested signal.
 * Null means the caller did not ask for an intelligence filter.
 * An empty array means nothing disclosed matches — the search must not fall open.
 */
async function disclosedIntelligenceIds(
  supabase: HotelQueryClient,
  query: DiscoverQuery,
): Promise<string[] | null> {
  if (!query.activity && !query.collaboration) return null;
  let request = supabase.from("hotel_public_intelligence").select("hotel_id");
  if (query.activity) request = request.eq("activity_level", query.activity);
  if (query.collaboration) request = request.eq("has_observed_collaboration", true);
  const { data, error } = await request
    .order("hotel_id", { ascending: true })
    .limit(INTELLIGENCE_FILTER_LIMIT + 1);
  if (error) throw new Error("hotel_search_failed:intelligence_scope");
  const rows = data ?? [];
  if (rows.length > INTELLIGENCE_FILTER_LIMIT) {
    throw new Error("hotel_search_failed:intelligence_scope");
  }
  return rows.map((row) => String((row as { hotel_id: string }).hotel_id));
}

export type DestinationScope =
  | { status: "none" }
  | { status: "empty" }
  | { status: "error" }
  | { status: "ok"; rootId: string; ids: string[] };

/**
 * The destination itself and its descendants (D013). A missing slug matches
 * nothing. A failed or truncated catalog is an error, not the whole world.
 */
export async function resolveDestinationScope(
  slug: string | null,
  supabase: HotelQueryClient,
): Promise<DestinationScope> {
  if (!slug) return { status: "none" };
  const { data: catalog, error: catalogError } = await supabase
    .from("destinations")
    .select("id, slug, parent_destination_id")
    .order("id", { ascending: true })
    .limit(DESTINATION_CATALOG_LIMIT);

  if (catalogError) return { status: "error" };
  const rows = catalog ?? [];
  if (rows.length >= DESTINATION_CATALOG_LIMIT) return { status: "error" };

  const nodes: DestinationNode[] = [];
  let rootId: string | null = null;
  for (const row of rows) {
    const record = row as {
      id?: unknown;
      slug?: unknown;
      parent_destination_id?: unknown;
    };
    if (typeof record.id !== "string" || typeof record.slug !== "string") continue;
    nodes.push({
      id: record.id,
      slug: record.slug,
      parentId:
        typeof record.parent_destination_id === "string" ? record.parent_destination_id : null,
    });
    if (record.slug === slug) rootId = record.id;
  }
  if (!rootId) return { status: "empty" };
  return { status: "ok", rootId, ids: destinationSelfAndDescendants(nodes, rootId) };
}

/**
 * Server-side hotel search. Always bounded by `pageSize` (hard-capped) and
 * never selects contact columns. Free-text matches hotel name or the name/slug
 * of the hotel's canonical destination.
 */
export async function searchHotels(
  query: DiscoverQuery,
  /** Injectable for tests; production always uses the cookie-bound client. */
  injectedClient?: HotelQueryClient,
): Promise<HotelSearchResult> {
  const supabase = injectedClient ?? (await createClient());
  const pageSize = Math.min(query.pageSize, DISCOVER_MAX_PAGE_SIZE);
  const page = Math.max(1, query.page);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const scope = await resolveDestinationScope(query.destination, supabase);
  // A failed scope lookup must not fall open to every hotel.
  if (scope.status === "error") throw new Error("hotel_search_failed:destination_scope");
  if (scope.status === "empty") return emptySearch(page, pageSize);
  const destinationIds = scope.status === "ok" ? scope.ids : null;

  const intelligenceIds = await disclosedIntelligenceIds(supabase, query);
  if (intelligenceIds && intelligenceIds.length === 0) return emptySearch(page, pageSize);

  let builder = applyPublishedFilters(
    supabase.from("hotels").select(HOTEL_SELECT, { count: "exact" }) as unknown as HotelReadBuilder,
  );

  if (query.q) {
    // Resolve destinations matching the term first, so a search for "Dubai"
    // finds hotels whose *destination* matches, not only hotel names. The cap
    // is deliberately far above the destination catalog's size and ordered, so
    // the id set is deterministic across pages of the same search.
    const { data: destRows, error: destError } = await supabase
      .from("destinations")
      .select("id")
      .or(`name.ilike.%${query.q}%,slug.ilike.%${query.q}%`)
      .order("id", { ascending: true })
      .limit(DESTINATION_MATCH_LIMIT);

    // A failed destination lookup would silently degrade this into a
    // hotel-name-only search and report "no hotels match" — a false domain
    // result. Fail loudly instead so Discover renders its recoverable error.
    if (destError) throw new Error("hotel_search_failed:destination_lookup");

    const destIds = (destRows ?? []).map((d) => String((d as { id: string }).id));
    const orParts = [`name.ilike.%${query.q}%`];
    if (destIds.length > 0) orParts.push(`destination_id.in.(${destIds.join(",")})`);
    builder = builder.or(orParts.join(","));
  }

  if (destinationIds) builder = builder.in("destination_id", destinationIds);
  if (intelligenceIds) builder = builder.in("id", intelligenceIds);
  if (query.country) builder = builder.eq("country_code", query.country);
  if (query.type) builder = builder.eq("hotel_type", query.type);
  if (query.minStars !== null) builder = builder.gte("star_rating", query.minStars);
  if (query.verification) builder = builder.eq("editorial_verification_status", query.verification);

  // `id` is a stable tiebreaker: without it, hotels sharing a name could be
  // duplicated or skipped across page boundaries.
  const { data, error, count } = await builder
    .order("name", { ascending: true })
    .order("id", { ascending: true })
    .range(from, to);

  if (error) throw new Error(`hotel_search_failed:${error.code ?? "unknown"}`);

  const published = (data ?? [])
    .map((row) => mapPublished(row as unknown as RawHotel))
    .filter((row): row is PublishedHotelView => row !== null);
  const hotels = published.map((row) => row.hotel);
  const total = typeof count === "number" ? count : null;
  return {
    hotels,
    pins: published.map((row) => row.mapPin),
    total,
    page,
    pageSize,
    hasMore: total === null ? hotels.length === pageSize : from + hotels.length < total,
  };
}

const RETAIN_CHUNK = 100;

/**
 * Keep candidate ids that still match the Discover filters, in the candidate
 * order. No narrowing returns the same ids. A lookup failure throws.
 */
export async function retainDiscoverHotelIds(
  query: DiscoverQuery,
  orderedIds: readonly string[],
  injectedClient?: HotelQueryClient,
): Promise<string[]> {
  if (!hasDiscoverNarrowing(query)) return [...orderedIds];
  if (orderedIds.length > 5000) throw new Error("hotel_search_failed:metric_rank");
  const supabase = injectedClient ?? (await createClient());
  const intelligenceIds = await disclosedIntelligenceIds(supabase, query);
  if (intelligenceIds && intelligenceIds.length === 0) return [];
  const intelligence = intelligenceIds ? new Set(intelligenceIds) : null;

  let textDestinationIds: string[] = [];
  if (query.q) {
    const { data: destRows, error: destError } = await supabase
      .from("destinations")
      .select("id")
      .or(`name.ilike.%${query.q}%,slug.ilike.%${query.q}%`)
      .order("id", { ascending: true })
      .limit(DESTINATION_MATCH_LIMIT);
    if (destError) throw new Error("hotel_search_failed:destination_lookup");
    textDestinationIds = (destRows ?? []).map((row) => String((row as { id: string }).id));
  }

  const matched = new Set<string>();
  for (let index = 0; index < orderedIds.length; index += RETAIN_CHUNK) {
    const chunk = orderedIds.slice(index, index + RETAIN_CHUNK);
    let builder = applyPublishedFilters(
      supabase
        .from("hotels")
        .select("id")
        .in("id", [...chunk]) as unknown as HotelReadBuilder,
    );
    if (query.country) builder = builder.eq("country_code", query.country);
    if (query.type) builder = builder.eq("hotel_type", query.type);
    if (query.minStars !== null) builder = builder.gte("star_rating", query.minStars);
    if (query.verification)
      builder = builder.eq("editorial_verification_status", query.verification);
    if (query.q) {
      const orParts = [`name.ilike.%${query.q}%`];
      if (textDestinationIds.length > 0) {
        orParts.push(`destination_id.in.(${textDestinationIds.join(",")})`);
      }
      builder = builder.or(orParts.join(","));
    }
    const { data, error } = await builder.range(0, chunk.length - 1);
    if (error) throw new Error(`hotel_search_failed:${error.code ?? "unknown"}`);
    for (const row of data ?? []) {
      const id = String((row as { id?: unknown }).id ?? "");
      if (id && (!intelligence || intelligence.has(id))) matched.add(id);
    }
  }
  return orderedIds.filter((id) => matched.has(id));
}

/**
 * Published hotels in the caller's id order. A missing id is a failed read,
 * not a hole filled from the name order.
 */
export async function loadPublishedInOrder(
  ids: readonly string[],
  injectedClient?: HotelQueryClient,
): Promise<PublishedHotelView[]> {
  if (ids.length === 0) return [];
  const supabase = injectedClient ?? (await createClient());
  const { data, error } = await applyPublishedFilters(
    supabase
      .from("hotels")
      .select(HOTEL_SELECT)
      .in("id", [...ids]) as unknown as HotelReadBuilder,
  ).range(0, ids.length - 1);
  if (error) throw new Error(`hotel_search_failed:${error.code ?? "unknown"}`);
  const byId = new Map<string, PublishedHotelView>();
  for (const row of data ?? []) {
    const mapped = mapPublished(row as unknown as RawHotel);
    if (mapped) byId.set(mapped.hotel.id, mapped);
  }
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) throw new Error("hotel_search_failed:metric_rank");
    return row;
  });
}

/**
 * Fetch one hotel by UUID.
 *
 * Returns null ONLY when the id is malformed or the hotel genuinely does not
 * exist (the caller renders not-found). A transport/query failure throws, so a
 * transient outage surfaces as an error boundary rather than telling the user
 * the hotel does not exist.
 */
export async function getHotelById(
  id: string,
  /** Injectable for tests; production always uses the cookie-bound client. */
  injectedClient?: HotelQueryClient,
): Promise<PublishedHotelView | null> {
  if (!isUuid(id)) return null;
  const supabase = injectedClient ?? (await createClient());
  const { data, error } = await applyPublishedFilters(
    supabase.from("hotels").select(HOTEL_SELECT).eq("id", id) as unknown as HotelReadBuilder,
  ).maybeSingle();
  if (error) throw new Error(`hotel_fetch_failed:${error.code ?? "unknown"}`);
  if (!data) return null;
  return mapPublished(data as unknown as RawHotel);
}

/**
 * Ask the database whether the current user may read this hotel's premium
 * contacts. Uses the self-scoped wrapper, which evaluates only for auth.uid().
 *
 * Returns a three-state result: a failed check is `error`, never `denied`, so
 * a transient outage cannot tell a paying creator they lack access (F1).
 */
export interface HotelContactPanel {
  access: ContactAccessResult;
  /** Staff may read without an unlock row. They are not "already unlocked". */
  via: "unlock" | "staff" | "none";
  contacts: HotelContact[];
  failed: boolean;
  /** Cache email when hotel_contacts has no row. Null unless this caller may see it. */
  cacheEmail: string | null;
  balance: number | null;
  cost: number;
}

export async function getHotelContactAccess(hotelId: string): Promise<ContactAccessResult> {
  if (!isUuid(hotelId)) return { status: "denied" };
  const session = await resolveSession();
  if (session.status === "error") return { status: "error" };
  if (session.status !== "authenticated") return { status: "denied" };
  if (session.session.role === "admin" || session.session.role === "editor") {
    return { status: "allowed" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("has_unlocked_hotel_contact", { p_hotel_id: hotelId });
  return mapContactAccess({ data, error });
}

/**
 * Return contacts ONLY for an unlock owner or staff. A locked caller does not
 * query `hotel_contacts` or the cache email.
 */
export async function getHotelContactsIfAuthorized(hotelId: string): Promise<HotelContactPanel> {
  const cost = configuredUnlockCost();
  const access = await getHotelContactAccess(hotelId);
  const balanceResult = await getOwnCreditBalance();
  const balance = balanceResult.status === "ok" ? balanceResult.balance : null;
  // Denied AND error both skip the query — security stays fail-closed.
  if (!mayQueryContacts(access)) {
    return { access, via: "none", contacts: [], failed: false, cacheEmail: null, balance, cost };
  }
  const session = await resolveSession();
  const via =
    session.status === "authenticated" &&
    (session.session.role === "admin" || session.session.role === "editor")
      ? "staff"
      : "unlock";

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("hotel_contacts")
    .select(HOTEL_CONTACT_COLUMNS.join(", "))
    .eq("hotel_id", hotelId);

  // A failed fetch is NOT "this hotel has no contact" — the caller must be able
  // to tell the difference so an entitled user is never told data is absent.
  if (error) {
    return { access, via, contacts: [], failed: true, cacheEmail: null, balance, cost };
  }

  const contacts = (data ?? [])
    .map((raw) => {
      const row = raw as unknown as Record<string, unknown>;
      const display =
        (row.display_name as string | null) ??
        [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
      return {
        id: String(row.id),
        displayName: display ? String(display) : null,
        jobTitle: (row.job_title as string | null) ?? null,
        department: (row.department as string | null) ?? null,
        email: (row.email as string | null) ?? null,
        phone: (row.phone as string | null) ?? null,
        linkedinUrl: (row.linkedin_url as string | null) ?? null,
        organizationName: (row.organization_name as string | null) ?? null,
        verificationStatus: (row.verification_status as string | null) ?? null,
        verifiedAt: (row.verified_at as string | null) ?? null,
        status: (row.status as string | null) ?? null,
      } satisfies HotelContact;
    })
    // Never present a superseded or known-bad contact as current.
    .filter((c) => !RETIRED_CONTACT_STATUSES.has(c.status ?? ""))
    .filter((c) => c.verificationStatus !== "invalid")
    // Most trustworthy first. (Sorting in SQL would order the status text
    // alphabetically, which puts `inferred` above `verified`.)
    .sort(
      (a, b) =>
        (VERIFICATION_RANK[a.verificationStatus ?? ""] ?? 9) -
        (VERIFICATION_RANK[b.verificationStatus ?? ""] ?? 9),
    );

  const cacheEmail = contacts.some((contact) => contact.email)
    ? null
    : await getUnlockedCacheEmail(hotelId);
  return { access, via, contacts, failed: false, cacheEmail, balance, cost };
}

/**
 * Coarse public intelligence for a hotel. Reads ONLY the safe projection view
 * (never `hotel_intelligence` or `outreach_events`). Returns null when the
 * hotel has no intelligence row — the caller must render an insufficient-data
 * state rather than zeroed metrics.
 */
export async function getHotelIntelligence(
  hotelId: string,
  /** Injectable for tests; production always uses the cookie-bound client. */
  injectedClient?: HotelQueryClient,
): Promise<IntelligenceResult> {
  // A malformed id has no intelligence row; that is a genuine absence.
  if (!isUuid(hotelId)) return { status: "none" };
  const supabase = injectedClient ?? (await createClient());
  const { data, error } = await supabase
    .from("hotel_public_intelligence")
    .select("activity_level, confidence_level, has_observed_collaboration, recency_band")
    .eq("hotel_id", hotelId)
    .maybeSingle();

  // A failed query is NOT "no creator data" (F2).
  if (error) return { status: "error" };
  if (!data) return { status: "none" };
  const row = data as Record<string, unknown>;
  const signal: HotelIntelligence = {
    activityLevel: (row.activity_level as string | null) ?? null,
    confidenceLevel: (row.confidence_level as string | null) ?? null,
    hasObservedCollaboration: (row.has_observed_collaboration as boolean | null) ?? null,
    recencyBand: (row.recency_band as string | null) ?? null,
  };
  return { status: "ok", signal };
}

/**
 * PREMIUM intelligence for a hotel (view `hotel_premium_intelligence`).
 *
 * Call this ONLY after the entitlement check has answered `allowed`. The view
 * is entitlement-gated in the database as well, so an unentitled caller would
 * receive zero rows anyway — but "zero rows" cannot distinguish *not entitled*
 * from *no data yet*, and the product must never confuse locked with building.
 * Resolving entitlement separately is what keeps those two states apart.
 *
 * Reads only the gated projection: never `hotel_intelligence`, never
 * `outreach_events`, never `collaborations`.
 */
export async function getHotelPremiumIntelligence(
  hotelId: string,
  /** Injectable for tests; production always uses the cookie-bound client. */
  injectedClient?: HotelQueryClient,
): Promise<PremiumIntelligenceResult> {
  if (!isUuid(hotelId)) return { status: "none" };
  const supabase = injectedClient ?? (await createClient());
  const { data, error } = await supabase
    .from("hotel_premium_intelligence")
    .select(
      "confidence_level, reply_rate, reply_time_band, recent_activity_band, collaboration_types, contributor_count",
    )
    .eq("hotel_id", hotelId)
    .maybeSingle();

  if (error) return { status: "error" };
  if (!data) return { status: "none" };
  const row = data as Record<string, unknown>;
  const types = row.collaboration_types;
  const signal: PremiumIntelligenceSignal = {
    confidenceLevel: (row.confidence_level as string | null) ?? null,
    replyRate: toNumber(row.reply_rate),
    replyTimeBand: (row.reply_time_band as string | null) ?? null,
    recentActivityBand: (row.recent_activity_band as string | null) ?? null,
    collaborationTypes: Array.isArray(types) ? types.map((t) => String(t)) : null,
    contributorCount: toNumber(row.contributor_count),
  };
  return { status: "ok", signal };
}

export interface DiscoverDestinationOption {
  slug: string;
  name: string;
  type: string;
}

export interface DiscoverCountryOption {
  code: string;
  name: string;
}

export type DiscoverCatalog =
  | {
      status: "ok";
      destinations: DiscoverDestinationOption[];
      countries: DiscoverCountryOption[];
    }
  | { status: "error" };

/**
 * Destination and country choices for the Discover filters. A failed read is
 * an error, not an empty catalog — an empty list would tell the creator no
 * destinations exist.
 */
export async function listDiscoverCatalog(
  injectedClient?: HotelQueryClient,
): Promise<DiscoverCatalog> {
  try {
    const supabase = injectedClient ?? (await createClient());
    const { data, error } = await supabase
      .from("destinations")
      .select("name, slug, type, country_code, country_name")
      .order("name", { ascending: true })
      .limit(5000);
    if (error) return { status: "error" };
    const rows = data ?? [];
    if (rows.length >= 5000) return { status: "error" };
    const destinations: DiscoverDestinationOption[] = [];
    const countries = new Map<string, string>();
    for (const raw of rows) {
      const row = raw as {
        name?: unknown;
        slug?: unknown;
        type?: unknown;
        country_code?: unknown;
        country_name?: unknown;
      };
      if (typeof row.slug !== "string" || typeof row.name !== "string") continue;
      destinations.push({
        slug: row.slug,
        name: row.name,
        type: typeof row.type === "string" ? row.type : "destination",
      });
      if (typeof row.country_code === "string" && /^[A-Za-z]{2}$/.test(row.country_code)) {
        const code = row.country_code.toUpperCase();
        const name =
          typeof row.country_name === "string" && row.country_name.trim().length > 0
            ? row.country_name.trim()
            : code;
        if (!countries.has(code)) countries.set(code, name);
      }
    }
    destinations.sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
    const countryOptions = [...countries.entries()]
      .map(([code, name]) => ({ code, name }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code));
    return { status: "ok", destinations, countries: countryOptions };
  } catch {
    return { status: "error" };
  }
}

/**
 * Public signals for the hotels on this page. A failed read returns null.
 * Callers must not render that as "no creator activity".
 */
export async function getPublicCardSignals(
  hotelIds: readonly string[],
  injectedClient?: HotelQueryClient,
): Promise<Map<string, PublicCardSignal> | null> {
  const ids = hotelIds.filter((id) => isUuid(id));
  if (ids.length === 0) return new Map();
  try {
    const supabase = injectedClient ?? (await createClient());
    const { data, error } = await supabase
      .from("hotel_public_intelligence")
      .select(PUBLIC_CARD_INTELLIGENCE_COLUMNS.join(", "))
      .in("hotel_id", ids);
    if (error) return null;
    const signals = new Map<string, PublicCardSignal>();
    for (const raw of data ?? []) {
      const row = raw as unknown as Record<string, unknown>;
      if (typeof row.hotel_id !== "string") continue;
      signals.set(
        row.hotel_id,
        publicCardSignal({
          activityLevel: (row.activity_level as string | null) ?? null,
          recencyBand: (row.recency_band as string | null) ?? null,
          hasObservedCollaboration: (row.has_observed_collaboration as boolean | null) ?? null,
        }),
      );
    }
    return signals;
  } catch {
    return null;
  }
}

function oneCreatorId(raw: unknown): string | null {
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (!row || typeof row !== "object") return null;
  const id = (row as { creator_id?: unknown }).creator_id;
  return typeof id === "string" ? id : null;
}

/**
 * `creator_profiles.id` for the signed-in user.
 *
 * Pipeline and trip rows store that id (`current_creator_id()`), not
 * `auth.uid()`. A failed lookup, a missing row, or a non-uuid id is `null`.
 * Callers must treat `null` as unknown, not as an empty shortlist.
 */
export async function resolveOwnCreatorProfileId(
  authUserId: string,
  injectedClient?: HotelQueryClient,
): Promise<string | null> {
  if (!isUuid(authUserId)) return null;
  try {
    const supabase = injectedClient ?? (await createClient());
    const { data, error } = await supabase
      .from("creator_profiles")
      .select("id")
      .eq("user_id", authUserId)
      .maybeSingle();
    if (error || !data) return null;
    const id = (data as { id?: unknown }).id;
    if (typeof id !== "string" || !isUuid(id)) return null;
    return id;
  } catch {
    return null;
  }
}

/**
 * The viewer's own pipeline and trip badges for these hotels.
 *
 * `viewerId` must be `creator_profiles.id`, not `auth.uid()`. Both reads use
 * the cookie-bound client. If either fails, the whole load is `unknown` — a
 * missing badge must not be described as "not saved" or "not on a trip".
 * Foreign creator ids are dropped by `assembleCreatorBadges` even if a row
 * arrives.
 */
export async function loadCreatorBadges(
  hotelIds: readonly string[],
  viewerId: string,
  injectedClient?: HotelQueryClient,
): Promise<{ status: "known"; byHotel: Map<string, CreatorBadge> } | { status: "unknown" }> {
  if (!isUuid(viewerId)) return { status: "unknown" };
  const ids = hotelIds.filter((id) => isUuid(id));
  if (ids.length === 0) {
    return {
      status: "known",
      byHotel: assembleCreatorBadges({
        hotelIds,
        viewerId,
        pipelineRows: [],
        tripRows: [],
      }),
    };
  }
  try {
    const supabase = injectedClient ?? (await createClient());
    const [pipeline, trips] = await Promise.all([
      supabase
        .from("pipeline_items")
        .select("hotel_id, creator_id, status")
        .in("hotel_id", ids)
        .neq("status", "closed"),
      supabase
        .from("trip_hotels")
        .select("hotel_id, trip_id, trip:trips!inner(creator_id)")
        .in("hotel_id", ids),
    ]);
    if (pipeline.error || trips.error) return { status: "unknown" };
    const pipelineRows = (pipeline.data ?? []).flatMap((raw) => {
      const row = raw as { hotel_id?: unknown; creator_id?: unknown; status?: unknown };
      if (
        typeof row.hotel_id !== "string" ||
        typeof row.creator_id !== "string" ||
        typeof row.status !== "string"
      ) {
        return [];
      }
      return [{ hotelId: row.hotel_id, creatorId: row.creator_id, status: row.status }];
    });
    const tripRows = (trips.data ?? []).flatMap((raw) => {
      const row = raw as { hotel_id?: unknown; trip_id?: unknown; trip?: unknown };
      const creatorId = oneCreatorId(row.trip);
      if (typeof row.hotel_id !== "string" || typeof row.trip_id !== "string" || !creatorId) {
        return [];
      }
      return [{ hotelId: row.hotel_id, creatorId, tripId: row.trip_id }];
    });
    return {
      status: "known",
      byHotel: assembleCreatorBadges({ hotelIds: ids, viewerId, pipelineRows, tripRows }),
    };
  } catch {
    return { status: "unknown" };
  }
}

/**
 * Resolve the session user's creator profile, then load that profile's badges.
 *
 * Discover and Hotel Detail pass `session.userId` (`auth.uid()`). Comparing
 * that value to `pipeline_items.creator_id` drops the viewer's own rows,
 * because those rows store `creator_profiles.id`. A failed profile lookup is
 * `unknown`, not an empty shortlist.
 */
export async function loadSessionCreatorBadges(
  hotelIds: readonly string[],
  authUserId: string,
  injectedClient?: HotelQueryClient,
): Promise<{ status: "known"; byHotel: Map<string, CreatorBadge> } | { status: "unknown" }> {
  const supabase = injectedClient ?? (await createClient());
  const creatorProfileId = await resolveOwnCreatorProfileId(authUserId, supabase);
  if (!creatorProfileId) return { status: "unknown" };
  return loadCreatorBadges(hotelIds, creatorProfileId, supabase);
}
