/**
 * The home loader must not treat User B's rows as User A's progress, and must
 * not treat a transport failure as "you have not started".
 */
import { describe, expect, it } from "vitest";

import { homeView } from "@/lib/onboarding/activation";
import { loadHomeProgress, type OwnedQueryClient } from "@/lib/onboarding/queries";

const AUTH_A = "11111111-1111-1111-1111-111111111111";
const AUTH_B = "22222222-2222-2222-2222-222222222222";
const PROFILE_A = "99999999-9999-9999-9999-999999999999";
const PROFILE_B = "88888888-8888-8888-8888-888888888888";

type Call = { table: string; columns: string; head: boolean };

function client(
  handler: (call: Call) => {
    data: unknown;
    error: { message?: string } | null;
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

const ownProfile = {
  data: { id: PROFILE_A, user_id: AUTH_A, display_name: "Ada" },
  error: null,
};

describe("loadHomeProgress isolation", () => {
  it("does not query trips when the profile row is User B's, and does not complete a step", async () => {
    const { supabase, calls } = client((call) => {
      if (call.table === "creator_profiles") {
        return { data: { id: PROFILE_B, user_id: AUTH_B, display_name: "Bee" }, error: null };
      }
      if (call.table === "mail_accounts") {
        return { data: [{ user_id: AUTH_B, connection_state: "connected" }], error: null };
      }
      if (call.table === "trips") {
        return { data: [{ id: "trip-b", creator_id: PROFILE_B }], error: null };
      }
      return { data: [{ id: "pipe-b", creator_id: PROFILE_B }], error: null };
    });

    const progress = await loadHomeProgress(AUTH_A, { client: supabase, gmailConfigured: true });
    expect(progress.displayName).toBeNull();
    expect(progress.facts.gmail).toBe("no");
    expect(progress.facts.trip).toBe("error");
    expect(progress.facts.saved).toBe("error");
    expect(calls.some((call) => call.table === "trips")).toBe(false);
    expect(calls.some((call) => call.table === "pipeline_items")).toBe(false);
    expect(homeView(progress.facts).kind).toBe("blocked");
    expect(JSON.stringify(progress)).not.toContain("Bee");
  });

  it("keeps A's saved hotel when B's row is mixed in, and ignores B's follow-up", async () => {
    const { supabase } = client((call) => {
      if (call.table === "creator_profiles") return ownProfile;
      if (call.table === "mail_accounts") {
        return {
          data: [
            { user_id: AUTH_B, connection_state: "connected" },
            { user_id: AUTH_A, connection_state: "consent_required" },
          ],
          error: null,
        };
      }
      if (call.table === "trips") {
        return { data: [{ id: "trip-b", creator_id: PROFILE_B }], error: null };
      }
      if (call.columns.includes("next_followup_at")) {
        return {
          data: [{ id: "pipe-b", creator_id: PROFILE_B, next_followup_at: "2026-10-01" }],
          error: null,
        };
      }
      return { data: [{ id: "pipe-a", creator_id: PROFILE_A }], error: null };
    });

    const progress = await loadHomeProgress(AUTH_A, { client: supabase, gmailConfigured: true });
    expect(progress.displayName).toBe("Ada");
    expect(progress.facts.gmail).toBe("no");
    expect(progress.facts.trip).toBe("no");
    expect(progress.facts.saved).toBe("yes");
    expect(progress.facts.followUp).toBe("no");
    const view = homeView(progress.facts);
    expect(view.kind).toBe("next");
    if (view.kind !== "next") return;
    expect(view.current.id).toBe("gmail");
    expect(view.followUp).toBeNull();
  });

  it("a mailbox error is not 'not connected', even if the payload includes a connected row", async () => {
    const { supabase } = client((call) => {
      if (call.table === "creator_profiles") return ownProfile;
      if (call.table === "mail_accounts") {
        return {
          data: [{ user_id: AUTH_A, connection_state: "connected" }],
          error: { message: "timeout" },
        };
      }
      return { data: [], error: null };
    });

    const progress = await loadHomeProgress(AUTH_A, { client: supabase, gmailConfigured: true });
    expect(progress.facts.gmail).toBe("error");
    expect(homeView(progress.facts).kind).toBe("blocked");
  });

  it("skips the mailbox read when Gmail is not configured", async () => {
    const { supabase, calls } = client((call) => {
      if (call.table === "creator_profiles") return ownProfile;
      return { data: [], error: null };
    });
    const progress = await loadHomeProgress(AUTH_A, { client: supabase, gmailConfigured: false });
    expect(calls.some((call) => call.table === "mail_accounts")).toBe(false);
    expect(progress.facts.gmailConfigured).toBe(false);
    const view = homeView(progress.facts);
    expect(view.kind).toBe("next");
    if (view.kind !== "next") return;
    expect(view.current.id).toBe("trip");
  });
});
