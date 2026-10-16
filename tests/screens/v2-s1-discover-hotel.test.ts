/**
 * V2-S1 Discover and Hotel Detail.
 *
 * These checks stay off the network. A locked contact must not render a name
 * or an email. A missing metric is Insufficient data, never 0%. Provider
 * photo URLs are not covers. Two opportunities stay two records.
 */
import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { THRESHOLD_RULES, type HotelSignalsLoad, type MetricSignal } from "@/lib/metrics/contract";
import { listHotelOpportunities, type PipelineQueryClient } from "@/lib/pipeline/queries";
import {
  activityTag,
  discoverFigures,
  figureText,
  INSUFFICIENT_DATA,
} from "@/lib/screens/discover-figures";
import { discoverReturnHref, hotelFromDiscoverHref } from "@/lib/screens/discover-return";
import {
  opportunityCards,
  opportunityTitle,
  relationshipFromOpportunities,
  type HotelOpportunity,
} from "@/lib/screens/hotel-opportunities";
import { eligibleHotelPhotos, presentHotelPhotos } from "@/lib/screens/hotel-photos";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
  redirect: () => {
    throw new Error("redirect");
  },
  useRouter: () => ({ refresh: () => undefined }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => undefined,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], set: () => undefined }),
}));

const HOTEL = "11111111-1111-4111-8111-111111111111";
const OPP_A = "22222222-2222-4222-8222-222222222222";
const OPP_B = "33333333-3333-4333-8333-333333333333";
const TRIP = "44444444-4444-4444-8444-444444444444";
const SECRET = "hidden.person@hotel.example";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

function signal(overrides: Partial<MetricSignal> & Pick<MetricSignal, "metric" | "state">): MetricSignal {
  return {
    title: overrides.metric,
    layer: overrides.metric === "creator_activity" ? "public" : "premium",
    valueLabel: null,
    sampleBasis: null,
    thresholdRule: THRESHOLD_RULES[overrides.metric],
    ...overrides,
  };
}

function opportunity(overrides: Partial<HotelOpportunity> & Pick<HotelOpportunity, "id" | "status">): HotelOpportunity {
  return {
    displayRef: null,
    stayStart: null,
    stayEnd: null,
    tripId: null,
    tripName: null,
    ...overrides,
  };
}

describe("Discover return path", () => {
  it("keeps known filters and a trip, and refuses every other path", () => {
    const href = discoverReturnHref(
      `/app/discover?q=lisbon&destination=bangkok&page=2&trip=${TRIP}&next=https://evil.example`,
    );
    expect(href.startsWith("/app/discover")).toBe(true);
    expect(href).toContain("q=lisbon");
    expect(href).toContain("destination=bangkok");
    expect(href).toContain("page=2");
    expect(href).toContain(`trip=${TRIP}`);
    expect(href).not.toContain("evil");
    expect(href).not.toContain("next=");

    for (const raw of [
      "https://evil.example/app/discover",
      "//evil.example",
      "/app/discover/../billing",
      "/app/billing",
      "javascript:alert(1)",
      "/app/discover?trip=not-a-uuid",
    ]) {
      const back = discoverReturnHref(raw);
      expect(back.startsWith("/app/discover")).toBe(true);
      expect(back).not.toContain("evil");
      expect(back).not.toContain("javascript");
      expect(back).not.toContain("billing");
      expect(back).not.toContain("not-a-uuid");
    }
  });

  it("does not attach a foreign hotel id", () => {
    expect(hotelFromDiscoverHref("not-a-uuid", `/app/discover?q=lisbon`)).toBeNull();
    const href = hotelFromDiscoverHref(HOTEL, `/app/discover?q=lisbon&trip=${TRIP}`);
    expect(href?.startsWith(`/app/hotels/${HOTEL}?back=`)).toBe(true);
    expect(decodeURIComponent(href ?? "")).toContain("q=lisbon");
    expect(decodeURIComponent(href ?? "")).toContain(`trip=${TRIP}`);
  });
});

describe("metric figures", () => {
  it("keeps a lock empty and does not turn a short sample into 0%", () => {
    const load: HotelSignalsLoad = {
      status: "ok",
      metrics: [
        signal({ metric: "response_rate", state: "locked" }),
        signal({ metric: "response_time", state: "not_enough_data" }),
        signal({
          metric: "creator_activity",
          state: "available",
          valueLabel: "Medium",
          sampleBasis: "Based on activity from 5 creators",
        }),
      ],
    };
    const figures = discoverFigures(load);
    expect(figures.replyRate).toEqual({ state: "locked" });
    expect(figureText(figures.replyRate)).toBe("Pro");
    expect(JSON.stringify(figures.replyRate)).not.toContain("0%");
    expect(figures.replyTime).toEqual({ state: "insufficient" });
    expect(figureText(figures.replyTime)).toBe(INSUFFICIENT_DATA);
    expect(figureText(figures.replyTime)).not.toBe("0%");
    expect(figures.activity.state).toBe("value");
    expect(discoverFigures({ status: "error", notice: "no" }).replyRate.state).toBe("error");
    expect(activityTag({ state: "error" }, "High").state).toBe("error");
    expect(activityTag({ state: "insufficient" }, "High")).toEqual({ state: "value", text: "High" });
  });

  it("shows 0% only when the published label is actually 0%", () => {
    const figures = discoverFigures({
      status: "ok",
      metrics: [signal({ metric: "response_rate", state: "available", valueLabel: "0%" })],
    });
    expect(figures.replyRate).toMatchObject({ state: "value", text: "0%", percent: 0 });
    const broken = discoverFigures({
      status: "ok",
      metrics: [signal({ metric: "response_rate", state: "available", valueLabel: "zero" })],
    });
    expect(broken.replyRate.state).toBe("error");
  });
});

