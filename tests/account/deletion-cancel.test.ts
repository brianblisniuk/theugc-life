/**
 * Requesting deletion cancels the Rebill subscription. The action result
 * does not include provider ids. A missing confirmation does not call Rebill.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
const adminRpc = vi.hoisted(() => vi.fn());
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

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: adminRpc }),
}));

import { requestAccountDeletion } from "@/lib/account/actions";

const REQUESTED = "2026-10-17T00:00:00.000Z";
const AFTER = "2026-11-16T00:00:00.000Z";

function form(phrase: string) {
  const data = new FormData();
  data.set("confirmation", phrase);
  return data;
}

function scheduled(ids: string[]) {
  rpc.mockResolvedValue({
    data: {
      result: "scheduled",
      deletion_requested_at: REQUESTED,
      delete_after: AFTER,
      subscription_ids: ids,
    },
    error: null,
  });
}

describe("deletion cancels the Rebill subscription", () => {
  beforeEach(() => {
    rpc.mockReset();
    adminRpc.mockReset();
    adminRpc.mockResolvedValue({ data: null, error: null });
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
    scheduled(["nope", "sub_closed1", "sub_closed2"]);

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
    expect(adminRpc.mock.calls).toEqual([
      ["rebill_finish_provider_cancel", { p_subscription_id: "sub_closed1" }],
      ["rebill_finish_provider_cancel", { p_subscription_id: "sub_closed2" }],
    ]);
    expect(revalidatePath).toHaveBeenCalledWith("/app/account");
  });

  it("keeps the clock and queues provider_error when Rebill returns HTTP 500", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 500 })));
    scheduled(["sub_fail1"]);
    const result = await requestAccountDeletion(form("DELETE"));
    expect(result).toEqual({
      result: "scheduled",
      deletionRequestedAt: REQUESTED,
      deleteAfter: AFTER,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(adminRpc.mock.calls).toEqual([
      [
        "rebill_queue_provider_cancel",
        { p_subscription_id: "sub_fail1", p_reason: "provider_error" },
      ],
    ]);
    expect(JSON.stringify(adminRpc.mock.calls)).not.toMatch(/user_id|userId/);
  });

  it("queues provider_error when a 200 body is not a cancelled subscription", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ id: "sub_fail1", status: "active" })),
    );
    scheduled(["sub_fail1"]);
    const result = await requestAccountDeletion(form("DELETE"));
    expect(result).toEqual({
      result: "scheduled",
      deletionRequestedAt: REQUESTED,
      deleteAfter: AFTER,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(adminRpc.mock.calls).toEqual([
      [
        "rebill_queue_provider_cancel",
        { p_subscription_id: "sub_fail1", p_reason: "provider_error" },
      ],
    ]);
  });

  it("queues provider_error when a 400 is not followed by a cancelled read", async () => {
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        methods.push(init?.method ?? "");
        if (init?.method === "GET") {
          return Response.json({ id: "sub_fail1", status: "active" });
        }
        return new Response("bad", { status: 400 });
      }),
    );
    scheduled(["sub_fail1"]);
    const result = await requestAccountDeletion(form("DELETE"));
    expect(result).toEqual({
      result: "scheduled",
      deletionRequestedAt: REQUESTED,
      deleteAfter: AFTER,
    });
    expect(methods).toEqual(["PATCH", "GET"]);
    expect(adminRpc.mock.calls).toEqual([
      [
        "rebill_queue_provider_cancel",
        { p_subscription_id: "sub_fail1", p_reason: "provider_error" },
      ],
    ]);
  });

  it("queues not_configured and does not call Rebill when the secret is missing", async () => {
    vi.stubEnv("REBILL_SECRET_KEY", "");
    scheduled(["sub_fail1"]);
    const result = await requestAccountDeletion(form("DELETE"));
    expect(result).toEqual({
      result: "scheduled",
      deletionRequestedAt: REQUESTED,
      deleteAfter: AFTER,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(adminRpc.mock.calls).toEqual([
      [
        "rebill_queue_provider_cancel",
        { p_subscription_id: "sub_fail1", p_reason: "not_configured" },
      ],
    ]);
  });

  it("does not call Rebill when confirmation is missing", async () => {
    rpc.mockResolvedValue({ data: { result: "confirmation_required" }, error: null });
    const result = await requestAccountDeletion(form("no"));
    expect(result).toEqual({ result: "confirmation_required" });
    expect(fetch).not.toHaveBeenCalled();
    expect(adminRpc).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
