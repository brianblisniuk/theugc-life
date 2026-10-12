/**
 * Google Maps JavaScript API boundary (D079).
 *
 * The browser request is the script URL. It carries the public key and nothing
 * else: no hotel, no creator, no filter, no path. Marker positions are applied
 * later, in the page, and are the only hotel data the map receives.
 */

export const GOOGLE_MAPS_SCRIPT_ORIGIN = "https://maps.googleapis.com";
export const GOOGLE_MAPS_SCRIPT_PATH = "/maps/api/js";
export const GOOGLE_MAPS_CALLBACK = "ugcMapsInit";
export const GOOGLE_MAPS_VERSION = "weekly";

/** Zoom for one hotel. A multi-hotel map fits bounds instead. */
export const SINGLE_HOTEL_ZOOM = 14;

const SCRIPT_PARAMS = ["callback", "key", "v"] as const;

export function googleMapsApiKey(): string | null {
  return normalizeGoogleMapsApiKey(process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY);
}

export function normalizeGoogleMapsApiKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  return key.length > 0 ? key : null;
}

/**
 * True when there is a key and at least one published pin. Missing key and
 * empty results are the same outcome: no map.
 */
export function shouldMountMap(apiKey: string | null, pinCount: number): boolean {
  return normalizeGoogleMapsApiKey(apiKey) !== null && pinCount > 0;
}

/**
 * Script URL for the Maps JavaScript API. Null when the key is blank.
 * The key is a single query value, so characters in it cannot add parameters.
 */
export function googleMapsScriptUrl(apiKey: string): string | null {
  const key = normalizeGoogleMapsApiKey(apiKey);
  if (!key) return null;
  const url = new URL(GOOGLE_MAPS_SCRIPT_PATH, GOOGLE_MAPS_SCRIPT_ORIGIN);
  url.searchParams.set("key", key);
  url.searchParams.set("v", GOOGLE_MAPS_VERSION);
  url.searchParams.set("callback", GOOGLE_MAPS_CALLBACK);
  return url.toString();
}

/** The only script this block will insert. Anything else is refused. */
export function isGoogleMapsScriptUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin !== GOOGLE_MAPS_SCRIPT_ORIGIN) return false;
  if (url.pathname !== GOOGLE_MAPS_SCRIPT_PATH) return false;
  if (url.username || url.password || url.hash) return false;
  const names = [...url.searchParams.keys()];
  if (names.length !== SCRIPT_PARAMS.length) return false;
  for (const name of names) {
    if (!SCRIPT_PARAMS.includes(name as (typeof SCRIPT_PARAMS)[number])) return false;
  }
  if (url.searchParams.get("v") !== GOOGLE_MAPS_VERSION) return false;
  if (url.searchParams.get("callback") !== GOOGLE_MAPS_CALLBACK) return false;
  return normalizeGoogleMapsApiKey(url.searchParams.get("key")) !== null;
}
