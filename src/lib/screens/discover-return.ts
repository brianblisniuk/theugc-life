/**
 * Discover search preserved across Hotel Detail.
 * The back value is parsed again, so a foreign URL cannot become the return path.
 */
import { isUuid } from "@/lib/hotels/ids";
import { buildDiscoverHref, parseDiscoverQuery, type RawSearchParams } from "@/lib/hotels/filters";

export function parseDiscoverTrip(raw: string | string[] | undefined | null): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && isUuid(value) ? value : null;
}

export function withDiscoverTrip(href: string, tripId: string | null): string {
  if (!tripId || !isUuid(tripId)) return href;
  const hashIndex = href.indexOf("#");
  const hash = hashIndex >= 0 ? href.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const split = withoutHash.indexOf("?");
  const path = split >= 0 ? withoutHash.slice(0, split) : withoutHash;
  const params = new URLSearchParams(split >= 0 ? withoutHash.slice(split + 1) : "");
  params.set("trip", tripId);
  const qs = params.toString();
  return `${path}${qs ? `?${qs}` : ""}${hash}`;
}

function paramsFrom(value: string): RawSearchParams {
  const query = value.includes("?") ? value.slice(value.indexOf("?") + 1).split("#")[0] : "";
  const params = new URLSearchParams(query ?? "");
  const raw: RawSearchParams = {};
  params.forEach((item, key) => {
    raw[key] = item;
  });
  return raw;
}

/** Only `/app/discover` plus known filters and a trip id. Anything else is the catalog. */
export function discoverReturnHref(raw: string | string[] | undefined | null): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.length === 0 || value.length > 2000) return "/app/discover";
  if (!value.startsWith("/app/discover")) return "/app/discover";
  if (value.startsWith("/app/discover/")) return "/app/discover";
  const parsed = paramsFrom(value);
  const trip = parseDiscoverTrip(parsed.trip ?? null);
  return withDiscoverTrip(buildDiscoverHref(parseDiscoverQuery(parsed)), trip);
}

export function hotelFromDiscoverHref(hotelId: string, discoverHref: string): string | null {
  if (!isUuid(hotelId)) return null;
  const back = discoverReturnHref(discoverHref);
  if (back === "/app/discover") return `/app/hotels/${hotelId}`;
  const params = new URLSearchParams();
  params.set("back", back);
  return `/app/hotels/${hotelId}?${params.toString()}`;
}
