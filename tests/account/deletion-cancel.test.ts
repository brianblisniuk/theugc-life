/**
 * Requesting deletion cancels the Rebill subscription. The action result
 * does not include provider ids. A missing confirmation does not call Rebill.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock("next/cache", () => ({
  revalidatePath,
}));

vi.mock("@/lib/auth/guards", () => ({
  resolveSession: async () => ({
    status: "authenticated",
    session: {
      userId: "d106c000-0000-4000-8000-000000000003",
      email: null,
      role: "creator",
    },
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc }),
}));

import { requestAccountDeletion } from "@/lib/account/actions";

const REQUESTED = "2026-10-17T00:00:00.000Z";
const AFTER = "2026-11-16T00:00:00.000Z";

function form(phrase: string) {
  const data = new FormData();
  data.set("confirmation", phrase);
  return data;
}

describe("deletion cancels the Rebill subscription", () => {
  beforeEach(() => {
    rpc.mockReset();
    revalidatePath.mockReset();
    vi.unstubAllEnvs();
    vi.stubEnv("REBILL_SECRET_KEY", "sk_test_secret");
    vi.stubGlobal("fetch", vi.fn());
  });

  it("patches each subscription id and does not return those ids", async () => {
    const calls: Array<{ url: string; method?: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method, body: String(init?.body ?? "") });
        const id = String(url).split("/").pop();
        return Response.json({ id, status: "cancelled" });
      }),
    );
    rpc.mockResolvedValue({
      data: {
        result: "scheduled",
        deletion_requested_at: REQUESTED,
        delete_after: AFTER,
        subscription_ids: ["nope", "sub_closed1", "sub_closed2"],
      },
      error: null,
    });

    const result = await requestAccountDeletion(form("DELETE"));
    expect(result).toEqual({
      result: "scheduled",
      deletionRequestedAt: REQUESTED,
      deleteAfter: AFTER,
    });
    expect(JSON.stringify(result)).not.toContain("sub_closed");
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.rebill.com/v3/subscriptions/sub_closed1",
      "https://api.rebill.com/v3/subscriptions/sub_closed2",
    ]);
    expect(calls.every((call) => call.method === "PATCH")).toBe(true);
    expect(calls.every((call) => JSON.parse(call.body).status === "cancelled")).toBe(true);
    expect(calls.every((call) => !/user_id|userId/.test(call.body))).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith("/app/account");
  });

  it("does not call Rebill when confirmation is missing", async () => {
    rpc.mockResolvedValue({ data: { result: "confirmation_required" }, error: null });
    const result = await requestAccountDeletion(form("no"));
    expect(result).toEqual({ result: "confirmation_required" });
    expect(fetch).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
