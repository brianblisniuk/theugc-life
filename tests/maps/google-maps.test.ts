/**
 * Google Maps boundary (D079).
 *
 * These tests run with no API key and no browser. The loader is injected.
 * A missing key must not call it. A marker receives a position and nothing else.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseDiscoverQuery } from "@/lib/hotels/filters";
import { getHotelById, searchHotels, type HotelQueryClient } from "@/lib/hotels/queries";
import {
  googleMapsApiKey,
  googleMapsScriptUrl,
  isGoogleMapsScriptUrl,
  shouldMountMap,
} from "@/lib/maps/google";
import {
  loadGoogleMapsNamespace,
  mountHotelMap,
  resetGoogleMapsLoadForTests,
  type GoogleMapsNamespace,
  type GoogleMarkerOptions,
  type GoogleMapOptions,
} from "@/lib/maps/mount";
import { PUBLIC_MAP_PIN_FIELDS, publicMapPin, type PublicMapPin } from "@/lib/maps/pins";

const PIN: PublicMapPin = {
  id: "4a000000-0000-0000-0000-0000000000aa",
  name: "Kept Hotel",
  latitude: 25.2,
  longitude: 55.27,
};

const OTHER: PublicMapPin = {
  id: "4a000000-0000-0000-0000-0000000000bb",
  name: "Second Hotel",
  latitude: 25.1,
  longitude: 55.2,
};

const PRIVATE = {
  email: "creator@example.com",
  phone: "+971500000000",
  linkedin_url: "https://linkedin.example/in/secret",
  reply_rate: 0.42,
  pipeline_status: "pitched",
  trip_id: "trip-private",
  creator_id: "creator-private",
  user_id: "user-private",
};

function fakeMaps() {
  const maps: GoogleMapOptions[] = [];
  const markers: GoogleMarkerOptions[] = [];
  const calls: string[] = [];
  const listeners: Array<{ id: string; fire: () => void }> = [];
  const api: GoogleMapsNamespace = {
    Map: class {
      constructor(_el: HTMLElement, options: GoogleMapOptions) {
        maps.push(options);
      }
      fitBounds() {
        calls.push("fitBounds");
      }
      setCenter(position: { lat: number; lng: number }) {
        calls.push(`setCenter:${position.lat},${position.lng}`);
      }
      setZoom(zoom: number) {
        calls.push(`setZoom:${zoom}`);
      }
    } as unknown as GoogleMapsNamespace["Map"],
    Marker: class {
      constructor(options: GoogleMarkerOptions) {
        markers.push(options);
      }
      setMap() {
        calls.push("setMap:null");
      }
      addListener(_event: "click", handler: () => void) {
        listeners.push({ id: "pending", fire: handler });
      }
    } as unknown as GoogleMapsNamespace["Marker"],
    LatLngBounds: class {
      extend() {}
    } as unknown as GoogleMapsNamespace["LatLngBounds"],
  };
  return { api, maps, markers, calls, listeners };
}

describe("Google Maps key and script URL", () => {
  const previous = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

  beforeEach(() => {
    resetGoogleMapsLoadForTests();
  });

  it("treats a missing or blank key as no map and does not build a URL", () => {
    delete process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    expect(googleMapsApiKey()).toBeNull();
    expect(shouldMountMap(null, 1)).toBe(false);
    expect(shouldMountMap("  ", 1)).toBe(false);
    expect(shouldMountMap("public-key", 0)).toBe(false);
    expect(googleMapsScriptUrl("  ")).toBeNull();

    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY = "";
    expect(googleMapsApiKey()).toBeNull();
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY = "  public-key  ";
    expect(googleMapsApiKey()).toBe("public-key");

    if (previous === undefined) delete process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    else process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY = previous;
  });

  it("puts only key, version, and callback on the Maps JavaScript URL", () => {
    const url = googleMapsScriptUrl("public-key&email=creator@example.com");
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.origin).toBe("https://maps.googleapis.com");
    expect(parsed.pathname).toBe("/maps/api/js");
    expect([...parsed.searchParams.keys()].sort()).toEqual(["callback", "key", "v"]);
    expect(parsed.searchParams.get("key")).toBe("public-key&email=creator@example.com");
    expect(parsed.searchParams.get("email")).toBeNull();
    expect(parsed.searchParams.get("callback")).toBe("ugcMapsInit");
    expect(parsed.searchParams.get("v")).toBe("weekly");
    expect(isGoogleMapsScriptUrl(url!)).toBe(true);
    expect(url).not.toContain("libraries");
    expect(url).not.toContain("creator@example.com");
  });

  it("refuses a script URL that is not the Maps JavaScript API", () => {
    expect(
      isGoogleMapsScriptUrl("https://evil.example/maps/api/js?key=k&v=weekly&callback=ugcMapsInit"),
    ).toBe(false);
    expect(
      isGoogleMapsScriptUrl(
        "https://maps.googleapis.com/maps/api/js?key=k&v=weekly&callback=ugcMapsInit&libraries=places",
      ),
    ).toBe(false);
    expect(isGoogleMapsScriptUrl("https://maps.googleapis.com/maps/api/staticmap?key=k")).toBe(
      false,
    );
  });
});

describe("mountHotelMap", () => {
  beforeEach(() => {
    resetGoogleMapsLoadForTests();
  });

  it("does not call the loader when the key is missing or there are no pins", async () => {
    const load = vi.fn();
    const container = {} as HTMLElement;
    expect((await mountHotelMap({ apiKey: null, pins: [PIN], container, load })).status).toBe(
      "hidden",
    );
    expect((await mountHotelMap({ apiKey: "  ", pins: [PIN], container, load })).status).toBe(
      "hidden",
    );
    expect((await mountHotelMap({ apiKey: "public-key", pins: [], container, load })).status).toBe(
      "hidden",
    );
    expect(load).not.toHaveBeenCalled();
  });

  it("hides the map when the loader fails, without throwing", async () => {
    const load = vi.fn(async () => {
      throw new Error("network blocked");
    });
    const result = await mountHotelMap({
      apiKey: "public-key",
      pins: [PIN],
      container: {} as HTMLElement,
      load,
    });
    expect(result.status).toBe("hidden");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("hides the map when the real loader has no document and no key in the environment", async () => {
    delete process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    const result = await mountHotelMap({
      apiKey: "public-key",
      pins: [PIN],
      container: {} as HTMLElement,
    });
    expect(result.status).toBe("hidden");
  });

  it("passes the key only to the loader and a position only to the marker", async () => {
    const fake = fakeMaps();
    const load = vi.fn(async (apiKey: string) => {
      expect(apiKey).toBe("public-key");
      return fake.api;
    });
    const selected: string[] = [];
    const result = await mountHotelMap({
      apiKey: "public-key",
      pins: [{ ...PIN, ...PRIVATE } as PublicMapPin],
      container: {} as HTMLElement,
      load,
      onSelect: (id) => selected.push(id),
    });
    expect(result.status).toBe("shown");
    expect(load.mock.calls).toEqual([["public-key"]]);

    expect(fake.maps).toHaveLength(1);
    expect(Object.keys(fake.maps[0]!).sort()).toEqual(["center", "clickableIcons", "zoom"]);
    expect(fake.maps[0]!.clickableIcons).toBe(false);
    expect(fake.maps[0]!.center).toEqual({ lat: 25.2, lng: 55.27 });

    expect(fake.markers).toHaveLength(1);
    const marker = fake.markers[0]!;
    expect(Object.keys(marker).sort()).toEqual(["map", "position"]);
    expect(marker.position).toEqual({ lat: 25.2, lng: 55.27 });

    const wire = JSON.stringify({
      load: load.mock.calls,
      map: fake.maps,
      markers: fake.markers,
    });
    for (const secret of Object.values(PRIVATE)) {
      expect(wire).not.toContain(String(secret));
    }
    expect(wire).not.toContain("Kept Hotel");
    expect(wire).not.toContain(PIN.id);

    fake.listeners[0]!.fire();
    expect(selected).toEqual([PIN.id]);
    if (result.status === "shown") result.destroy();
    expect(fake.calls).toContain("setMap:null");
    expect(fake.calls).toContain("setCenter:25.2,55.27");
    expect(fake.calls).toContain("setZoom:14");
    expect(fake.calls).not.toContain("fitBounds");
  });

  it("fits bounds for the current page and does not navigate for a non-uuid", async () => {
    const fake = fakeMaps();
    const load = vi.fn(async () => fake.api);
    const selected: string[] = [];
    const result = await mountHotelMap({
      apiKey: "public-key",
      pins: [PIN, { ...OTHER, id: "not-a-uuid" }],
      container: {} as HTMLElement,
      load,
      onSelect: (id) => selected.push(id),
    });
    expect(result.status).toBe("shown");
    expect(fake.markers).toHaveLength(2);
    expect(fake.calls).toContain("fitBounds");
    expect(fake.calls.some((call) => call.startsWith("setZoom:"))).toBe(false);
    expect(fake.listeners).toHaveLength(1);
    fake.listeners[0]!.fire();
    expect(selected).toEqual([PIN.id]);
  });

  it("does not insert a script for a blank key, and inserts only an allowed URL otherwise", async () => {
    const inserted: string[] = [];
    const insert = vi.fn(async (url: string) => {
      inserted.push(url);
      return fakeMaps().api;
    });
    await expect(loadGoogleMapsNamespace("  ", insert)).rejects.toThrow("google_maps_unavailable");
    expect(insert).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
    resetGoogleMapsLoadForTests();
    await loadGoogleMapsNamespace("public-key", insert);
    expect(inserted).toHaveLength(1);
    const url = inserted[0]!;
    expect(isGoogleMapsScriptUrl(url)).toBe(true);
    expect(url).not.toContain("Kept Hotel");
    expect(url).not.toContain("creator@example.com");
  });
});

/**
 * Real `insertGoogleMapsScript` against a fake document. The injected `load`
 * argument is not used. A hung promise fails the test instead of waiting
 * for the file timeout.
 */
