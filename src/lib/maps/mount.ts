/**
 * Mount a Google map for published hotel pins (D079).
 *
 * The loader receives the API key and returns a maps namespace. It does not
 * receive pins. Pins become marker positions after the script is loaded, and
 * a marker is only `{ map, position }`. A missing key, an empty pin list, a
 * refused URL, or a failed load all resolve to hidden: no map and no error.
 */
import { isUuid } from "@/lib/hotels/ids";

import {
  GOOGLE_MAPS_CALLBACK,
  SINGLE_HOTEL_ZOOM,
  googleMapsScriptUrl,
  isGoogleMapsScriptUrl,
  normalizeGoogleMapsApiKey,
} from "./google";
import type { PublicMapPin } from "./pins";

export interface MapPosition {
  lat: number;
  lng: number;
}

export interface GoogleMarkerHandle {
  setMap(map: null): void;
  addListener(event: "click", handler: () => void): void;
}

export interface GoogleMapHandle {
  fitBounds(bounds: GoogleBoundsHandle): void;
  setCenter(position: MapPosition): void;
  setZoom(zoom: number): void;
}

export interface GoogleBoundsHandle {
  extend(position: MapPosition): void;
}

export interface GoogleMapOptions {
  center: MapPosition;
  zoom: number;
  clickableIcons: false;
}

export interface GoogleMarkerOptions {
  map: GoogleMapHandle;
  position: MapPosition;
}

export interface GoogleMapsNamespace {
  Map: new (element: HTMLElement, options: GoogleMapOptions) => GoogleMapHandle;
  Marker: new (options: GoogleMarkerOptions) => GoogleMarkerHandle;
  LatLngBounds: new () => GoogleBoundsHandle;
}

export type GoogleMapsLoader = (apiKey: string) => Promise<GoogleMapsNamespace>;

let inflight: Promise<GoogleMapsNamespace> | null = null;

/** Tests reset the shared script promise so cases do not share a load. */
export function resetGoogleMapsLoadForTests(): void {
  inflight = null;
}

function unavailable(): Error {
  return new Error("google_maps_unavailable");
}

/**
 * Insert the Maps JavaScript API script. The URL is checked again here so a
 * caller cannot point this at another host. The referrer is the origin only:
 * the page path and query are not part of the script request.
 */
export function insertGoogleMapsScript(url: string): Promise<GoogleMapsNamespace> {
  if (!isGoogleMapsScriptUrl(url)) return Promise.reject(unavailable());
  if (typeof document === "undefined") return Promise.reject(unavailable());

  return new Promise((resolve, reject) => {
    const win = window as Window & {
      ugcMapsInit?: () => void;
      google?: { maps?: GoogleMapsNamespace };
    };
    const finish = () => {
      const maps = win.google?.maps;
      if (!maps?.Map || !maps.Marker || !maps.LatLngBounds) {
        reject(unavailable());
        return;
      }
      resolve(maps);
    };
    win[GOOGLE_MAPS_CALLBACK] = finish;

    const existing = document.querySelector<HTMLScriptElement>("script[data-ugc-maps='1']");
    if (existing) {
      if (win.google?.maps?.Map) finish();
      else existing.addEventListener("error", () => reject(unavailable()), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.async = true;
    script.dataset.ugcMaps = "1";
    script.referrerPolicy = "strict-origin-when-cross-origin";
    script.src = url;
    script.onerror = () => reject(unavailable());
    document.head.appendChild(script);
  });
}

export function loadGoogleMapsNamespace(
  apiKey: string,
  insert: (url: string) => Promise<GoogleMapsNamespace> = insertGoogleMapsScript,
): Promise<GoogleMapsNamespace> {
  const url = googleMapsScriptUrl(apiKey);
  if (!url || !isGoogleMapsScriptUrl(url)) return Promise.reject(unavailable());
  if (!inflight) {
    inflight = insert(url).catch((error: unknown) => {
      inflight = null;
      throw error;
    });
  }
  return inflight;
}

function positionOf(pin: PublicMapPin): MapPosition | null {
  if (!Number.isFinite(pin.latitude) || !Number.isFinite(pin.longitude)) return null;
  return { lat: pin.latitude, lng: pin.longitude };
}

function defaultSelect(hotelId: string): void {
  if (typeof window === "undefined") return;
  window.location.assign(`/app/hotels/${hotelId}`);
}

export async function mountHotelMap(args: {
  apiKey: string | null;
  pins: readonly PublicMapPin[];
  container: HTMLElement;
  load?: GoogleMapsLoader;
  onSelect?: (hotelId: string) => void;
}): Promise<{ status: "hidden" } | { status: "shown"; destroy: () => void }> {
  const apiKey = normalizeGoogleMapsApiKey(args.apiKey);
  const located = args.pins.flatMap((pin) => {
    const position = positionOf(pin);
    return position ? [{ pin, position }] : [];
  });
  if (!apiKey || located.length === 0) return { status: "hidden" };

  let maps: GoogleMapsNamespace;
  try {
    const load = args.load ?? ((key: string) => loadGoogleMapsNamespace(key));
    maps = await load(apiKey);
  } catch {
    return { status: "hidden" };
  }
  if (!maps?.Map || !maps.Marker || !maps.LatLngBounds) return { status: "hidden" };

  const first = located[0]!.position;
  const map = new maps.Map(args.container, {
    center: first,
    zoom: located.length === 1 ? SINGLE_HOTEL_ZOOM : 2,
    clickableIcons: false,
  });
  const bounds = new maps.LatLngBounds();
  const markers: GoogleMarkerHandle[] = [];
  const select = args.onSelect ?? defaultSelect;
  for (const { pin, position } of located) {
    bounds.extend(position);
    const marker = new maps.Marker({ map, position });
    if (isUuid(pin.id)) marker.addListener("click", () => select(pin.id));
    markers.push(marker);
  }
  if (located.length === 1) {
    map.setCenter(first);
    map.setZoom(SINGLE_HOTEL_ZOOM);
  } else {
    map.fitBounds(bounds);
  }

  return {
    status: "shown",
    destroy: () => {
      for (const marker of markers) marker.setMap(null);
    },
  };
}
