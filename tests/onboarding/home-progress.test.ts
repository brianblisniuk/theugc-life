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
const DEST = "d0000000-0000-4000-8000-000000000001";
const HOTEL = "40000000-0000-4000-8000-000000000001";

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

const empty = { data: [], error: null };

describe("loadHomeProgress isolation", () => {
  it("does not query onboarding or pipeline when the profile row is User B's", async () => {
    const { supabase, calls } = client((call) => {
      if (call.table === "creator_profiles") {
        return { data: { id: PROFILE_B, user_id: AUTH_B, display_name: "Bee" }, error: null };
      }
      return { data: [{ id: "foreign", creator_id: PROFILE_B }], error: null };
    });

    const progress = await loadHomeProgress(AUTH_A, { client: supabase });
    expect(progress.displayName).toBeNull();
    expect(progress.facts.destination).toBe("error");
    expect(progress.facts.saved).toBe("error");
    expect(progress.facts.pitch).toBe("error");
    expect(calls.some((call) => call.table === "creator_onboarding_state")).toBe(false);
    expect(calls.some((call) => call.table === "pipeline_items")).toBe(false);
    expect(calls.some((call) => call.table === "mail_accounts")).toBe(false);
    expect(calls.some((call) => call.table === "trips")).toBe(false);
    expect(homeView(progress.facts).kind).toBe("blocked");
    expect(JSON.stringify(progress)).not.toContain("Bee");
  });

  it("keeps A's saved hotel when B's row is mixed in, and ignores B's follow-up", async () => {
    const { supabase, calls } = client((call) => {
      if (call.table === "creator_profiles") return ownProfile;
      if (call.table === "creator_onboarding_state") {
        return {
          data: [
            {
              creator_id: PROFILE_B,
              destination_id: DEST,
              checklist_dismissed_at: null,
              destination: { name: "Bee Bay", slug: "bee" },
            },
            {
              creator_id: PROFILE_A,
              destination_id: DEST,
              checklist_dismissed_at: null,
              destination: { name: "Ada Bay", slug: "ada" },
            },
          ],
          error: null,
        };
      }
      if (call.table === "outreach_events") return empty;
      if (call.columns.includes("next_followup_at")) {
        return {
          data: [
            {
              id: "pipe-b",
              creator_id: PROFILE_B,
              hotel_id: HOTEL,
              next_followup_at: "2026-10-01",
              hotel: { name: "Bee Hotel" },
            },
          ],
          error: null,
        };
      }
      if (call.columns.includes("private_notes")) return empty;
      return { data: [{ id: "pipe-a", creator_id: PROFILE_A }], error: null };
    });

    const progress = await loadHomeProgress(AUTH_A, { client: supabase });
    expect(progress.displayName).toBe("Ada");
    expect(progress.destinationName).toBe("Ada Bay");
    expect(progress.destinationSlug).toBe("ada");
    expect(progress.facts.destination).toBe("yes");
    expect(progress.facts.saved).toBe("yes");
    expect(progress.facts.pitch).toBe("no");
    expect(progress.facts.followUp).toBe("no");
    expect(progress.followUpHotel).toBeNull();
    const view = homeView(progress.facts);
    expect(view.kind).toBe("checklist");
    if (view.kind !== "checklist") return;
    expect(view.remaining).toBe(0);
    expect(view.followUp).toBeNull();
    expect(JSON.stringify(progress)).not.toContain("Bee");
    expect(calls.some((call) => call.table === "mail_accounts")).toBe(false);
    expect(calls.some((call) => call.table === "trips")).toBe(false);
  });

  it("a destination read error is not 'no destination'", async () => {
    const { supabase } = client((call) => {
      if (call.table === "creator_profiles") return ownProfile;
      if (call.table === "creator_onboarding_state") {
        return { data: [], error: { message: "timeout" } };
      }
      return empty;
    });

    const progress = await loadHomeProgress(AUTH_A, { client: supabase });
    expect(progress.facts.destination).toBe("error");
    expect(homeView(progress.facts).kind).toBe("blocked");
  });

  it("a malformed destination row is an error, and a missing key is not 'not chosen'", async () => {
    const { supabase } = client((call) => {
      if (call.table === "creator_profiles") return ownProfile;
      if (call.table === "creator_onboarding_state") {
        return { data: [{ creator_id: PROFILE_A, name: "Ada Bay" }], error: null };
      }
      return empty;
    });

    const progress = await loadHomeProgress(AUTH_A, { client: supabase });
    expect(progress.facts.destination).toBe("error");
    expect(progress.facts.dismissed).toBe(false);
  });

  it("an own pitch note completes the optional step, and a foreign note does not", async () => {
    const { supabase } = client((call) => {
      if (call.table === "creator_profiles") return ownProfile;
      if (call.table === "creator_onboarding_state") return empty;
      if (call.columns.includes("private_notes")) {
        return {
          data: [
            { creator_id: PROFILE_B, private_notes: "bee secret" },
            { creator_id: PROFILE_A, private_notes: "  hola hotel  " },
          ],
          error: null,
        };
      }
      return empty;
    });

    const progress = await loadHomeProgress(AUTH_A, { client: supabase });
    expect(progress.facts.pitch).toBe("yes");
    expect(progress.facts.destination).toBe("no");
    expect(JSON.stringify(progress)).not.toContain("bee secret");
  });

  it("a follow-up without the caller's hotel name is an error, not nothing due", async () => {
    const { supabase } = client((call) => {
      if (call.table === "creator_profiles") return ownProfile;
      if (call.columns.includes("next_followup_at")) {
        return {
          data: [
            {
              creator_id: PROFILE_A,
              hotel_id: HOTEL,
              next_followup_at: "2026-10-20",
              hotel: { name: "  " },
            },
          ],
          error: null,
        };
      }
      return empty;
    });

    const progress = await loadHomeProgress(AUTH_A, { client: supabase });
    expect(progress.facts.followUp).toBe("error");
    expect(progress.followUpHotel).toBeNull();
    expect(homeView(progress.facts).kind).toBe("blocked");
  });

  it("names the caller's own follow-up hotel", async () => {
    const { supabase } = client((call) => {
      if (call.table === "creator_profiles") return ownProfile;
      if (call.columns.includes("next_followup_at")) {
        return {
          data: [
            {
              creator_id: PROFILE_A,
              hotel_id: HOTEL,
              next_followup_at: "2026-10-20",
              hotel: { name: "Casa Lumbre" },
            },
          ],
          error: null,
        };
      }
      if (call.table === "creator_onboarding_state") {
        return {
          data: [
            {
              creator_id: PROFILE_A,
              destination_id: null,
              checklist_dismissed_at: "2026-10-13T00:00:00.000Z",
            },
          ],
          error: null,
        };
      }
      return empty;
    });

    const progress = await loadHomeProgress(AUTH_A, { client: supabase });
    expect(progress.facts.followUp).toBe("yes");
    expect(progress.facts.dismissed).toBe(true);
    expect(progress.facts.destination).toBe("no");
    expect(progress.followUpHotel).toEqual({ name: "Casa Lumbre", hotelId: HOTEL });
    expect(homeView(progress.facts).kind).toBe("hidden");
  });
});