function settle<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("map load hung")), 100);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function installScriptDom(behavior: "error" | "success" | "idle", api: GoogleMapsNamespace) {
  const scripts: FakeScript[] = [];
  let appends = 0;
  const win = {} as Window & {
    ugcMapsInit?: () => void;
    google?: { maps?: GoogleMapsNamespace };
  };

  class FakeScript {
    async = false;
    dataset: Record<string, string> = {};
    referrerPolicy = "";
    src = "";
    onerror: (() => void) | null = null;
    listenerCount = 0;
    addEventListener(event: string, handler: () => void) {
      this.listenerCount += 1;
      if (event !== "error") handler();
    }
    remove() {
      const index = scripts.indexOf(this);
      if (index >= 0) scripts.splice(index, 1);
    }
  }

  const documentFake = {
    createElement(tag: string) {
      if (tag !== "script") throw new Error(tag);
      return new FakeScript();
    },
    head: {
      appendChild(script: FakeScript) {
        appends += 1;
        scripts.push(script);
        if (behavior === "error") script.onerror?.();
        if (behavior === "success") {
          win.google = { maps: api };
          win.ugcMapsInit?.();
        }
      },
    },
    querySelector(selector: string) {
      if (selector !== "script[data-ugc-maps='1']") return null;
      return scripts.find((script) => script.dataset.ugcMaps === "1") ?? null;
    },
  };

  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: documentFake,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: win,
  });

  return {
    get appends() {
      return appends;
    },
    get scripts() {
      return scripts;
    },
    plant(dataset: Record<string, string>) {
      const script = new FakeScript();
      Object.assign(script.dataset, dataset);
      scripts.push(script);
      return script;
    },
    restore() {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        writable: true,
        value: previousDocument,
      });
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        writable: true,
        value: previousWindow,
      });
    },
  };
}

