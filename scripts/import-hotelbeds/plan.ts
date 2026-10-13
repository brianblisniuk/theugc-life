/**
 * Decide what a Hotelbeds page may do to canonical hotels (D106).
 *
 * A match is name similarity at or above the catalog importer's review bar
 * AND a coordinate distance of at most 1 km. A match is exported. It is not
 * merged. The same Hotelbeds code updates the row that already carries it.
 */
import { foldForMatch } from "../../src/lib/import/normalize";
import { diceSimilarity, FUZZY_THRESHOLD } from "../../src/lib/import/resolve";
import { haversineMetres } from "../entity-resolution/normalize";

import {
  needsCategoryReview,
  starFromCategory,
  usableCoordinates,
  type RawHotelbedsHotel,
} from "./parse";

export const NAME_SIMILARITY_MIN = FUZZY_THRESHOLD;
export const MATCH_DISTANCE_METRES = 1000;

export interface CanonicalHotel {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  websiteUrl: string | null;
  starRatingSource: string | null;
  hotelbedsCode: string | null;
}

export interface DestinationHit {
  id: string;
  slug: string;
  countryCode: string | null;
}

export interface EligibleHotel {
  code: string;
  name: string;
  categoryCode: string;
  starRating: 4 | 5;
  latitude: number;
  longitude: number;
  destinationCode: string | null;
  accommodationTypeCode: string;
  websiteUrl: string | null;
  needsCategoryReview: boolean;
}

export interface ReviewMatch {
  hotelbedsCode: string;
  hotelbedsName: string;
  categoryCode: string;
  starRating: 4 | 5;
  destinationCode: string | null;
  accommodationTypeCode: string;
  latitude: number;
  longitude: number;
  website: string | null;
  needsCategoryReview: boolean;
  existingHotelId: string;
  existingHotelName: string;
  existingLatitude: number;
  existingLongitude: number;
  distanceMetres: number;
  nameSimilarity: number;
}

export type SkipReason =
  | "missing_code"
  | "missing_name"
  | "not_hotel_type"
  | "not_v1_category"
  | "unusable_coordinates"
  | "duplicate_code_superseded"
  | "unresolved_destination"
  | "ambiguous_destination";

export interface HotelPatch {
  hotelId: string;
  hotelbedsCode: string;
  /** Null means leave the column alone. */
  name: string | null;
  starRating: 4 | 5 | null;
  setProvenance: boolean;
  latitude: number | null;
  longitude: number | null;
  websiteUrl: string | null;
  needsCategoryReview: boolean | null;
  hotelType: "hotel" | null;
}

export type PlannedHotel =
  | { kind: "skip"; code: string | null; reason: SkipReason }
  | { kind: "review"; eligible: EligibleHotel; matches: ReviewMatch[] }
  | {
      kind: "upsert";
      eligible: EligibleHotel;
      existingHotelId: string;
      matches: ReviewMatch[];
    }
  | { kind: "insert"; eligible: EligibleHotel; destination: DestinationHit };

export interface HotelbedsPlan {
  items: PlannedHotel[];
}

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

/**
 * Owner coordinates win as a pair. Hotelbeds fills them only when both are
 * null. A single stored coordinate is not completed from Hotelbeds, because
 * that would mix two sources into one point.
 */
export function coordinateFill(
  existingLatitude: number | null,
  existingLongitude: number | null,
  incomingLatitude: number,
  incomingLongitude: number,
): { latitude: number; longitude: number } | null {
  if (finiteOrNull(existingLatitude) !== null || finiteOrNull(existingLongitude) !== null) {
    return null;
  }
  return { latitude: incomingLatitude, longitude: incomingLongitude };
}

/** Fill a null website. Never replace one that is already stored. */
export function websiteFill(existing: string | null, incoming: string | null): string | null {
  if (existing !== null && existing.trim() !== "") return null;
  if (incoming === null || incoming.trim() === "") return null;
  return incoming.trim();
}

export function buildPatch(existing: CanonicalHotel, incoming: EligibleHotel): HotelPatch {
  const coords = coordinateFill(
    existing.latitude,
    existing.longitude,
    incoming.latitude,
    incoming.longitude,
  );
  const website = websiteFill(existing.websiteUrl, incoming.websiteUrl);
  const ownedByOwner = existing.starRatingSource === "owner";
  return {
    hotelId: existing.id,
    hotelbedsCode: incoming.code,
    name: ownedByOwner ? null : incoming.name,
    starRating: ownedByOwner ? null : incoming.starRating,
    setProvenance: !ownedByOwner,
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
    websiteUrl: website,
    needsCategoryReview: ownedByOwner ? null : incoming.needsCategoryReview,
    hotelType: ownedByOwner ? null : "hotel",
  };
}

function uniqueDestinations(hits: DestinationHit[]): DestinationHit[] {
  const byId = new Map<string, DestinationHit>();
  for (const hit of hits) byId.set(hit.id, hit);
  return [...byId.values()];
}

