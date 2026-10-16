import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildHomeDashboard,
  outreachCards,
  parseNightCoverage,
  upcomingTrip,
} from "@/lib/home/dashboard";
import { blockedNextActionBoard } from "@/lib/home/next-actions";
import {
  INBOX_COPY,
  INBOX_SEND_GATE,
  buildInboxScreen,
  classifyMailbox,
  commercialSummary,
  dateDecisionMessage,
  mapDateDecision,
  revokedEmptyInbox,
  threadAttention,
  type InboxThreadRow,
} from "@/lib/inbox/model";
import { INBOX_QUERY_COLUMNS } from "@/lib/inbox/queries";
import { HOME_SIGNAL_COLUMNS } from "@/lib/home/signals";
import { loadInboxWorkspace, type InboxQueryClient } from "@/lib/inbox/queries";

const PROFILE_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PROFILE_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const AUTH_A = "11111111-1111-4111-8111-111111111111";
const HOTEL_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const HOTEL_B = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const ITEM_A = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const BIND_A = "ffffffff-ffff-ffff-ffff-ffffffffffff";
function thread(overrides: Partial<InboxThreadRow> = {}): InboxThreadRow {
  return {
    bindingId: BIND_A,
    creatorId: PROFILE_A,
    pipelineItemId: ITEM_A,
    hotelId: HOTEL_A,
    hotelName: "North House",
    displayRef: "OP-1001",
    status: "pitched",
    updatedAt: "2026-10-16T12:00:00.000Z",
    commercialState: "engaged",
    readingPresent: true,
    stale: false,
    hasHumanReply: true,
    hasRedirect: false,
    ...overrides,
  };
}

function emptyBoard() {
  return {
    ...blockedNextActionBoard(),
    notices: [],
    empty: "No pending action in the data we could read.",
  };
}

