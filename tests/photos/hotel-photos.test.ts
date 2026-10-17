import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it, vi } from "vitest";

import { HotelPhotos } from "@/components/hotels/hotel-photos";
import { HotelRow } from "@/components/hotels/hotel-row";
import { contentSecurityPolicy } from "@/lib/http/security-headers";
import {
  announcedPhotoAlt,
  compareHotelMedia,
  creditLines,
  eligiblePhotoHosts,
  hidePhotographName,
  hotelPhotoCountNote,
  mediaUrl,
  photoCreditLine,
  renderedHotelPhotos,
  type HotelMediaRecord,
  type RenderedHotelPhoto,
} from "@/lib/screens/hotel-photos";
import {
  forbesAlt,
  forbesLinkPlan,
  forbesStorageBase,
  hotelbedsMediaRows,
  parseMatchCsv,
  selectHotelbedsImages,
  selectMatches,
} from "../../scripts/photos/plan";
import { inFilter, scrub } from "../../scripts/photos/http";
import { galleryPhotos, runForbesUpload } from "../../scripts/photos/forbes-upload";
import { runHotelbedsLoad } from "../../scripts/photos/hotelbeds-load";

const STORAGE = "https://staging.supabase.co";

function row(
  patch: Partial<HotelMediaRecord> & Pick<HotelMediaRecord, "id" | "source">,
): HotelMediaRecord {
  return {
    storagePath: patch.source === "forbes" ? "forbes/hotel/00-facade" : null,
    remotePath: patch.source === "hotelbeds" ? "00/1/a.jpg" : null,
    role: "gallery",
    position: 1,
    width: null,
    height: null,
    altText: "Facade",
    credit: patch.source === "forbes" ? "Forbes Travel Guide" : "Hotelbeds",
    ...patch,
  };
}

