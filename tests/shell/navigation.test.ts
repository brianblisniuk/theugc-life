/**
 * Product-coherence navigation (D081, Accepted).
 *
 * Primary items stay the five in PRD §6. Inbox and Collaborations are pipeline
 * surfaces. Hotel return links carry only an allowlisted origin. A bad `from`
 * or `trip` value cannot change the href into another path.
 */
import { describe, expect, it } from "vitest";

import { pipelineListState, pipelinePageHref, type PipelinePageInput } from "@/lib/pipeline/view";
import {
  HOTEL_TABS,
  PRIMARY_NAV,
  WORKSPACES,
  activePrimaryHref,
  activeUtilityHref,
  backLink,
  hotelCrumbs,
  hotelHref,
  hotelTabForHash,
  isHotelSection,
  normalizePipelineSurface,
  parseHotelOrigin,
  pipelineQueryStatus,
  pipelineReturnHref,
  pipelineRowLinks,
  pipelineSurfaceHeading,
  chooserPitchParams,
  opportunityPitchHref,
  pitchContextParams,
  pitchHref,
  shellCrumbs,
  tripHotelHref,
} from "@/lib/shell/navigation";

const HOTEL = "11111111-1111-4111-8111-111111111111";
const TRIP = "22222222-2222-4222-8222-222222222222";

function page(total: number, current: number): PipelinePageInput {
  const pageSize = 50;
  const totalPages = Math.ceil(total / pageSize);
  return {
    items: [{ id: "row" }],
    total,
    page: current,
    pageSize,
    totalPages,
    hasPrevious: current > 1,
    hasNext: current < totalPages,
  };
}

