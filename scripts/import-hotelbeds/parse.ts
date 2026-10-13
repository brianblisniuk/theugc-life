/**
 * Read Hotelbeds Content API /hotels JSON pages from a directory.
 *
 * No network. No credentials. Only the fields D106 names are copied out of
 * each hotel object; the rest of the payload is not retained.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { HOTELBEDS_CLASSIFICATION_POLICY } from "../provider-classification/hotelbeds";
import { classifyProviderCode } from "../provider-classification/policy";

export interface RawHotelbedsHotel {
  code: string | null;
  name: string | null;
  categoryCode: string | null;
  latitude: number | null;
  longitude: number | null;
  destinationCode: string | null;
  accommodationTypeCode: string | null;
  web: string | null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Exact D066 lookup. Unknown codes, half-stars, and key codes are not stars. */
export function starFromCategory(categoryCode: string | null): 4 | 5 | null {
  const outcome = classifyProviderCode(HOTELBEDS_CLASSIFICATION_POLICY, categoryCode);
  if (outcome === "exact_four") return 4;
  if (outcome === "exact_five") return 5;
  return null;
}

/**
 * Usable coordinates for a new visible row.
 *
 * Out of range is unusable. (0, 0) is the null-island sentinel the Hotelbeds
 * evaluation already refuses, not a property position.
 */
export function usableCoordinates(latitude: number | null, longitude: number | null): boolean {
  if (latitude === null || longitude === null) return false;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return false;
  if (latitude === 0 && longitude === 0) return false;
  return true;
}

const CATEGORY_OUTLIER = /\b(apartments?|aparthotels?|residences?|villas?)\b/i;

/** Aparthotel in the reviewed Hotelbeds accommodation-type table. */
const OUTLIER_TYPE_CODES = new Set(["P"]);

/**
 * Cheap outlier flag (D106). True when the name or the accommodation type
 * suggests an apartment, a residence, or a villa complex. A hit does not
 * block publication.
 */
export function needsCategoryReview(name: string, accommodationTypeCode: string | null): boolean {
  const type = accommodationTypeCode?.trim() ?? "";
  if (type !== "" && OUTLIER_TYPE_CODES.has(type.toUpperCase())) return true;
  if (CATEGORY_OUTLIER.test(name)) return true;
  if (type !== "" && CATEGORY_OUTLIER.test(type)) return true;
  return false;
}

export function parseHotel(raw: unknown): RawHotelbedsHotel {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const nameRecord =
    record.name && typeof record.name === "object" ? (record.name as Record<string, unknown>) : {};
  const coordinates =
    record.coordinates && typeof record.coordinates === "object"
      ? (record.coordinates as Record<string, unknown>)
      : {};
  const categoryCode = typeof record.categoryCode === "string" ? record.categoryCode : null;
  return {
    code: asString(record.code),
    name: asString(nameRecord.content),
    categoryCode,
    latitude: asNumber(coordinates.latitude),
    longitude: asNumber(coordinates.longitude),
    destinationCode: asString(record.destinationCode),
    accommodationTypeCode: asString(record.accommodationTypeCode),
    web: asString(record.web),
  };
}

export function parseHotelsPayload(payload: unknown, fileName: string): RawHotelbedsHotel[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${fileName} must be a JSON object with a hotels array`);
  }
  const hotels = (payload as { hotels?: unknown }).hotels;
  if (!Array.isArray(hotels)) {
    throw new Error(`${fileName} is missing a hotels array`);
  }
  return hotels.map((hotel) => parseHotel(hotel));
}

/** Non-recursive. Only `*.json` files in the directory, in filename order. */
export async function readHotelbedsPages(dir: string): Promise<RawHotelbedsHotel[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const hotels: RawHotelbedsHotel[] = [];
  for (const name of files) {
    const text = await readFile(path.join(dir, name), "utf8");
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Invalid JSON in ${name}`);
    }
    hotels.push(...parseHotelsPayload(payload, name));
  }
  return hotels;
}
