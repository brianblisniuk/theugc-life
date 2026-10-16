/**
 * The home loader must not treat User B as User A, and must not read the
 * suggestion table itself. Ids come only from the paid list function.
 */
import { describe, expect, it } from "vitest";

import { loadHomeNextActions, type HomeQueryClient } from "@/lib/home/queries";

const AUTH_A = "11111111-1111-4111-8111-111111111111";
const AUTH_B = "22222222-2222-4222-8222-222222222222";
const PROFILE_A = "99999999-9999-4999-8999-999999999999";
const PROFILE_B = "88888888-8888-4888-8888-888888888888";
const HOTEL_A = "40000000-0000-4000-8000-000000000001";
const HOTEL_B = "40000000-0000-4000-8000-000000000002";
const ITEM_A = "51000000-0000-4000-8000-000000000001";
const ITEM_B = "51000000-0000-4000-8000-000000000002";
const SUGGEST_B = "62000000-0000-4000-8000-000000000099";

type Call = { table: string; columns: string };

function client(handler: (call: Call) => { data: unknown; error: { message?: string } | null }) {
  const calls: Call[] = [];
  const rpcs: string[] = [];
  let gmailPayload: unknown = { result: "paused", suggestions: [] };
  const supabase = {
    from(table: string) {
      const call: Call = { table, columns: "" };
      const run = () => {
        calls.push({ ...call });
        return Promise.resolve(handler({ ...call }));
      };
      const api = {
        select(columns: string) {
          call.columns = columns;
          return api;
        },
        eq() {
          return api;
        },
        neq() {
          return api;
        },
        in() {
          return api;
        },
        not() {
          return api;
        },
        order() {
          return api;
        },
        limit() {
          return api;
        },
        maybeSingle: () => run(),
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          return run().then(resolve, reject);
        },
      };
      return api;
    },
    rpc(fn: string) {
      rpcs.push(fn);
      return Promise.resolve({ data: gmailPayload, error: null });
    },
  };
  return {
    supabase: supabase as unknown as HomeQueryClient,
    calls,
    rpcs,
    setGmail(payload: unknown) {
      gmailPayload = payload;
    },
  };
}

const ownProfile = {
  data: { id: PROFILE_A, user_id: AUTH_A, display_name: "Ada" },
  error: null,
};

describe("loadHomeNextActions", () => {
  it("does not read pipeline or Gmail when the profile row is User B", async () => {
    const { supabase, calls, rpcs } = client(() => ({
      data: { id: PROFILE_B, user_id: AUTH_B, display_name: "Bee" },
      error: null,
    }));
    const board = await loadHomeNextActions(AUTH_A, {
      client: supabase,
      credits: { status: "ok", balance: 4 },
      now: new Date("2026-10-13T12:00:00.000Z"),
    });
    expect(board.followUpsDue).toBeNull();
    expect(board.actions).toEqual([]);
    expect(JSON.stringify(board)).not.toContain("Bee");
    expect(calls.some((call) => call.table === "pipeline_items")).toBe(false);
    expect(calls.some((call) => call.table === "gmail_collaboration_suggestions")).toBe(false);
    expect(rpcs).toEqual([]);
  });

  it("keeps B's rows and a paused payload out of A's actions", async () => {
    const harness = client((call) => {
      if (call.table === "creator_profiles") return ownProfile;
      if (call.table === "pipeline_items") {
        return {
          data: [
            {
              id: ITEM_B,
              creator_id: PROFILE_B,
              status: "pitched",
              hotel_id: HOTEL_B,
              next_followup_at: "2026-10-01T00:00:00.000Z",
              last_activity_at: "2026-10-01T00:00:00.000Z",
              hotel: { name: "Bee Hotel" },
            },
            {
              id: ITEM_A,
              creator_id: PROFILE_A,
              status: "saved",
              hotel_id: HOTEL_A,
              next_followup_at: null,
              last_activity_at: "2026-10-02T00:00:00.000Z",
              hotel: { name: "Ada House" },
            },
          ],
          error: null,
        };
      }
      if (call.table === "collaboration_deliverables") {
        return {
          data: [
            {
              id: "73000000-0000-4000-8000-000000000002",
              creator_id: PROFILE_B,
              status: "pending",
              due_on: "2026-10-01",
              pipeline_item: { hotel_id: HOTEL_B, hotel: { name: "Bee Delivery" } },
            },
          ],
          error: null,
        };
      }
      return { data: [], error: null };
    });
    harness.setGmail({
      result: "paused",
      suggestions: [
        {
          id: SUGGEST_B,
          kind: "human_reply",
          pipeline_item_id: ITEM_B,
          hotel_id: HOTEL_B,
          hotel_name: "Bee Hotel",
        },
      ],
    });

    const board = await loadHomeNextActions(AUTH_A, {
      client: harness.supabase,
      credits: { status: "ok", balance: 3 },
      now: new Date("2026-10-13T12:00:00.000Z"),
    });
    const body = JSON.stringify(board);
    expect(body).not.toContain("Bee");
    expect(body).not.toContain(SUGGEST_B);
    expect(board.actions.map((action) => action.title)).toEqual(["Saved hotel: Ada House"]);
    expect(board.followUpsDue).toBe(0);
    expect(board.credits?.title).toBe("3 credits left");
    expect(harness.calls.some((call) => call.table === "gmail_collaboration_suggestions")).toBe(
      false,
    );
    expect(harness.rpcs).toEqual(["list_own_pending_gmail_collaboration_suggestions"]);
  });

  it("treats a Gmail function error as unread, not as no suggestions", async () => {
    const harness = client((call) => {
      if (call.table === "creator_profiles") return ownProfile;
      return { data: [], error: null };
    });
    harness.supabase.rpc = () => Promise.resolve({ data: null, error: { message: "nope" } });
    const board = await loadHomeNextActions(AUTH_A, {
      client: harness.supabase,
      credits: { status: "error" },
      now: new Date("2026-10-13T12:00:00.000Z"),
    });
    expect(board.empty).toBeNull();
    expect(board.notices.map((notice) => notice.id)).toContain("gmail");
    expect(board.notices.map((notice) => notice.id)).toContain("credits");
    expect(JSON.stringify(board)).not.toContain("0 credits");
  });
});
