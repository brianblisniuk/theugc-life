/**
 * Server-only hotel data access (PRD §7.2, §7.3; PERMISSIONS.md §7).
 *
 * Every function here uses the cookie-bound Supabase client, so RLS evaluates
 * with the caller's identity (`auth.uid()`) and remains authoritative. The
 * service-role client is never used for creator-facing reads.
 *
 * Security model for premium contacts:
 *   1. `getHotelContactAccess` asks the database whether this user may see
 *      contacts (self-scoped `has_premium_hotel_access` wrapper).
 *   2. Only when that is true does `getHotelContactsIfAuthorized` issue the
 *      contact query at all. Unauthorized callers never cause email/phone/
 *      LinkedIn values to be selected, transferred, or serialized to the client
 *      — the locked state is rendered from an access flag alone.
 *   3. `hotel_contacts` RLS (`using (public.has_premium_hotel_access(hotel_id))`)
 *      remains the backstop if application code is ever wrong.
 */
import "server-only";

import { createClient } from "@/lib/supabase/server";

import { mapContactAccess, mayQueryContacts, type ContactAccessResult } from "./access";
import { HOTEL_CONTACT_COLUMNS, HOTEL_PUBLIC_COLUMNS } from "./columns";
import { DISCOVER_MAX_PAGE_SIZE, type DiscoverQuery } from "./filters";
import { isUuid } from "./ids";
import type {
  IntelligenceResult,
  PremiumIntelligenceResult,
  PremiumIntelligenceSignal,
} from "./intelligence";

export { HOTEL_CONTACT_COLUMNS, HOTEL_PUBLIC_COLUMNS, PREMIUM_CONTACT_FIELDS } from "./columns";
export { isUuid } from "./ids";
export type { ContactAccessResult } from "./access";

const HOTEL_SELECT = `${HOTEL_PUBLIC_COLUMNS.join(", ")}, destination:destinations(id, name, slug, country_code)`;

/**
 * The Supabase client surface these queries use. Aliasing it lets tests inject
 * a stand-in without loosening the production type.
 */
export type HotelQueryClient = Awaited<ReturnType<typeof createClient>>;

/** Upper bound on destinations resolved for a free-text search. */
const DESTINATION_MATCH_LIMIT = 200;

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

export interface HotelSearchResult {
  hotels: HotelSummary[];
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
  hasConfirmedCollaboration: boolean | null;
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

function mapHotel(row: RawHotel): HotelSummary {
  return {
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

  let builder = supabase.from("hotels").select(HOTEL_SELECT, { count: "exact" });

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

  const hotels = (data ?? []).map((row) => mapHotel(row as unknown as RawHotel));
  const total = typeof count === "number" ? count : null;
  return {
    hotels,
    total,
    page,
    pageSize,
    hasMore: total === null ? hotels.length === pageSize : from + hotels.length < total,
  };
}

/**
 * Fetch one hotel by UUID.
 *
 * Returns null ONLY when the id is malformed or the hotel genuinely does not
 * exist (the caller renders not-found). A transport/query failure throws, so a
 * transient outage surfaces as an error boundary rather than telling the user
 * the hotel does not exist.
 */
export async function getHotelById(id: string): Promise<HotelSummary | null> {
  if (!isUuid(id)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("hotels")
    .select(HOTEL_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`hotel_fetch_failed:${error.code ?? "unknown"}`);
  if (!data) return null;
  return mapHotel(data as unknown as RawHotel);
}

/**
 * Ask the database whether the current user may read this hotel's premium
 * contacts. Uses the self-scoped wrapper, which evaluates only for auth.uid().
 *
 * Returns a three-state result: a failed check is `error`, never `denied`, so
 * a transient outage cannot tell a paying creator they lack access (F1).
 */
export async function getHotelContactAccess(hotelId: string): Promise<ContactAccessResult> {
  // A malformed id is a genuine denial, not an infrastructure failure.
  if (!isUuid(hotelId)) return { status: "denied" };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("has_premium_hotel_access", { hotel_id: hotelId });
  return mapContactAccess({ data, error });
}

/**
 * Return contacts ONLY for an authorized caller. When access is false this does
 * not query `hotel_contacts` at all, so no premium value is ever loaded into
 * the server render or serialized to the client.
 */
export async function getHotelContactsIfAuthorized(
  hotelId: string,
): Promise<{ access: ContactAccessResult; contacts: HotelContact[]; failed: boolean }> {
  const access = await getHotelContactAccess(hotelId);
  // Denied AND error both skip the query — security stays fail-closed.
  if (!mayQueryContacts(access)) return { access, contacts: [], failed: false };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("hotel_contacts")
    .select(HOTEL_CONTACT_COLUMNS.join(", "))
    .eq("hotel_id", hotelId);

  // A failed fetch is NOT "this hotel has no contact" — the caller must be able
  // to tell the difference so an entitled user is never told data is absent.
  if (error) return { access, contacts: [], failed: true };

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

  return { access, contacts, failed: false };
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
    .select("activity_level, confidence_level, has_confirmed_collaboration, recency_band")
    .eq("hotel_id", hotelId)
    .maybeSingle();

  // A failed query is NOT "no creator data" (F2).
  if (error) return { status: "error" };
  if (!data) return { status: "none" };
  const row = data as Record<string, unknown>;
  const signal: HotelIntelligence = {
    activityLevel: (row.activity_level as string | null) ?? null,
    confidenceLevel: (row.confidence_level as string | null) ?? null,
    hasConfirmedCollaboration: (row.has_confirmed_collaboration as boolean | null) ?? null,
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