function reviewMatch(eligible: EligibleHotel, existing: CanonicalHotel): ReviewMatch | null {
  if (existing.hotelbedsCode === eligible.code) return null;
  const distance = haversineMetres(
    eligible.latitude,
    eligible.longitude,
    finiteOrNull(existing.latitude),
    finiteOrNull(existing.longitude),
  );
  if (distance === null || distance > MATCH_DISTANCE_METRES) return null;
  const left = foldForMatch(eligible.name);
  const right = foldForMatch(existing.name);
  if (left === "" || right === "") return null;
  const similarity = diceSimilarity(left, right);
  if (similarity < NAME_SIMILARITY_MIN) return null;
  return {
    hotelbedsCode: eligible.code,
    hotelbedsName: eligible.name,
    categoryCode: eligible.categoryCode,
    starRating: eligible.starRating,
    destinationCode: eligible.destinationCode,
    accommodationTypeCode: eligible.accommodationTypeCode,
    latitude: eligible.latitude,
    longitude: eligible.longitude,
    website: eligible.websiteUrl,
    needsCategoryReview: eligible.needsCategoryReview,
    existingHotelId: existing.id,
    existingHotelName: existing.name,
    existingLatitude: existing.latitude as number,
    existingLongitude: existing.longitude as number,
    distanceMetres: Math.round(distance),
    nameSimilarity: Number(similarity.toFixed(4)),
  };
}

function eligibility(
  raw: RawHotelbedsHotel,
): { ok: true; eligible: EligibleHotel } | { ok: false; reason: SkipReason } {
  if (!raw.code) return { ok: false, reason: "missing_code" };
  if (!raw.name) return { ok: false, reason: "missing_name" };
  if (raw.accommodationTypeCode?.trim() !== "H") return { ok: false, reason: "not_hotel_type" };
  const starRating = starFromCategory(raw.categoryCode);
  if (starRating === null || !raw.categoryCode) return { ok: false, reason: "not_v1_category" };
  if (!usableCoordinates(raw.latitude, raw.longitude)) {
    return { ok: false, reason: "unusable_coordinates" };
  }
  return {
    ok: true,
    eligible: {
      code: raw.code,
      name: raw.name,
      categoryCode: raw.categoryCode,
      starRating,
      latitude: raw.latitude as number,
      longitude: raw.longitude as number,
      destinationCode: raw.destinationCode,
      accommodationTypeCode: "H",
      websiteUrl: raw.web,
      needsCategoryReview: needsCategoryReview(raw.name, raw.accommodationTypeCode),
    },
  };
}

export function planHotelbedsImport(
  raws: RawHotelbedsHotel[],
  existing: CanonicalHotel[],
  destinations: Map<string, DestinationHit[]>,
): HotelbedsPlan {
  const items: PlannedHotel[] = [];
  const byCode = new Map<string, RawHotelbedsHotel>();
  for (const raw of raws) {
    if (!raw.code) {
      items.push({ kind: "skip", code: null, reason: "missing_code" });
      continue;
    }
    if (byCode.has(raw.code)) {
      items.push({ kind: "skip", code: raw.code, reason: "duplicate_code_superseded" });
    }
    byCode.set(raw.code, raw);
  }

  const ownedByCode = new Map<string, CanonicalHotel>();
  for (const hotel of existing) {
    if (hotel.hotelbedsCode) ownedByCode.set(hotel.hotelbedsCode, hotel);
  }

  for (const raw of byCode.values()) {
    const gate = eligibility(raw);
    if (!gate.ok) {
      items.push({ kind: "skip", code: raw.code, reason: gate.reason });
      continue;
    }
    const eligible = gate.eligible;
    const matches = existing
      .map((hotel) => reviewMatch(eligible, hotel))
      .filter((match): match is ReviewMatch => match !== null);
    const owned = ownedByCode.get(eligible.code);
    if (owned) {
      items.push({ kind: "upsert", eligible, existingHotelId: owned.id, matches });
      continue;
    }
    if (matches.length > 0) {
      items.push({ kind: "review", eligible, matches });
      continue;
    }
    const key = eligible.destinationCode ? foldForMatch(eligible.destinationCode) : "";
    const hits = uniqueDestinations(key === "" ? [] : (destinations.get(key) ?? []));
    if (hits.length === 0) {
      items.push({ kind: "skip", code: eligible.code, reason: "unresolved_destination" });
      continue;
    }
    if (hits.length > 1) {
      items.push({ kind: "skip", code: eligible.code, reason: "ambiguous_destination" });
      continue;
    }
    items.push({ kind: "insert", eligible, destination: hits[0]! });
  }

  return { items };
}

export function reviewMatches(plan: HotelbedsPlan): ReviewMatch[] {
  const matches: ReviewMatch[] = [];
  for (const item of plan.items) {
    if (item.kind === "review" || item.kind === "upsert") matches.push(...item.matches);
  }
  return matches;
}