describe("inbox screen", () => {
  it("treats a human reply on a sent opportunity as needing a reply, and a stale reading as not current", () => {
    expect(
      threadAttention({
        status: "pitched",
        stale: false,
        hasHumanReply: true,
        suggestionKinds: [],
        collaborationKinds: [],
      }),
    ).toBe("needs_reply");
    expect(
      threadAttention({
        status: "replied",
        stale: false,
        hasHumanReply: true,
        suggestionKinds: [],
        collaborationKinds: [],
      }),
    ).toBe("waiting");
    const stale = thread({ stale: true, hasHumanReply: true, status: "pitched" });
    const screen = buildInboxScreen({
      profileId: PROFILE_A,
      asOf: "2026-10-16T15:00:00.000Z",
      filter: "all",
      selectedId: null,
      mailbox: { kind: "connected", email: "ada@example.com" },
      threads: [stale],
      suggestions: [],
      collaborations: [],
      collaborationStatus: "ok",
      dates: [],
      threadsCapped: false,
      datesCapped: false,
      suggestionsFailed: false,
      datesFailed: false,
      collaborationsFailed: false,
      foreign: false,
    });
    expect(screen.kind).toBe("ready");
    if (screen.kind !== "ready") return;
    expect(screen.counts.needsReply).toBe(0);
    expect(screen.threads[0]?.summary).toBe(INBOX_COPY.stale);
    expect(screen.sendGate).toBe(INBOX_SEND_GATE);
    expect(screen.sendGate).toContain("gmail.send");
  });

  it("drops a foreign creator instead of rendering their hotel", () => {
    const screen = buildInboxScreen({
      profileId: PROFILE_A,
      asOf: "2026-10-16T15:00:00.000Z",
      filter: "all",
      selectedId: null,
      mailbox: { kind: "disconnected" },
      threads: [thread({ creatorId: PROFILE_B, hotelName: "Secret Villa" })],
      suggestions: [],
      collaborations: [],
      collaborationStatus: "hidden",
      dates: [],
      threadsCapped: false,
      datesCapped: false,
      suggestionsFailed: false,
      datesFailed: false,
      collaborationsFailed: false,
      foreign: false,
    });
    expect(screen.kind).toBe("error");
    expect(JSON.stringify(screen)).not.toContain("Secret Villa");
  });

  it("does not invent a classification when the reading is missing", () => {
    expect(
      commercialSummary({
        commercialState: null,
        readingPresent: false,
        stale: false,
        hasRedirect: false,
      }),
    ).toBe(INBOX_COPY.noClassification);
  });

  it("keeps an overlapping date suggestion pending in the message", () => {
    expect(mapDateDecision({ result: "overlap" })).toBe("overlap");
    expect(dateDecisionMessage("overlap")).toContain("stays pending");
    expect(dateDecisionMessage("accepted")).toContain("Night status was not changed");
    expect(mapDateDecision({ result: "drop table" })).toBe("error");
  });

  it("names disconnected, consent, and connected mailboxes without treating consent as connected", () => {
    expect(classifyMailbox({ configured: false, failed: false, rows: [] }).kind).toBe(
      "unconfigured",
    );
    expect(classifyMailbox({ configured: true, failed: false, rows: [] }).kind).toBe(
      "disconnected",
    );
    expect(
      classifyMailbox({
        configured: true,
        failed: false,
        rows: [{ connectionState: "consent_required", email: "ada@example.com" }],
      }).kind,
    ).toBe("consent");
    expect(
      classifyMailbox({
        configured: true,
        failed: false,
        rows: [{ connectionState: "connected", email: "ada@example.com" }],
      }),
    ).toEqual({ kind: "connected", email: "ada@example.com" });
    expect(
      classifyMailbox({
        configured: true,
        failed: false,
        rows: [{ connectionState: "reauth_required", email: "ada@example.com" }],
      }).kind,
    ).toBe("reauth");
  });

  it("does not call a revoked mailbox with no conversations an empty inbox", () => {
    const empty = buildInboxScreen({
      profileId: PROFILE_A,
      asOf: "2026-10-16T15:00:00.000Z",
      filter: "all",
      selectedId: null,
      mailbox: { kind: "reauth" },
      threads: [],
      suggestions: [],
      collaborations: [],
      collaborationStatus: "ok",
      dates: [],
      threadsCapped: false,
      datesCapped: false,
      suggestionsFailed: false,
      datesFailed: false,
      collaborationsFailed: false,
      foreign: false,
    });
    expect(empty.kind).toBe("ready");
    if (empty.kind !== "ready") return;
    const blocked = revokedEmptyInbox(empty);
    expect(blocked?.title).toBe("Gmail authorization stopped");
    expect(blocked?.body).toContain("not an empty inbox");
    const kept = buildInboxScreen({
      profileId: PROFILE_A,
      asOf: "2026-10-16T15:00:00.000Z",
      filter: "all",
      selectedId: null,
      mailbox: { kind: "reauth" },
      threads: [thread()],
      suggestions: [],
      collaborations: [],
      collaborationStatus: "ok",
      dates: [],
      threadsCapped: false,
      datesCapped: false,
      suggestionsFailed: false,
      datesFailed: false,
      collaborationsFailed: false,
      foreign: false,
    });
    expect(kept.kind).toBe("ready");
    if (kept.kind !== "ready") return;
    expect(revokedEmptyInbox(kept)).toBeNull();
    expect(kept.threads[0]?.hotelName).toBe("North House");
  });
});

describe("inbox loader", () => {
  it("does not query threads when the profile row belongs to someone else", async () => {
    const tables: string[] = [];
    const client = {
      from(table: string) {
        tables.push(table);
        const api = {
          select() {
            return api;
          },
          eq() {
            return api;
          },
          order() {
            return api;
          },
          limit() {
            return api;
          },
          maybeSingle: () =>
            Promise.resolve({
              data: { id: PROFILE_B, user_id: PROFILE_B, display_name: "Bee" },
              error: null,
            }),
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve({ data: [], error: null }).then(resolve);
          },
        };
        return { select: () => api };
      },
      rpc: () => Promise.resolve({ data: null, error: null }),
    };
    const screen = await loadInboxWorkspace(
      AUTH_A,
      {},
      { client: client as InboxQueryClient, gmailConfigured: true },
    );
    expect(screen.kind).toBe("error");
    expect(tables).toEqual(["creator_profiles", "mail_accounts"]);
    expect(JSON.stringify(screen)).not.toContain("Bee");
  });

  it("selects no token, no message body, and no service credential", () => {
    const columns = Object.values(INBOX_QUERY_COLUMNS).join(" ");
    expect(columns).not.toMatch(/token|refresh|body|sanitized|secret/i);
    expect(Object.values(HOME_SIGNAL_COLUMNS).join(" ")).not.toMatch(/token|refresh|body|secret/i);
  });
});