describe("hotel photographs", () => {
  it("drops Hotelbeds and Forbes URLs and renders no image", async () => {
    expect(eligibleHotelPhotos()).toEqual([]);
    const photos = presentHotelPhotos([
      { url: "https://photos.hotelbeds.com/giata/1.jpg", alt: "Hotelbeds cover" },
      { url: "https://www.forbestravelguide.com/hotels/photo.jpg", alt: "Forbes cover" },
      { url: "http://cdn.example/photo.jpg", alt: "Insecure" },
      { url: "https://cdn.example/photo.jpg", alt: "Unapproved host" },
      { url: "not a url", alt: "Broken" },
    ]);
    expect(photos).toEqual([]);
    const { HotelPhotos } = await import("@/components/hotels/hotel-photos");
    const html = renderToStaticMarkup(
      createElement(HotelPhotos, {
        name: "Harbor House",
        initials: "HH",
        photos: [
          { url: "https://photos.hotelbeds.com/giata/1.jpg", alt: "Hotelbeds cover" },
          { url: "https://www.forbestravelguide.com/hotels/photo.jpg", alt: "Forbes cover" },
        ],
      }),
    );
    expect(html).toContain("HH");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("hotelbeds");
    expect(html).not.toContain("forbes");
  });
});

describe("opportunity history", () => {
  const openA = opportunity({
    id: OPP_A,
    displayRef: "OP-1042",
    status: "replied",
    stayStart: "2026-11-01",
    stayEnd: "2026-11-05",
    tripId: TRIP,
    tripName: "Bangkok November",
  });
  const openB = opportunity({
    id: OPP_B,
    displayRef: "OP-1084",
    status: "planned",
    tripName: "Spring content",
  });
  const closed = opportunity({ id: OPP_B, displayRef: "OP-1008", status: "closed" });

  it("keeps two opportunities independent and omits a broken display id", () => {
    const cards = opportunityCards([openA, openB], HOTEL, `/app/discover?q=lisbon&trip=${TRIP}`);
    expect(cards).toHaveLength(2);
    expect(cards[0]?.title).toContain("OP-1042");
    expect(cards[0]?.title).toContain("Bangkok November");
    expect(cards[0]?.stage).toBe("Replied");
    expect(cards[0]?.action).toBe("Continue conversation");
    expect(cards[1]?.stage).toBe("Pitch ready");
    expect(cards[1]?.action).toBe("Review draft");
    expect(cards[0]?.href).toContain(`opportunity=${OPP_A}`);
    expect(cards[1]?.href).toContain(`opportunity=${OPP_B}`);
    expect(cards[0]?.href).not.toContain(OPP_B);
    expect(cards[1]?.href).not.toContain(OPP_A);
    expect(JSON.stringify(cards)).not.toContain(SECRET);
    expect(JSON.stringify(cards)).not.toContain("@");

    const untitled = opportunityTitle(
      opportunity({ id: OPP_A, status: "saved", displayRef: "pipeline-item-9", tripName: null }),
    );
    expect(untitled).toBe("No trip");
    expect(untitled).not.toContain("pipeline-item");
  });

  it("does not offer a second save while another opportunity is open", () => {
    expect(relationshipFromOpportunities({ status: "ok", opportunities: [openA, openB] }, openB)).toEqual({
      status: "open",
      relationship: { pipelineItemId: OPP_B, status: "planned" },
    });
    expect(relationshipFromOpportunities({ status: "ok", opportunities: [openA, closed] }, closed)).toEqual({
      status: "open",
      relationship: { pipelineItemId: OPP_A, status: "replied" },
    });
    expect(relationshipFromOpportunities({ status: "ok", opportunities: [closed] }, closed)).toEqual({
      status: "none",
    });
    expect(relationshipFromOpportunities({ status: "error" }, openA)).toEqual({ status: "error" });
  });
});