describe("insertGoogleMapsScript remounts", () => {
  const container = {} as HTMLElement;

  beforeEach(() => {
    resetGoogleMapsLoadForTests();
  });

  it("settles a later mount to hidden after the script has already failed", async () => {
    const dom = installScriptDom("error", fakeMaps().api);
    try {
      const first = await settle(mountHotelMap({ apiKey: "public-key", pins: [PIN], container }));
      expect(first.status).toBe("hidden");
      expect(dom.scripts).toHaveLength(0);
      const second = await settle(mountHotelMap({ apiKey: "public-key", pins: [PIN], container }));
      expect(second.status).toBe("hidden");
      expect(dom.appends).toBe(1);
    } finally {
      dom.restore();
    }
  });

  it("rejects a leftover failed script tag instead of waiting for its error", async () => {
    const dom = installScriptDom("idle", fakeMaps().api);
    try {
      const planted = dom.plant({ ugcMaps: "1" });
      const result = await settle(mountHotelMap({ apiKey: "public-key", pins: [PIN], container }));
      expect(result.status).toBe("hidden");
      expect(planted.listenerCount).toBe(0);
      expect(dom.appends).toBe(0);
    } finally {
      dom.restore();
    }
  });

  it("remounts a successful script without inserting another one", async () => {
    const dom = installScriptDom("success", fakeMaps().api);
    try {
      const first = await settle(mountHotelMap({ apiKey: "public-key", pins: [PIN], container }));
      expect(first.status).toBe("shown");
      const second = await settle(mountHotelMap({ apiKey: "public-key", pins: [PIN], container }));
      expect(second.status).toBe("shown");
      expect(dom.appends).toBe(1);
      expect(dom.scripts).toHaveLength(1);
      expect(dom.scripts[0]?.dataset.ugcMapsState).toBe("ready");

      resetGoogleMapsLoadForTests();
      const third = await settle(mountHotelMap({ apiKey: "public-key", pins: [PIN], container }));
      expect(third.status).toBe("shown");
      expect(dom.appends).toBe(1);
    } finally {
      dom.restore();
    }
  });
});

