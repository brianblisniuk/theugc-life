import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONTACTED_STATUSES,
  attentionEmptyCopy,
  buildHomeDashboard,
  outreachCards,
  outreachFractionLabel,
  outreachFromCounts,
  parseNightCoverage,
  upcomingTrip,
} from "@/lib/home/dashboard";
import { blockedNextActionBoard } from "@/lib/home/next-actions";
import {
  INBOX_COPY,
  INBOX_SEND_GATE,
  INBOX_SUGGESTION_CAP,
  buildInboxScreen,
  classifyMailbox,
  commercialSummary,
  dateDecisionMessage,
  datePanelState,
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
      suggestionsCapped: false,
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
      suggestionsCapped: false,
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
      suggestionsCapped: false,
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
      suggestionsCapped: false,
      suggestionsFailed: false,
      datesFailed: false,
      collaborationsFailed: false,
      foreign: false,
    });
    expect(kept.kind).toBe("ready");
    if (kept.kind !== "ready") return;
    expect(revokedEmptyInbox(kept)).toBeNull();
    expect(kept.threads[0]?.hotelName).toBe("North House");
    expect(kept.threads[0]?.pitchHref).toContain("from=inbox");
  });

  it("keeps a pending stay-date decision when the mailbox is revoked and no thread is linked", () => {
    const screen = buildInboxScreen({
      profileId: PROFILE_A,
      asOf: "2026-10-16T15:00:00.000Z",
      filter: "all",
      selectedId: null,
      mailbox: { kind: "reauth" },
      threads: [],
      suggestions: [],
      collaborations: [],
      collaborationStatus: "ok",
      dates: [
        {
          id: "12121212-1212-4212-8212-121212121212",
          creatorId: PROFILE_A,
          pipelineItemId: null,
          tripHotelId: HOTEL_A,
          hotelName: "North House",
          checkIn: "2026-11-01",
          checkOut: "2026-11-04",
        },
      ],
      threadsCapped: false,
      datesCapped: false,
      suggestionsCapped: false,
      suggestionsFailed: false,
      datesFailed: false,
      collaborationsFailed: false,
      foreign: false,
    });
    expect(screen.kind).toBe("ready");
    if (screen.kind !== "ready") return;
    expect(revokedEmptyInbox(screen)?.body).toContain("not an empty inbox");
    expect(screen.dates).toEqual([
      expect.objectContaining({ hotelName: "North House", checkIn: "2026-11-01" }),
    ]);
    expect(datePanelState({ datesUnavailable: false, dateCount: screen.dates.length }).kind).toBe(
      "list",
    );
  });

  it("does not describe a failed stay-date read as an empty list", () => {
    const screen = buildInboxScreen({
      profileId: PROFILE_A,
      asOf: "2026-10-16T15:00:00.000Z",
      filter: "all",
      selectedId: null,
      mailbox: { kind: "connected", email: "ada@example.com" },
      threads: [],
      suggestions: [],
      collaborations: [],
      collaborationStatus: "ok",
      dates: [],
      threadsCapped: false,
      datesCapped: false,
      suggestionsCapped: false,
      suggestionsFailed: false,
      datesFailed: true,
      collaborationsFailed: false,
      foreign: false,
    });
    expect(screen.kind).toBe("ready");
    if (screen.kind !== "ready") return;
    expect(screen.datesUnavailable).toBe(true);
    const panel = datePanelState({ datesUnavailable: true, dateCount: 0 });
    expect(panel.kind).toBe("unavailable");
    if (panel.kind === "list") return;
    expect(panel.text).toContain("unavailable");
    expect(panel.text).not.toContain("No date suggestion is waiting");
    expect(datePanelState({ datesUnavailable: false, dateCount: 0 }).kind).toBe("empty");
  });

  it("does not call a failed suggestion or collaboration read a completed empty review", () => {
    const waiting = thread({ status: "replied", hasHumanReply: false, stale: false });
    const base = {
      profileId: PROFILE_A,
      asOf: "2026-10-16T15:00:00.000Z",
      filter: "all" as const,
      selectedId: null,
      mailbox: { kind: "connected" as const, email: "ada@example.com" },
      threads: [waiting],
      suggestions: [],
      collaborations: [],
      dates: [],
      threadsCapped: false,
      datesCapped: false,
      suggestionsCapped: false,
      datesFailed: false,
      foreign: false,
    };
    const complete = buildInboxScreen({
      ...base,
      collaborationStatus: "ok",
      suggestionsFailed: false,
      collaborationsFailed: false,
    });
    expect(complete.kind).toBe("ready");
    if (complete.kind !== "ready") return;
    expect(complete.heading).toBe("Nothing in these conversations needs a reply.");

    const suggestionsDown = buildInboxScreen({
      ...base,
      collaborationStatus: "ok",
      suggestionsFailed: true,
      collaborationsFailed: false,
    });
    expect(suggestionsDown.kind).toBe("ready");
    if (suggestionsDown.kind !== "ready") return;
    expect(suggestionsDown.heading).toBe(INBOX_COPY.reviewUnavailable);
    expect(suggestionsDown.heading).not.toContain("Nothing in these conversations needs a reply");

    const collaborationsDown = buildInboxScreen({
      ...base,
      collaborationStatus: "error",
      suggestionsFailed: false,
      collaborationsFailed: true,
    });
    expect(collaborationsDown.kind).toBe("ready");
    if (collaborationsDown.kind !== "ready") return;
    expect(collaborationsDown.heading).toBe(INBOX_COPY.reviewUnavailable);
    expect(collaborationsDown.notices.join(" ")).toContain("could not review");
  });

  it("withholds the empty heading when inbox suggestions are truncated", () => {
    const screen = buildInboxScreen({
      profileId: PROFILE_A,
      asOf: "2026-10-16T15:00:00.000Z",
      filter: "all",
      selectedId: null,
      mailbox: { kind: "connected", email: "ada@example.com" },
      threads: [thread({ status: "replied", hasHumanReply: false })],
      suggestions: [],
      collaborations: [],
      collaborationStatus: "ok",
      dates: [],
      threadsCapped: false,
      datesCapped: false,
      suggestionsCapped: true,
      suggestionsFailed: false,
      datesFailed: false,
      collaborationsFailed: false,
      foreign: false,
    });
    expect(screen.kind).toBe("ready");
    if (screen.kind !== "ready") return;
    expect(screen.heading).toBe(INBOX_COPY.suggestionsCappedHeading);
    expect(screen.heading).not.toContain("Nothing in these conversations needs a reply");
    expect(screen.notices.join(" ")).toContain("more inbox suggestions");
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
          in() {
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

  it("loads each listed thread's reading and scopes suggestions without an unordered cap", async () => {
    const calls: { table: string; ops: string[] }[] = [];
    const binding = {
      id: BIND_A,
      creator_id: PROFILE_A,
      pipeline_item_id: ITEM_A,
      updated_at: "2026-10-16T12:00:00.000Z",
      pipeline_item: {
        id: ITEM_A,
        creator_id: PROFILE_A,
        status: "replied",
        display_ref: "OP-1001",
        hotel_id: HOTEL_A,
        hotel: { id: HOTEL_A, name: "North House" },
      },
    };
    const reading = {
      binding_id: BIND_A,
      creator_id: PROFILE_A,
      commercial_state: "engaged",
      stale: false,
      has_human_reply: false,
      has_redirect: false,
      has_rejection: false,
    };
    const suggestions = Array.from({ length: INBOX_SUGGESTION_CAP + 1 }, (_, index) => ({
      id: `12121212-1212-4212-8212-${String(index).padStart(12, "0")}`,
      creator_id: PROFILE_A,
      pipeline_item_id: ITEM_A,
      kind: "review_decline",
      applies_crm: false,
      status: "pending",
    }));
    const tables: Record<string, unknown> = {
      creator_profiles: { id: PROFILE_A, user_id: AUTH_A, display_name: "Ada" },
      pipeline_inbox_bindings: [binding],
      pipeline_inbox_readings: [reading],
      pipeline_inbox_suggestions: suggestions,
      stay_date_suggestions: [],
    };
    const client = {
      from(table: string) {
        const ops: string[] = [];
        const api = {
          select() {
            return api;
          },
          eq(column: string) {
            ops.push(`eq:${column}`);
            return api;
          },
          in(column: string, values: readonly string[]) {
            ops.push(`in:${column}:${values.join(",")}`);
            return api;
          },
          order(column: string) {
            ops.push(`order:${column}`);
            return api;
          },
          limit(count: number) {
            ops.push(`limit:${count}`);
            return api;
          },
          maybeSingle() {
            calls.push({ table, ops: [...ops] });
            return Promise.resolve({ data: tables[table] ?? null, error: null });
          },
          then(resolve: (value: unknown) => unknown) {
            calls.push({ table, ops: [...ops] });
            const data = tables[table] ?? [];
            return Promise.resolve({ data, error: null }).then(resolve);
          },
        };
        return { select: () => api };
      },
      rpc: () => Promise.resolve({ data: { result: "paused" }, error: null }),
    };
    const screen = await loadInboxWorkspace(
      AUTH_A,
      {},
      { client: client as InboxQueryClient, gmailConfigured: false },
    );
    const readings = calls.find((call) => call.table === "pipeline_inbox_readings");
    const suggestionCall = calls.find((call) => call.table === "pipeline_inbox_suggestions");
    expect(readings?.ops).toContain(`in:binding_id:${BIND_A}`);
    expect(readings?.ops.some((op) => op.startsWith("limit:"))).toBe(false);
    expect(suggestionCall?.ops).toContain(`in:pipeline_item_id:${ITEM_A}`);
    expect(suggestionCall?.ops).toContain("order:created_at");
    expect(suggestionCall?.ops).toContain("order:id");
    expect(suggestionCall?.ops).toContain(`limit:${INBOX_SUGGESTION_CAP + 1}`);
    expect(screen.kind).toBe("ready");
    if (screen.kind !== "ready") return;
    expect(screen.threads[0]?.summary).not.toBe(INBOX_COPY.noClassification);
    expect(screen.heading).toBe(INBOX_COPY.suggestionsCappedHeading);
    expect(screen.heading).not.toContain("Nothing in these conversations needs a reply");
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
      truncated: false,
      cards: [{ id: ITEM_A, name: "Lisbon week", hotelCount: 2, contactedCount: 1 }],
    });
    expect(CONTACTED_STATUSES).not.toContain("saved");
    expect(CONTACTED_STATUSES).not.toContain("planned");
  });

  it("uses exact outreach totals and says when the campaign list is truncated", () => {
    const shown = outreachFromCounts(
      PROFILE_A,
      [{ id: ITEM_A, creatorId: PROFILE_A, name: "Lisbon week" }],
      [{ initiativeId: ITEM_A, hotelCount: 240, contactedCount: 17 }],
      9,
    );
    expect(shown).toEqual({
      status: "ok",
      truncated: true,
      cards: [{ id: ITEM_A, name: "Lisbon week", hotelCount: 240, contactedCount: 17 }],
    });
    if (shown === "foreign" || shown.status !== "ok") return;
    expect(outreachFractionLabel(shown.cards[0]!)).toBe(
      "17 of 240 hotels are sent or further. Saved and pitch-ready hotels are not counted as contacted.",
    );
    expect(
      outreachFromCounts(
        PROFILE_A,
        [{ id: ITEM_A, creatorId: PROFILE_A, name: "Lisbon week" }],
        [],
        1,
      ),
    ).toEqual({ status: "error" });
  });

  it("says next actions are unavailable when a source failed", () => {
    const blocked = buildHomeDashboard({
      actions: blockedNextActionBoard(),
      counts: {
        status: "ok",
        counts: {
          outreach: 1,
          replies: 0,
          agreements: 0,
          completedCollaborations: 0,
          deliverablesDone: 0,
        },
      },
      trips: { status: "ok", trips: [] },
      coverage: { status: "none" },
      outreach: { status: "empty" },
      asOf: "2026-10-16T00:00:00.000Z",
      gmail: { status: "paused" },
    });
    expect(blocked.attentionUnavailable).toBe(true);
    expect(attentionEmptyCopy(true)).toContain("unavailable");
    expect(attentionEmptyCopy(true)).not.toContain("were reviewed");
    const partial = buildHomeDashboard({
      actions: {
        ...emptyBoard(),
        notices: [
          { id: "pipeline", text: "pipeline failed" },
          { id: "deliverables", text: "deliverables failed" },
          { id: "gmail", text: "gmail failed" },
        ],
      },
      counts: { status: "not_found" },
      trips: { status: "ok", trips: [] },
      coverage: { status: "none" },
      outreach: { status: "empty" },
      asOf: "2026-10-16T00:00:00.000Z",
      gmail: { status: "error" },
    });
    expect(partial.attentionUnavailable).toBe(true);
    expect(partial.tasks).toEqual([]);
    const reviewed = buildHomeDashboard({
      actions: { ...emptyBoard(), followUpsDue: 0 },
      counts: { status: "not_found" },
      trips: { status: "ok", trips: [] },
      coverage: { status: "none" },
      outreach: { status: "empty" },
      asOf: "2026-10-16T00:00:00.000Z",
      gmail: { status: "paused" },
    });
    expect(reviewed.attentionUnavailable).toBe(false);
    expect(attentionEmptyCopy(false)).toContain("were reviewed");
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
          status: "completed",
        },
        {
          id: "2",
          name: "Now",
          destinationName: "Lisbon",
          startDate: "2026-10-10",
          endDate: "2026-10-20",
          status: "active",
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

  it("counts outreach with exact totals and keeps date decisions on a revoked inbox", () => {
    const signals = readFileSync(path.join(root, "src/lib/home/signals.ts"), "utf8");
    const page = readFileSync(path.join(root, "src/app/(app)/app/inbox/page.tsx"), "utf8");
    const screen = readFileSync(path.join(root, "src/components/inbox/inbox-screen.tsx"), "utf8");
    expect(signals).toContain('count: "exact"');
    expect(signals).toContain("head: true");
    expect(signals).not.toContain(".limit(200)");
    expect(signals).not.toContain("outreachCards");
    const queries = readFileSync(path.join(root, "src/lib/inbox/queries.ts"), "utf8");
    const readingsQuery = queries.slice(
      queries.indexOf('from("pipeline_inbox_readings")'),
      queries.indexOf('from("pipeline_inbox_suggestions")'),
    );
    expect(readingsQuery).toContain('.in("binding_id"');
    expect(readingsQuery).not.toContain(".limit(");
    expect(queries).toContain('.in("pipeline_item_id"');
    expect(queries).toContain('.order("created_at"');
    expect(queries).toContain("INBOX_SUGGESTION_CAP + 1");
    expect(queries).not.toContain(".limit(200)");
    expect(page).not.toContain("revokedEmptyInbox");
    expect(screen).toContain("revokedEmptyInbox");
    expect(screen).toContain('datesPanel.kind === "unavailable"');
    expect(screen).toContain("<DateDecision");
    expect(screen.indexOf("datesPanel")).toBeGreaterThan(screen.indexOf("revoked"));
  });
});