describe("listHotelOpportunities", () => {
  function listClient(outcome: { data: unknown; error: unknown }): PipelineQueryClient {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      then(onFulfilled: (value: unknown) => unknown) {
        return Promise.resolve(outcome).then(onFulfilled);
      },
    };
    return { from: () => chain } as unknown as PipelineQueryClient;
  }

  it("keeps valid rows and nulls a display id or trip that fails its shape", async () => {
    const result = await listHotelOpportunities(
      HOTEL,
      listClient({
        error: null,
        data: [
          {
            id: OPP_A,
            display_ref: "OP-1042",
            status: "replied",
            stay_start: "2026-11-01",
            stay_end: "2026-11-05",
            trip_id: TRIP,
          },
          {
            id: OPP_B,
            display_ref: "not-a-ref",
            status: "saved",
            stay_start: null,
            stay_end: null,
            trip_id: "trip-slug",
          },
          { id: "not-a-uuid", display_ref: "OP-1001", status: "saved" },
        ],
      }),
    );
    expect(result).toEqual({
      status: "ok",
      opportunities: [
        {
          id: OPP_A,
          displayRef: "OP-1042",
          status: "replied",
          stayStart: "2026-11-01",
          stayEnd: "2026-11-05",
          tripId: TRIP,
        },
        {
          id: OPP_B,
          displayRef: null,
          status: "saved",
          stayStart: null,
          stayEnd: null,
          tripId: null,
        },
      ],
    });
  });

  it("treats a query failure as an error, not an empty history", async () => {
    const result = await listHotelOpportunities(
      HOTEL,
      listClient({ data: [], error: { message: "fetch failed" } }),
    );
    expect(result).toEqual({ status: "error" });
  });
});

describe("locked contact and metric markup", () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  });

  it("renders a lock and a short sample without a percent or a contact", async () => {
    const { MetricRing, MetricValue } = await import("@/components/hotels/metric-ring");
    const { ContactFeature } = await import("@/components/hotels/contact-feature");
    const { OpportunityHistory } = await import("@/components/hotels/opportunity-history");

    const locked = renderToStaticMarkup(
      createElement(MetricRing, {
        figure: { state: "locked" },
        label: "Observed replies",
      }),
    );
    expect(locked).toContain('data-metric-state="locked"');
    expect(locked).toContain("Pro");
    expect(locked).not.toContain("0%");
    expect(locked).not.toContain("%");

    const missing = renderToStaticMarkup(
      createElement(MetricValue, {
        figure: { state: "insufficient" },
        label: "Reported reply window",
      }),
    );
    expect(missing).toContain(INSUFFICIENT_DATA);
    expect(missing).not.toContain("0%");

    const contact = renderToStaticMarkup(
      createElement(ContactFeature, {
        hotelId: HOTEL,
        state: "locked",
        contacts: [
          {
            id: OPP_A,
            displayName: "Hidden Person",
            jobTitle: "Director",
            department: null,
            email: SECRET,
            phone: "+1 555 0100",
            linkedinUrl: "https://linkedin.example/in/hidden",
            organizationName: null,
            verificationStatus: "verified",
            verifiedAt: "2026-01-01",
            status: "active",
          },
        ],
        cacheEmail: SECRET,
        via: "none",
        balance: 3,
        cost: 1,
      }),
    );
    expect(contact).toContain("Unlock contact · 1 credit");
    expect(contact).toContain("Name and role");
    expect(contact).not.toContain(SECRET);
    expect(contact).not.toContain("Hidden Person");
    expect(contact).not.toContain("linkedin");
    expect(contact).not.toContain("555");

    const history = renderToStaticMarkup(
      createElement(OpportunityHistory, {
        failed: false,
        cards: opportunityCards(
          [
            opportunity({ id: OPP_A, displayRef: "OP-1042", status: "replied", tripName: "Bangkok November" }),
            opportunity({ id: OPP_B, displayRef: "OP-1084", status: "planned" }),
          ],
          HOTEL,
          "/app/discover",
        ),
      }),
    );
    expect(history).toContain("OP-1042");
    expect(history).toContain("OP-1084");
    expect(history).toContain("Replied");
    expect(history).toContain("Pitch ready");
    expect(history.match(/data-opportunity=/g)).toHaveLength(2);
  });
});

describe("screen source", () => {
  it("wires Discover and Hotel Detail to the real panels without a fabricated photo", () => {
    const discover = source("src/app/(app)/app/discover/page.tsx");
    const hotel = source("src/app/(app)/app/hotels/[id]/page.tsx");
    const contact = source("src/components/hotels/contact-feature.tsx");
    expect(discover).toContain("loadPageMetricSignals");
    expect(discover).toContain("discoverFigures");
    expect(discover).toContain("result.pins");
    expect(discover).not.toMatch(/hotelbeds|forbestravelguide|unsplash|<img/i);
    expect(hotel).toContain("HotelSectionNav");
    expect(hotel).toContain("NextStepPanel");
    expect(hotel).toContain("ContactFeature");
    expect(hotel).toContain("OpportunityHistory");
    expect(hotel).toContain("eligibleHotelPhotos");
    expect(hotel).toContain("No verified photograph on file.");
    expect(hotel).not.toMatch(/<img[\s>]/);
    expect(hotel).not.toMatch(/unsplash|placeholder\.com|stock|hotelbeds|forbes/i);
    expect(contact).toContain("Name and role");
    expect(contact).toContain("Professional email");
    expect(source("src/lib/screens/copy.ts")).toContain('export const UNLOCK_BUTTON = "Unlock contact · 1 credit"');
    expect(contact).not.toMatch(/anthropic|claude|hunter/i);
  });
});