function assertAppPath(href: string) {
  expect(href.startsWith("/app")).toBe(true);
  expect(href.startsWith("//")).toBe(false);
  expect(href.includes("://")).toBe(false);
  expect(href).not.toMatch(/[?#].*(\.\.|javascript:|user_id|email|mailbox)/i);
}

describe("primary navigation stays the approved five", () => {
  it("names Home, Discover, Pipeline, Trips, and Profile", () => {
    expect(PRIMARY_NAV.map((item) => item.label)).toEqual([
      "Home",
      "Discover",
      "Pipeline",
      "Trips",
      "Profile",
    ]);
  });

  it("does not treat a prefix collision as a section", () => {
    expect(activePrimaryHref("/app", null)).toBe("/app");
    expect(activePrimaryHref("/application", null)).toBeNull();
    expect(activePrimaryHref("/app/discover", null)).toBe("/app/discover");
    expect(activePrimaryHref("/app/discover-extra", null)).toBeNull();
    expect(activePrimaryHref("/app/profile/portfolio", null)).toBe("/app/profile");
    expect(activePrimaryHref("/app/profile/pitches", null)).toBe("/app/profile");
    expect(activePrimaryHref("/app/account", null)).toBeNull();
    expect(activeUtilityHref("/app/account")).toBe("/app/account");
    expect(activeUtilityHref("/app/billing")).toBe("/app/billing");
    expect(activeUtilityHref("/app/billing-extra")).toBeNull();
  });

  it("highlights the parent of a hotel, never a new primary item", () => {
    expect(activePrimaryHref(`/app/hotels/${HOTEL}`, null)).toBe("/app/discover");
    expect(activePrimaryHref(`/app/hotels/${HOTEL}`, { kind: "pipeline" })).toBe("/app/pipeline");
    expect(activePrimaryHref(`/app/hotels/${HOTEL}`, { kind: "inbox" })).toBe("/app/pipeline");
    expect(activePrimaryHref(`/app/hotels/${HOTEL}`, { kind: "collaboration" })).toBe(
      "/app/pipeline",
    );
    expect(activePrimaryHref(`/app/hotels/${HOTEL}`, { kind: "trip", tripId: TRIP })).toBe(
      "/app/trips",
    );
    expect(activePrimaryHref(`/app/hotels/${HOTEL}/pitch`, null)).toBe("/app/discover");
    expect(opportunityPitchHref(HOTEL, TRIP)).toBe(
      `/app/hotels/${HOTEL}/pitch?opportunity=${TRIP}&from=pipeline`,
    );
    const row = "33333333-3333-4333-8333-333333333333";
    expect(opportunityPitchHref(HOTEL, row, TRIP)).toBe(
      `/app/hotels/${HOTEL}/pitch?opportunity=${row}&from=pipeline&trip=${TRIP}`,
    );
    expect(opportunityPitchHref(HOTEL, "OP-1042")).toBeNull();
    expect(opportunityPitchHref("OP-1042", TRIP)).toBeNull();
    expect(PRIMARY_NAV.map((item) => item.href)).not.toContain("/app/hotels");
  });
});

describe("hotel origin is an allowlist", () => {
  it("keeps only the first known value", () => {
    expect(parseHotelOrigin({ from: ["pipeline", "https://evil.test"] })).toEqual({
      kind: "pipeline",
    });
    expect(parseHotelOrigin({ from: ["https://evil.test", "pipeline"] })).toEqual({
      kind: "discover",
    });
    expect(parseHotelOrigin({ from: "INBOX" })).toEqual({ kind: "discover" });
    expect(parseHotelOrigin({ from: "inbox " })).toEqual({ kind: "discover" });
    expect(parseHotelOrigin({ from: "../admin" })).toEqual({ kind: "discover" });
    expect(parseHotelOrigin({})).toEqual({ kind: "discover" });
  });

  it("accepts a trip id only when it is a uuid, and does not label that trip", () => {
    expect(parseHotelOrigin({ from: "trip", trip: TRIP }).kind).toBe("trip");
    expect(parseHotelOrigin({ from: "trip", trip: "../admin" })).toEqual({ kind: "discover" });
    expect(parseHotelOrigin({ from: "trip", trip: ["not-a-uuid", TRIP] })).toEqual({
      kind: "discover",
    });
    const crumbs = hotelCrumbs({ kind: "trip", tripId: TRIP }, "Casa");
    expect(crumbs.map((crumb) => crumb.label)).toEqual(["Home", "Trips", "Trip", "Casa"]);
    expect(crumbs[2]?.href).toBe(`/app/trips/${TRIP}`);
    expect(backLink(crumbs)).toEqual({ href: `/app/trips/${TRIP}`, label: "Trip" });
  });

  it("builds hotel hrefs with no extra query and no off-site target", () => {
    expect(hotelHref(HOTEL, { kind: "discover" })).toBe(`/app/hotels/${HOTEL}`);
    expect(hotelHref(HOTEL, { kind: "inbox" }, "inbox")).toBe(
      `/app/hotels/${HOTEL}?from=inbox#inbox`,
    );
    expect(hotelHref("not-a-uuid", { kind: "pipeline" })).toBeNull();
    expect(hotelHref(HOTEL, { kind: "trip", tripId: "javascript:alert(1)" })).toBeNull();
    expect(isHotelSection('inbox" onclick="alert(1)')).toBe(false);
    const href = tripHotelHref(TRIP, HOTEL);
    expect(href).toBe(`/app/hotels/${HOTEL}?from=trip&trip=${TRIP}`);
    if (!href) throw new Error("unreachable");
    assertAppPath(href);
    for (const crumb of hotelCrumbs({ kind: "collaboration" }, "Casa")) {
      if (crumb.href) assertAppPath(crumb.href);
    }
  });
});

describe("pipeline surfaces", () => {
  it("treats unknown surface values as the full list", () => {
    for (const raw of [undefined, null, "", "ALL", "inbox ", "drop table", ["nope", "inbox"]]) {
      expect(normalizePipelineSurface(raw)).toBe("all");
    }
    expect(normalizePipelineSurface(["inbox", "collaborations"])).toBe("inbox");
    expect(normalizePipelineSurface("collaborations")).toBe("collaborations");
  });

  it("does not let a status query widen collaborations", () => {
    expect(pipelineQueryStatus("collaborations", "saved")).toBe("won");
    expect(pipelineQueryStatus("collaborations", null)).toBe("won");
    expect(pipelineQueryStatus("inbox", "pitched")).toBe("pitched");
    expect(pipelineQueryStatus("all", null)).toBeNull();
  });

  it("gives collaborations and inbox one spelling, and keeps inbox filters", () => {
    expect(pipelinePageHref("won", 1, "collaborations")).toBe(
      "/app/pipeline?surface=collaborations",
    );
    expect(pipelinePageHref("saved", 2, "collaborations")).toBe(
      "/app/pipeline?surface=collaborations&page=2",
    );
    expect(pipelinePageHref("pitched", 3, "inbox")).toBe(
      "/app/pipeline?surface=inbox&status=pitched&page=3",
    );
    expect(pipelinePageHref(null, 1)).toBe("/app/pipeline");
    const state = pipelineListState({
      failed: false,
      page: page(120, 2),
      status: "won",
      surface: "collaborations",
    });
    if (state.kind !== "items") throw new Error("unreachable");
    expect(state.pagination?.previousHref).toBe("/app/pipeline?surface=collaborations");
    expect(pipelineSurfaceHeading("inbox").description).toMatch(/suggestion/i);
    expect(pipelineSurfaceHeading("inbox").description).toMatch(/does not start a sync/i);
  });

  it("links a row only to that hotel, and only to inbox or collaboration when the cycle allows it", () => {
    expect(pipelineRowLinks({ status: "saved", hotelId: "nope" }, "all")).toEqual([]);
    const saved = pipelineRowLinks({ status: "saved", hotelId: HOTEL, hotelName: "Casa" }, "all");
    expect(saved.map((link) => link.label)).toEqual(["Manage", "Inbox"]);
    expect(saved[1]?.href).toBe(`/app/hotels/${HOTEL}?from=inbox#inbox`);
    const closed = pipelineRowLinks({ status: "closed", hotelId: HOTEL }, "all");
    expect(closed.map((link) => link.label)).toEqual(["Manage"]);
    const won = pipelineRowLinks({ status: "won", hotelId: HOTEL, hotelName: "Casa" }, "all");
    expect(won.map((link) => link.label)).toEqual(["Manage", "Inbox", "Collaboration"]);
    expect(won[2]?.href).toContain("#collaboration");
    const inbox = pipelineRowLinks({ status: "won", hotelId: HOTEL }, "inbox");
    expect(inbox.map((link) => link.label)).toEqual(["Open", "Collaboration"]);
    expect(inbox[0]?.href).toContain("from=inbox");
    const collaborations = pipelineRowLinks({ status: "won", hotelId: HOTEL }, "collaborations");
    expect(collaborations.map((link) => link.label)).toEqual(["Open", "Inbox"]);
    expect(collaborations[0]?.href).toContain("from=collaboration");
    for (const link of [...saved, ...won, ...inbox, ...collaborations]) assertAppPath(link.href);
  });

  it("gives a closed cycle no inbox link on the inbox or collaborations surface", () => {
    for (const surface of ["all", "inbox", "collaborations"] as const) {
      const links = pipelineRowLinks(
        { status: "closed", hotelId: HOTEL, hotelName: "Casa" },
        surface,
      );
      expect(links.some((link) => link.href.includes("#inbox") || link.label === "Inbox")).toBe(
        false,
      );
    }

    const onInbox = pipelineRowLinks({ status: "closed", hotelId: HOTEL }, "inbox");
    expect(onInbox.map((link) => link.label)).toEqual(["Open"]);
    expect(onInbox[0]?.href).toBe(`/app/hotels/${HOTEL}?from=inbox`);

    const onCollaborations = pipelineRowLinks(
      { status: "closed", hotelId: HOTEL },
      "collaborations",
    );
    expect(onCollaborations.map((link) => link.href)).toEqual([
      `/app/hotels/${HOTEL}?from=collaboration#collaboration`,
    ]);

    const openInbox = pipelineRowLinks({ status: "pitched", hotelId: HOTEL }, "inbox");
    expect(openInbox[0]?.href).toBe(`/app/hotels/${HOTEL}?from=inbox#inbox`);
    const row = "33333333-3333-4333-8333-333333333333";
    const managed = pipelineRowLinks(
      { status: "saved", hotelId: HOTEL, hotelName: "Casa", id: row, tripId: TRIP },
      "all",
    );
    expect(managed[0]?.href).toContain(`opportunity=${row}`);
    expect(managed[0]?.href).toContain(`trip=${TRIP}`);
    expect(managed[0]?.href).toContain("from=pipeline");
    const wonCollaborations = pipelineRowLinks({ status: "won", hotelId: HOTEL }, "collaborations");
    expect(wonCollaborations.some((link) => link.href.includes("#inbox"))).toBe(true);
  });

  it("keeps Discover back, origin, and the row trip on a pitch return", () => {
    const other = "44444444-4444-4444-8444-444444444444";
    const row = "33333333-3333-4333-8333-333333333333";
    const back = `/app/discover?q=lisbon&trip=${TRIP}`;
    const params = chooserPitchParams({ kind: "trip", tripId: other }, { id: row, tripId: TRIP }, back);
    expect(params.get("trip")).toBe(TRIP);
    expect(params.get("opportunity")).toBe(row);
    expect(params.get("from")).toBe("trip");
    expect(params.get("back")).toContain("q=lisbon");
    expect(params.get("back")).toContain(TRIP);
    expect(params.get("back")).not.toContain(other);
    const none = chooserPitchParams({ kind: "trip", tripId: other }, { id: row, tripId: null }, back);
    expect(none.get("trip")).toBeNull();
    expect(none.get("from")).toBeNull();
    expect(none.get("opportunity")).toBe(row);
    const oauth = pitchContextParams({
      origin: { kind: "inbox" },
      tripId: TRIP,
      opportunityId: row,
      back,
    });
    expect(oauth.get("from")).toBe("inbox");
    expect(oauth.get("trip")).toBe(TRIP);
    expect(oauth.get("opportunity")).toBe(row);
    expect(oauth.get("back")).toContain("/app/discover");
  });

  it("returns to the surface the creator came from", () => {
    expect(pipelineReturnHref({ kind: "discover" })).toBe("/app/pipeline");
    expect(pipelineReturnHref({ kind: "inbox" })).toBe("/app/pipeline?surface=inbox");
    expect(pipelineReturnHref({ kind: "collaboration" })).toBe(
      "/app/pipeline?surface=collaborations",
    );
    expect(pipelineReturnHref({ kind: "trip", tripId: TRIP })).toBe("/app/pipeline");
  });

  it("keeps inbox and collaborations under pipeline in the home index", () => {
    expect(WORKSPACES.map((item) => item.label)).toEqual([
      "Discover",
      "Trips",
      "Pipeline",
      "Inbox",
      "Collaborations",
    ]);
    for (const item of WORKSPACES) {
      assertAppPath(item.href);
      if (item.label === "Inbox" || item.label === "Collaborations") {
        expect(item.href.startsWith("/app/pipeline?surface=")).toBe(true);
      }
    }
  });
});

describe("hotel detail tabs", () => {
  it("keeps Overview, Intelligence, Contact, and My work, and folds inner anchors into My work", () => {
    expect(HOTEL_TABS.map((tab) => tab.label)).toEqual([
      "Overview",
      "Intelligence",
      "Contact",
      "My work",
    ]);
    expect(hotelTabForHash("")).toBe("overview");
    expect(hotelTabForHash("identity")).toBe("overview");
    expect(hotelTabForHash("map")).toBe("overview");
    expect(hotelTabForHash("intelligence")).toBe("intelligence");
    expect(hotelTabForHash("contact")).toBe("contact");
    expect(hotelTabForHash("work")).toBe("work");
    expect(hotelTabForHash("activity")).toBe("work");
    expect(hotelTabForHash("inbox")).toBe("work");
    expect(hotelTabForHash("collaboration")).toBe("work");
    expect(hotelTabForHash("trip")).toBe("work");
    expect(hotelTabForHash("admin")).toBe("overview");
    expect(hotelTabForHash("../inbox")).toBe("overview");
  });
});

describe("pitch href", () => {
  it("stays on the hotel pitch route and drops a bad trip id", () => {
    expect(pitchHref(HOTEL)).toBe(`/app/hotels/${HOTEL}/pitch`);
    expect(pitchHref(HOTEL, TRIP)).toBe(`/app/hotels/${HOTEL}/pitch?from=trip&trip=${TRIP}`);
    expect(pitchHref(HOTEL, null, { kind: "inbox" })).toBe(`/app/hotels/${HOTEL}/pitch?from=inbox`);
    expect(pitchHref(HOTEL, null, { kind: "collaboration" })).toBe(
      `/app/hotels/${HOTEL}/pitch?from=collaboration`,
    );
    expect(pitchHref(HOTEL, null, { kind: "pipeline" })).toBe(
      `/app/hotels/${HOTEL}/pitch?from=pipeline`,
    );
    const opportunity = "55555555-5555-4555-8555-555555555555";
    const selected = pitchHref(HOTEL, TRIP, { kind: "inbox" }, opportunity);
    expect(selected).toContain("from=inbox");
    expect(selected).toContain(`trip=${TRIP}`);
    expect(selected).toContain(`opportunity=${opportunity}`);
    expect(pitchHref(HOTEL, null, { kind: "pipeline" }, "not-an-opportunity")).toBeNull();
    expect(pitchHref(HOTEL, "not-a-trip")).toBeNull();
    expect(pitchHref("not-a-hotel", TRIP)).toBeNull();
    expect(pitchHref(`${HOTEL}/admin`)).toBeNull();
    const href = pitchHref(HOTEL, TRIP);
    expect(href).not.toBeNull();
    assertAppPath(href!);
  });
});

describe("shell trail matches the hotel origin", () => {
  it("links pitch back to the hotel and includes the trip id", () => {
    const crumbs = shellCrumbs(`/app/hotels/${HOTEL}/pitch`, { kind: "trip", tripId: TRIP });
    expect(crumbs.map((crumb) => crumb.label)).toEqual([
      "Workspace",
      "My Trips",
      "Trip",
      "Hotel",
      "Pitch",
    ]);
    expect(crumbs[2]?.href).toBe(`/app/trips/${TRIP}`);
    expect(crumbs[3]?.href).toBe(`/app/hotels/${HOTEL}?from=trip&trip=${TRIP}`);
    expect(crumbs[4]?.href).toBeUndefined();
  });

  it("uses the pipeline surfaces for inbox and collaboration", () => {
    const inbox = shellCrumbs(`/app/hotels/${HOTEL}`, { kind: "inbox" });
    expect(inbox.map((crumb) => crumb.href)).toEqual([
      "/app",
      "/app/pipeline",
      "/app/pipeline?surface=inbox",
      undefined,
    ]);
    const collaboration = shellCrumbs(`/app/hotels/${HOTEL}/pitch`, { kind: "collaboration" });
    expect(collaboration.map((crumb) => crumb.href)).toEqual([
      "/app",
      "/app/pipeline",
      "/app/pipeline?surface=collaborations",
      `/app/hotels/${HOTEL}?from=collaboration`,
      undefined,
    ]);
    expect(JSON.stringify(inbox)).not.toContain("/app/inbox");
    expect(JSON.stringify(collaboration)).not.toContain("/app/collaborations");
  });
});