describe("media URLs", () => {
  it("builds Forbes storage variants and Hotelbeds giata sizes", () => {
    expect(eligiblePhotoHosts(STORAGE)).toEqual(["staging.supabase.co", "photos.hotelbeds.com"]);
    const forbes = row({ id: "a", source: "forbes" });
    expect(mediaUrl(forbes, "thumb", STORAGE)).toBe(
      "https://staging.supabase.co/storage/v1/object/public/hotel-media/forbes/hotel/00-facade/w480.webp",
    );
    expect(mediaUrl(forbes, "large", STORAGE)).toContain("/w1280.webp");
    const beds = row({
      id: "b",
      source: "hotelbeds",
      remotePath: "00/005787/005787a_hb_a_030.jpg",
    });
    expect(mediaUrl(beds, "thumb", STORAGE)).toBe(
      "https://photos.hotelbeds.com/giata/00/005787/005787a_hb_a_030.jpg",
    );
    expect(mediaUrl(beds, "gallery", STORAGE)).toContain("/giata/bigger/");
    expect(mediaUrl(beds, "large", STORAGE)).toContain("/giata/xl/");
    expect(mediaUrl({ ...beds, remotePath: "../secret.jpg" }, "thumb", STORAGE)).toBeNull();
    expect(mediaUrl(forbes, "thumb", "not a url")).toBeNull();
  });

  it("puts Forbes ahead of a Hotelbeds cover and writes the credit lines", () => {
    const photos = renderedHotelPhotos(
      [
        row({ id: "b", source: "hotelbeds", role: "cover", position: 0 }),
        row({ id: "a", source: "forbes", role: "gallery", position: 3 }),
      ],
      STORAGE,
    );
    expect(photos.map((photo) => photo.credit)).toEqual(["Forbes Travel Guide", "Hotelbeds"]);
    expect(creditLines(photos)).toEqual(["Photo: Forbes Travel Guide", "Hotelbeds"]);
    expect(photoCreditLine("Forbes Travel Guide")).toBe("Photo: Forbes Travel Guide");
    expect(
      compareHotelMedia(
        row({ id: "a", source: "forbes", position: 3 }),
        row({ id: "b", source: "hotelbeds", role: "cover", position: 0 }),
      ),
    ).toBeLessThan(0);
  });

  it("keeps the CSP nonce and adds the two image hosts", () => {
    const csp = contentSecurityPolicy(STORAGE, "aaaaaaaaaaaaaaaa");
    const script = csp.split("; ").find((part) => part.startsWith("script-src"));
    const images = csp.split("; ").find((part) => part.startsWith("img-src"));
    expect(script).toContain("'nonce-aaaaaaaaaaaaaaaa'");
    expect(script).toContain("'strict-dynamic'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(images).toContain("https://photos.hotelbeds.com");
    expect(images).toContain(STORAGE);
    expect(images).not.toContain("forbestravelguide");
  });
});

describe("photo grid", () => {
  const photo = (id: string, credit: RenderedHotelPhoto["credit"]): RenderedHotelPhoto => ({
    id,
    url: "https://photos.hotelbeds.com/giata/bigger/00/1.jpg",
    srcSet: "https://photos.hotelbeds.com/giata/00/1.jpg 320w",
    largeUrl: "https://photos.hotelbeds.com/giata/xl/00/1.jpg",
    alt: `Room ${id}`,
    credit,
    creditLine: credit === "Forbes Travel Guide" ? "Photo: Forbes Travel Guide" : "Hotelbeds",
    width: 800,
    height: 533,
  });

  it("shows three photographs, a +N dialog, and no initials", () => {
    const html = renderToStaticMarkup(
      createElement(HotelPhotos, {
        name: "Harbor House",
        initials: "HH",
        photos: [
          photo("1", "Hotelbeds"),
          photo("2", "Hotelbeds"),
          photo("3", "Hotelbeds"),
          photo("4", "Forbes Travel Guide"),
        ],
      }),
    );
    expect(html.match(/<img /g)?.length).toBe(7);
    expect(html).toContain("+1");
    expect(html).toContain("more photographs");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("Photo: Forbes Travel Guide");
    expect(html).toContain("Hotelbeds");
    expect(html).not.toContain(">HH<");
    expect(html).toContain('width="800"');
    expect(html).toContain('height="533"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
  });

  it("fills the photo row when the hotel has no verified photograph", () => {
    const html = renderToStaticMarkup(
      createElement(HotelPhotos, { name: "Harbor House", initials: "HH", photos: [] }),
    );
    expect(html).toContain('data-photo-state="none"');
    expect(html).toContain("s1-photo-placeholder");
    expect(html).not.toContain("s1-photo-grid");
    expect(html).toContain(">HH<");
  });

  it("names each hide control by place and credit, and missing alts by hotel and index", () => {
    const blank = renderedHotelPhotos(
      [
        row({
          id: "a",
          source: "forbes",
          altText: null,
          position: 0,
          credit: "Forbes Travel Guide",
        }),
        row({ id: "b", source: "hotelbeds", altText: null, position: 1, credit: "Hotelbeds" }),
      ],
      STORAGE,
    );
    expect(announcedPhotoAlt(blank[0]!, "Harbor House", 1)).toBe("Harbor House photograph 1");
    expect(announcedPhotoAlt(blank[1]!, "Harbor House", 2)).toBe("Harbor House photograph 2");
    expect(hidePhotographName(1, "Forbes Travel Guide")).toBe(
      "Hide photograph 1, Forbes Travel Guide",
    );
    expect(hidePhotographName(2, "Hotelbeds")).toBe("Hide photograph 2, Hotelbeds");
    const html = renderToStaticMarkup(
      createElement(HotelPhotos, {
        name: "Harbor House",
        initials: "HH",
        photos: blank,
        hotelId: "40000000-0000-4000-8000-000000000001",
        canHide: true,
      }),
    );
    expect(html).toContain("Harbor House photograph 1");
    expect(html).toContain("Harbor House photograph 2");
    expect(html).toContain("Hide photograph 1, Forbes Travel Guide");
    expect(html).toContain("Hide photograph 2, Hotelbeds");
    expect(html).not.toContain(">Hide photograph<");
    expect(hotelPhotoCountNote(36, true)).toBe(
      "Showing 36 photographs. More photographs are on file.",
    );
    expect(hotelPhotoCountNote(36, false)).toBeNull();
  });

  it("uses initials when nothing is eligible", () => {
    const html = renderToStaticMarkup(
      createElement(HotelRow, {
        hotel: {
          id: "40000000-0000-4000-8000-000000000001",
          name: "Harbor House",
          slug: "harbor",
          hotelType: null,
          starRating: 5,
          countryCode: "TH",
          websiteUrl: null,
          instagramUrl: null,
          address: null,
          activeStatus: "active",
          verificationStatus: "unverified",
          verifiedAt: null,
          destination: null,
        },
        signal: null,
        badge: null,
        href: "/app/hotels/40000000-0000-4000-8000-000000000001",
        cover: null,
      }),
    );
    expect(html).toContain("No photograph");
    expect(html).not.toContain("<img");
    const withCover = renderToStaticMarkup(
      createElement(HotelRow, {
        hotel: {
          id: "40000000-0000-4000-8000-000000000001",
          name: "Harbor House",
          slug: "harbor",
          hotelType: null,
          starRating: 5,
          countryCode: "TH",
          websiteUrl: null,
          instagramUrl: null,
          address: null,
          activeStatus: "active",
          verificationStatus: "unverified",
          verifiedAt: null,
          destination: null,
        },
        signal: null,
        badge: null,
        href: "/app/hotels/40000000-0000-4000-8000-000000000001",
        cover: photo("9", "Forbes Travel Guide"),
      }),
    );
    expect(withCover).toContain("<img");
    expect(withCover).toContain('sizes="46px"');
    expect(withCover).not.toContain("No photograph");
  });
});

describe("import plan", () => {
  it("imports only class=auto and skips review and reject", () => {
    const csv = [
      "class,hotel_id,forbes_property_id,forbes_slug,forbes_name,staging_name,dist_km,name_sim,approved",
      "auto,40000000-0000-4000-8000-000000000001,property/a,city/a,A,Staging A,0.4,0.95,",
      "auto,40000000-0000-4000-8000-000000000001,property/b,city/b,B,Staging A,0.1,0.91,",
      "review,40000000-0000-4000-8000-000000000002,property/c,city/c,C,Staging C,0.2,0.7,no",
      "review,40000000-0000-4000-8000-000000000003,property/d,city/d,D,Staging D,0.2,0.8,yes",
      "reject,40000000-0000-4000-8000-000000000004,property/e,city/e,E,E,2,0.2,",
    ].join("\n");
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });
    try {
      const result = selectMatches(parseMatchCsv(csv).rows);
      expect(result.chosen.map((row) => row.forbesPropertyId)).toEqual(["property/b"]);
      expect(result.chosen.every((row) => row.className === "auto")).toBe(true);
      expect(result.skippedReview).toBe(2);
      expect(result.skippedReject).toBe(1);
      expect(logs.some((line) => line.includes("review=2") && line.includes("reject=1"))).toBe(
        true,
      );
      const link = forbesLinkPlan(result.chosen[0]!);
      expect(link.source_environment).toBe("production");
      expect(link.link_status).toBe("active");
      expect(link.match_method).toBe("name_geo_auto");
      expect(link.match_evidence.scrape_vintage).toBe("scrape-2026-10");
    } finally {
      spy.mockRestore();
    }
  });

  it("picks a GEN cover, caps the gallery at 12, and caps rooms at 4", () => {
    const images = [
      { imageTypeCode: "HAB", path: "hab-1.jpg", visualOrder: 1, order: 1 },
      { imageTypeCode: "HAB", path: "hab-2.jpg", visualOrder: 2, order: 2 },
      { imageTypeCode: "HAB", path: "hab-3.jpg", visualOrder: 3, order: 3 },
      { imageTypeCode: "HAB", path: "hab-4.jpg", visualOrder: 4, order: 4 },
      { imageTypeCode: "HAB", path: "hab-5.jpg", visualOrder: 5, order: 5 },
      { imageTypeCode: "GEN", path: "gen.jpg", visualOrder: 9, order: 9 },
      { imageTypeCode: "PIS", path: "pool.jpg", visualOrder: 8, order: 8 },
      ...Array.from({ length: 20 }, (_, index) => ({
        imageTypeCode: "COM",
        path: `com-${index}.jpg`,
        visualOrder: 20 + index,
        order: index,
      })),
    ];
    const selected = selectHotelbedsImages(images);
    expect(selected).toHaveLength(12);
    expect(selected[0]?.path).toBe("gen.jpg");
    expect(selected.filter((image) => image.type === "HAB")).toHaveLength(4);
    expect(selected.some((image) => image.path === "hab-5.jpg")).toBe(false);
    const rows = hotelbedsMediaRows("40000000-0000-4000-8000-000000000001", [
      ["GEN", "00/1.jpg", 2, 2],
    ]);
    expect(rows[0]).toMatchObject({
      source: "hotelbeds",
      remote_path: "00/1.jpg",
      storage_path: null,
      credit: "Hotelbeds",
      rights_basis: "owner_decision_D189",
      role: "gallery",
      position: 0,
    });
  });

  it("builds a resumable Forbes path and a dry-run that does not call the network", async () => {
    expect(forbesStorageBase("city/hotel", 3, "city-hotel-guestroom-detail.jpg")).toBe(
      "forbes/city/hotel/03-city-hotel-guestroom-detail",
    );
    expect(forbesAlt("city/hotel", "city-hotel-guestroom-detail.jpg")).toBe("Guestroom detail");
    expect(forbesStorageBase("../x", 0, "a.jpg")).toBeNull();
    const calls: string[] = [];
    const match = [
      "class,hotel_id,forbes_property_id,forbes_slug,forbes_name,staging_name,dist_km,name_sim",
      "auto,40000000-0000-4000-8000-000000000001,property/a,city/hotel,A,Staging,0.2,0.99",
    ].join("\n");
    const gallery = `${JSON.stringify({
      slug: "city/hotel",
      gallery_images: [{ local_xl: "city/hotel/facade.jpg" }],
    })}\n`;
    const files = new Map<string, string>([
      ["/match.csv", match],
      ["/gallery.jsonl", gallery],
    ]);
    const result = await runForbesUpload({
      matchCsv: "/match.csv",
      galleryJsonl: "/gallery.jsonl",
      imagesRoot: "/images",
      ledgerPath: "/ledger.jsonl",
      dryRun: true,
      readFileImpl: async (file) => Buffer.from(files.get(file) ?? ""),
      fetchImpl: (async (url: string) => {
        calls.push(url);
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      log: () => undefined,
    });
    expect(result).toMatchObject({ dryRun: true, hotels: 1, photos: 1, links: 1 });
    expect(calls).toEqual([]);
    expect(galleryPhotos(gallery, "/images").get("city/hotel")?.[0]?.absolutePath).toBe(
      "/images/city/hotel/facade.jpg",
    );
  });

  it("loads Hotelbeds rows through a mocked client and scrubs the key", async () => {
    const secret = "service-role-secret-value";
    expect(scrub(`failed ${secret} again`, secret)).toBe("failed [redacted] again");
    expect(inFilter(["00/1"])).toContain("00%2F1");
    const seen: { url: string; auth: string }[] = [];
    const body = JSON.stringify({
      "184": [
        { imageTypeCode: "GEN", path: "00/184/a.jpg", order: 1, visualOrder: 1 },
        { imageTypeCode: "HAB", path: "00/184/b.jpg", order: 2, visualOrder: 2 },
      ],
    });
    const result = await runHotelbedsLoad({
      imagesJson: "/hb.json",
      dryRun: false,
      env: { SUPABASE_URL: "https://staging.supabase.co", SUPABASE_SERVICE_ROLE_KEY: secret },
      readFileImpl: async () => Buffer.from(body),
      log: () => undefined,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen.push({ url: String(url), auth: headers.get("authorization") ?? "" });
        if (String(url).includes("/hotels?")) {
          return new Response(
            JSON.stringify([{ id: "40000000-0000-4000-8000-000000000009", hotelbeds_code: "184" }]),
            {
              status: 200,
            },
          );
        }
        return new Response("[]", { status: 200 });
      }) as typeof fetch,
    });
    expect(result.matchedHotels).toBe(1);
    expect(result.photos).toBe(2);
    expect(seen.every((call) => call.auth === `Bearer ${secret}`)).toBe(true);
    expect(seen.every((call) => !call.url.includes(secret))).toBe(true);
    const insert = seen.find((call) => call.url.includes("/hotel_media"));
    expect(insert).toBeDefined();
  });
});