describe("home dashboard", () => {
  it("does not turn a failed count or a failed night read into zero", () => {
    const dashboard = buildHomeDashboard({
      actions: emptyBoard(),
      counts: { status: "error" },
      trips: { status: "error" },
      coverage: { status: "error" },
      outreach: { status: "error" },
      asOf: "2026-10-16T00:00:00.000Z",
      gmail: { status: "error" },
    });
    expect(dashboard.stats.every((stat) => stat.value === null)).toBe(true);
    expect(dashboard.stats.every((stat) => stat.source === "insufficient")).toBe(true);
    expect(JSON.stringify(dashboard)).not.toContain('"value":"0"');
    expect(dashboard.trip.status).toBe("error");
    expect(
      parseNightCoverage({
        result: "ok",
        trip_nights: 0,
        confirmed_nights: 1,
        pending_nights: 0,
        gap_nights: 0,
      }).status,
    ).toBe("error");
  });

  it("counts confirmed nights once and does not count pending as confirmed", () => {
    expect(
      parseNightCoverage({
        result: "ok",
        trip_nights: 7,
        confirmed_nights: 3,
        pending_nights: 2,
        gap_nights: 2,
      }),
    ).toEqual({
      status: "ok",
      coverage: { tripNights: 7, confirmedNights: 3, pendingNights: 2, gapNights: 2 },
    });
  });

  it("refuses another creator's outreach name", () => {
    const result = outreachCards(
      PROFILE_A,
      [{ id: "1", creatorId: PROFILE_B, name: "Secret campaign" }],
      [],
    );
    expect(result).toBe("foreign");
  });

  it("does not count a saved hotel as contacted", () => {
    const result = outreachCards(
      PROFILE_A,
      [{ id: ITEM_A, creatorId: PROFILE_A, name: "Lisbon week" }],
      [
        { creatorId: PROFILE_A, initiativeId: ITEM_A, hotelId: HOTEL_A, pipelineStatus: "saved" },
        { creatorId: PROFILE_A, initiativeId: ITEM_A, hotelId: HOTEL_B, pipelineStatus: "pitched" },
      ],
    );
    expect(result).toEqual({
      status: "ok",
      cards: [{ id: ITEM_A, name: "Lisbon week", hotelCount: 2, contactedCount: 1 }],
    });
  });

  it("picks the trip that has not ended and says paused Gmail is not an empty suggestion list", () => {
    const next = upcomingTrip(
      [
        {
          id: "1",
          name: null,
          destinationName: "Past",
          startDate: "2026-01-01",
          endDate: "2026-01-08",
        },
        {
          id: "2",
          name: "Now",
          destinationName: "Lisbon",
          startDate: "2026-10-10",
          endDate: "2026-10-20",
        },
      ],
      "2026-10-16T00:00:00.000Z",
    );
    expect(next?.destinationName).toBe("Lisbon");
    const dashboard = buildHomeDashboard({
      actions: emptyBoard(),
      counts: { status: "not_found" },
      trips: { status: "ok", trips: [] },
      coverage: { status: "none" },
      outreach: { status: "empty" },
      asOf: "2026-10-16T00:00:00.000Z",
      gmail: { status: "paused" },
    });
    expect(dashboard.intelligence.lines.join(" ")).toContain("paused");
    expect(dashboard.intelligence.lines.join(" ")).not.toContain("No pending Gmail suggestion");
    expect(dashboard.heading).toBe("Nothing in the data we could read needs a decision today.");
  });
});

describe("inbox and home sources", () => {
  const root = path.resolve(__dirname, "../..");
  const files = [
    "src/app/(app)/app/page.tsx",
    "src/app/(app)/app/inbox/page.tsx",
    "src/components/inbox/inbox-screen.tsx",
    "src/components/inbox/date-decision.tsx",
    "src/components/inbox/thread-decisions.tsx",
    "src/components/home/home-screen.tsx",
    "src/lib/inbox/model.ts",
    "src/lib/inbox/queries.ts",
    "src/lib/inbox/date-actions.ts",
    "src/lib/home/dashboard.ts",
    "src/lib/home/signals.ts",
  ];

  it("does not import the send path or hard-code the prototype hotels", () => {
    const source = files.map((file) => readFileSync(path.join(root, file), "utf8")).join("\n");
    const withoutGate = source.replaceAll(INBOX_SEND_GATE, "");
    expect(source).not.toContain("@/lib/gmail/send");
    expect(withoutGate).not.toContain("gmail.send");
    expect(source).not.toContain("Siam Canopy");
    expect(source).not.toContain("OP-1042");
    expect(source).not.toContain("Sample only");
    expect(source).not.toMatch(/messages\.send|users\.messages/);
  });
});
