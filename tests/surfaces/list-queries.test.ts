/**
 * List loaders select only the public columns and refuse another creator's
 * profile id before issuing the list query.
 */
import { describe, expect, it } from "vitest";

import { loadCollaborationList, loadInboxList } from "@/lib/surfaces/queries";
import { COLLABORATION_LIST_COLUMNS, INBOX_LIST_COLUMNS } from "@/lib/surfaces/lists";
import type { OwnedQueryClient } from "@/lib/onboarding/queries";

const AUTH_A = "11111111-1111-1111-1111-111111111111";
const AUTH_B = "22222222-2222-2222-2222-222222222222";
const PROFILE_A = "99999999-9999-9999-9999-999999999999";
const PROFILE_B = "88888888-8888-8888-8888-888888888888";
const HOTEL_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

type Call = { table: string; columns: string; head: boolean };

function client(
  handler: (call: Call) => {
    data: unknown;
    error: null | { message: string };
    count?: number | null;
  },
) {
  const calls: Call[] = [];
  const supabase = {
    from(table: string) {
      const call: Call = { table, columns: "", head: false };
      const run = () => {
        const snapshot = { ...call };
        calls.push(snapshot);
        return Promise.resolve(handler(snapshot));
      };
      const api = {
        select(columns: string, options?: { head?: boolean }) {
          call.columns = columns;
          call.head = options?.head === true;
          return api;
        },
        eq() {
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
  };
  return { supabase: supabase as unknown as OwnedQueryClient, calls };
}

describe("collaboration loader", () => {
  it("does not read collaborations for a profile row owned by User B", async () => {
    const { supabase, calls } = client(() => ({
      data: {
        id: PROFILE_B,
        user_id: AUTH_B,
        display_name: "Bee",
        hotel: { name: "Secret Villa" },
      },
      error: null,
    }));
    const state = await loadCollaborationList(AUTH_A, supabase);
    expect(state.kind).toBe("error");
    expect(calls.some((call) => call.table === "collaborations")).toBe(false);
    expect(JSON.stringify(state)).not.toContain("Secret Villa");
  });

  it("selects the collaboration columns and fails a page that is only a foreign hotel", async () => {
    const { supabase, calls } = client((call) => {
      if (call.table === "creator_profiles") {
        return { data: { id: PROFILE_A, user_id: AUTH_A, display_name: "Ada" }, error: null };
      }
      if (call.head) return { data: null, error: null, count: 1 };
      return {
        data: [
          {
            id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
            creator_id: PROFILE_B,
            hotel_id: HOTEL_B,
            status: "agreed",
            hotel: { id: HOTEL_B, name: "Secret Villa" },
            private_value_amount: 42,
          },
        ],
        error: null,
      };
    });
    const state = await loadCollaborationList(AUTH_A, supabase);
    expect(state.kind).toBe("error");
    expect(calls.some((call) => call.columns === COLLABORATION_LIST_COLUMNS)).toBe(true);
    expect(JSON.stringify(state)).not.toContain("Secret Villa");
    expect(JSON.stringify(state)).not.toContain("42");
  });
});

describe("inbox loader", () => {
  it("selects inbox link columns and fails a page that is only User B's hotel", async () => {
    const { supabase, calls } = client((call) => {
      if (call.table === "creator_profiles") {
        return { data: { id: PROFILE_A, user_id: AUTH_A, display_name: "Ada" }, error: null };
      }
      if (call.table === "mail_accounts") {
        return { data: [{ user_id: AUTH_A, connection_state: "connected" }], error: null };
      }
      if (call.table === "pipeline_inbox_bindings" && call.head) {
        return { data: null, error: null, count: 1 };
      }
      if (call.table === "pipeline_inbox_bindings") {
        return {
          data: [
            {
              id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
              creator_id: PROFILE_B,
              pipeline_item: {
                hotel_id: HOTEL_B,
                hotel: { id: HOTEL_B, name: "Secret Villa" },
              },
              mail_account: { email_address: "bee-secret@example.com", user_id: AUTH_B },
            },
          ],
          error: null,
        };
      }
      return { data: [], error: null };
    });

    const state = await loadInboxList(AUTH_A, { client: supabase, gmailConfigured: true });
    expect(state.kind).toBe("error");
    expect(calls.some((call) => call.columns === INBOX_LIST_COLUMNS)).toBe(true);
    const packed = JSON.stringify(state);
    expect(packed).not.toContain("Secret Villa");
    expect(packed).not.toContain("bee-secret@example.com");
  });
});