describe("published map pins", () => {
  const published = {
    id: PIN.id,
    name: "Kept Hotel",
    slug: "kept-hotel",
    hotel_type: "hotel",
    star_rating: 5,
    country_code: "AE",
    website_url: null,
    instagram_url: null,
    address: "1 Public Street",
    active_status: "unknown",
    editorial_verification_status: "unverified",
    editorial_verified_at: null,
    destination_id: "d1",
    latitude: 25.2,
    longitude: 55.27,
    destination: { id: "d1", name: "Dubai", slug: "dubai", country_code: "AE" },
    ...PRIVATE,
  };

  function client(rows: unknown[], calls: { table: string; method: string; args: unknown[] }[]) {
    return {
      from(table: string) {
        const chain: Record<string, unknown> = {};
        const record =
          (method: string) =>
          (...args: unknown[]) => {
            calls.push({ table, method, args });
            return chain;
          };
        for (const method of ["select", "or", "eq", "gte", "lte", "neq", "in", "order"]) {
          chain[method] = record(method);
        }
        chain.limit = (...args: unknown[]) => {
          calls.push({ table, method: "limit", args });
          return Promise.resolve({ data: rows, error: null, count: rows.length });
        };
        chain.range = (...args: unknown[]) => {
          calls.push({ table, method: "range", args });
          return Promise.resolve({ data: rows, error: null, count: rows.length });
        };
        chain.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null });
        return chain;
      },
    } as unknown as HotelQueryClient;
  }

  it("copies only the public pin fields, even if the row carries private data", () => {
    const pin = publicMapPin({
      ...PIN,
      ...PRIVATE,
    } as PublicMapPin);
    expect(Object.keys(pin).sort()).toEqual([...PUBLIC_MAP_PIN_FIELDS].sort());
    expect(JSON.stringify(pin)).not.toContain("creator@example.com");
    expect(JSON.stringify(pin)).not.toContain("pipeline");
  });

  it("pins the filtered published page and does not read premium or private tables", async () => {
    const calls: { table: string; method: string; args: unknown[] }[] = [];
    const closed = { ...published, id: OTHER.id, name: "Closed Hotel", active_status: "closed" };
    const result = await searchHotels(
      parseDiscoverQuery({ country: "AE", type: "hotel", stars: "5", activity: "high" }),
      client([], calls),
    );
    const tables = new Set(calls.map((call) => call.table));
    expect(tables.has("hotel_public_intelligence")).toBe(true);
    expect(tables.has("hotel_contacts")).toBe(false);
    expect(tables.has("hotel_premium_intelligence")).toBe(false);
    expect(tables.has("pipeline_items")).toBe(false);
    expect(tables.has("trip_hotels")).toBe(false);
    expect([...tables].some((table) => table.includes("gmail") || table.includes("mail_"))).toBe(
      false,
    );

    // The activity filter matches nothing in this stub, so the search stops
    // before hotels. The country filter is still the same Discover query.
    expect(result.pins).toEqual([]);
    expect(result.hotels).toEqual([]);

    const openCalls: { table: string; method: string; args: unknown[] }[] = [];
    const open = await searchHotels(
      parseDiscoverQuery({ country: "AE", type: "hotel", stars: "5" }),
      client([published, closed], openCalls),
    );
    expect(open.hotels.map((hotel) => hotel.name)).toEqual(["Kept Hotel"]);
    expect(open.hotels[0]).not.toHaveProperty("latitude");
    expect(open.hotels[0]).not.toHaveProperty("email");
    expect(open.pins).toEqual([
      { id: PIN.id, name: "Kept Hotel", latitude: 25.2, longitude: 55.27 },
    ]);
    expect(JSON.stringify(open.pins)).not.toContain("creator@example.com");
    expect(JSON.stringify(open.pins)).not.toContain("1 Public Street");
    expect(JSON.stringify(open.pins)).not.toContain("pitched");
    const hotelCalls = openCalls.filter((call) => call.table === "hotels");
    expect(hotelCalls).toContainEqual({
      table: "hotels",
      method: "eq",
      args: ["country_code", "AE"],
    });
    expect(hotelCalls).toContainEqual({
      table: "hotels",
      method: "eq",
      args: ["hotel_type", "hotel"],
    });
    expect(JSON.stringify(hotelCalls)).not.toContain("reply_rate");
    expect(JSON.stringify(hotelCalls)).not.toContain("email");
  });

  it("returns one pin for a published hotel and none for a closed or malformed id", async () => {
    const calls: { table: string; method: string; args: unknown[] }[] = [];
    const view = await getHotelById(PIN.id, client([published], calls));
    expect(view?.hotel.name).toBe("Kept Hotel");
    expect(view?.hotel).not.toHaveProperty("latitude");
    expect(view?.mapPin).toEqual({
      id: PIN.id,
      name: "Kept Hotel",
      latitude: 25.2,
      longitude: 55.27,
    });
    expect(JSON.stringify(view)).not.toContain("creator@example.com");
    expect(calls.filter((call) => call.table === "hotels")).toContainEqual({
      table: "hotels",
      method: "gte",
      args: ["latitude", -90],
    });
    expect(JSON.stringify(calls)).not.toContain("email");
    expect(JSON.stringify(calls)).not.toContain("reply_rate");

    const closed = await getHotelById(
      OTHER.id,
      client([{ ...published, id: OTHER.id, active_status: "closed" }], []),
    );
    expect(closed).toBeNull();

    const from = vi.fn();
    await expect(
      getHotelById("not-a-uuid", { from } as unknown as HotelQueryClient),
    ).resolves.toBeNull();
    expect(from).not.toHaveBeenCalled();
  });
});
