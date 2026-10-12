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

/**
 * Set once a script load has failed. Client navigation keeps this module
 * alive, and a script's error event does not fire again. The next mount
 * rejects from this flag instead of waiting on that event.
 */
let loadFailed = false;

/** Tests reset the shared script promise so cases do not share a load. */
export function resetGoogleMapsLoadForTests(): void {
  inflight = null;
  loadFailed = false;
}

function unavailable(): Error {
  return new Error("google_maps_unavailable");
}

const MAPS_SCRIPT_SELECTOR = "script[data-ugc-maps='1']";

function mapsNamespace(
  win: Window & { google?: { maps?: GoogleMapsNamespace } },
): GoogleMapsNamespace | null {
  const maps = win.google?.maps;
  if (!maps?.Map || !maps.Marker || !maps.LatLngBounds) return null;
  return maps;
}

/**
 * Drop a script that has already failed. Leaving it in the document makes the
 * next insert wait for an error event that will not fire again.
 */
function retireFailedScript(script: HTMLScriptElement | null): void {
  loadFailed = true;
  if (!script) return;
  script.dataset.ugcMapsState = "failed";
  script.remove();
}

/**
 * Insert the Maps JavaScript API script. The URL is checked again here so a
 * caller cannot point this at another host. The referrer is the origin only:
 * the page path and query are not part of the script request.
 *
 * A tag that has already failed is removed and rejected. Waiting on its
 * error event would never settle, and the map frame would stay up.
 */
export function insertGoogleMapsScript(url: string): Promise<GoogleMapsNamespace> {
  if (!isGoogleMapsScriptUrl(url)) return Promise.reject(unavailable());
  if (typeof document === "undefined") return Promise.reject(unavailable());
  if (loadFailed) return Promise.reject(unavailable());

  return new Promise((resolve, reject) => {
    const win = window as Window & {
      ugcMapsInit?: () => void;
      google?: { maps?: GoogleMapsNamespace };
    };
    const fail = (script: HTMLScriptElement | null) => {
      retireFailedScript(script);
      reject(unavailable());
    };
    const finish = (script: HTMLScriptElement | null) => {
      const maps = mapsNamespace(win);
      if (!maps) {
        fail(script);
        return;
      }
      if (script) script.dataset.ugcMapsState = "ready";
      resolve(maps);
    };

    const existing = document.querySelector<HTMLScriptElement>(MAPS_SCRIPT_SELECTOR);
    if (existing) {
      if (existing.dataset.ugcMapsState === "failed" || loadFailed) {
        fail(existing);
        return;
      }
      if (mapsNamespace(win)) {
        finish(existing);
        return;
      }
      // "loading" is the only state that can still settle later. Any other
      // tag has already missed its error event.
      if (existing.dataset.ugcMapsState !== "loading") {
        fail(existing);
        return;
      }
      const previous = win[GOOGLE_MAPS_CALLBACK];
      win[GOOGLE_MAPS_CALLBACK] = () => {
        previous?.();
        finish(existing);
      };
      existing.addEventListener("error", () => fail(existing), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.async = true;
    script.dataset.ugcMaps = "1";
    script.dataset.ugcMapsState = "loading";
    script.referrerPolicy = "strict-origin-when-cross-origin";
    script.src = url;
    script.onerror = () => fail(script);
    win[GOOGLE_MAPS_CALLBACK] = () => finish(script);
    document.head.appendChild(script);
  });
}

export function loadGoogleMapsNamespace(
  apiKey: string,
  insert: (url: string) => Promise<GoogleMapsNamespace> = insertGoogleMapsScript,
): Promise<GoogleMapsNamespace> {
  if (loadFailed) return Promise.reject(unavailable());
  const url = googleMapsScriptUrl(apiKey);
  if (!url || !isGoogleMapsScriptUrl(url)) return Promise.reject(unavailable());
  if (!inflight) {
    inflight = insert(url).catch((error: unknown) => {
      loadFailed = true;
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
