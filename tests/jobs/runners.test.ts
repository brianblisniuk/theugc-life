/**
 * Database jobs. The database client is a stub. No network call is made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  runAccountErasure,
  runAnnualCreditRefresh,
  runFollowupHousekeeping,
  type JobDb,
} from "@/lib/jobs/maintenance";

function db(impl: (fn: string) => unknown, error: { message: string } | null = null): JobDb {
  return {
    rpc: vi.fn(async (fn: string) => ({ data: error ? null : impl(fn), error })),
  };
}

describe("maintenance runners", () => {
  it("reads erasure, refresh, and follow-up counts", async () => {
    const erasure = db(() => ({ result: "ok", erased: 2 }));
    expect(await runAccountErasure(erasure)).toEqual({ result: "ok", erased: 2 });
    expect(erasure.rpc).toHaveBeenCalledWith("erase_due_creator_accounts");

    const refresh = db(() => ({ result: "ok", users: 4 }));
    expect(await runAnnualCreditRefresh(refresh)).toEqual({ result: "ok", users: 4 });
    expect(refresh.rpc).toHaveBeenCalledWith("refresh_annual_credit_periods");

    const now = new Date("2026-10-15T06:15:00.000Z");
    const follow = db(() => ({ result: "ok", stopped: 1, enqueued: 3 }));
    expect(await runFollowupHousekeeping(follow, now)).toEqual({
      result: "ok",
      stopped: 1,
      enqueued: 3,
    });
    expect(follow.rpc).toHaveBeenCalledWith("gmail_followup_settle", {
      p_now: now.toISOString(),
      p_user_id: null,
    });
  });

  it("returns an error code and does not echo the database message", async () => {
    const client = db(() => null, { message: "secret-row-detail" });
    const erasure = await runAccountErasure(client);
    const refresh = await runAnnualCreditRefresh(client);
    const follow = await runFollowupHousekeeping(client, new Date());
    expect(erasure).toEqual({ result: "error", erased: 0 });
    expect(refresh).toEqual({ result: "error", users: 0 });
    expect(follow).toEqual({ result: "error", stopped: 0, enqueued: 0 });
    expect(JSON.stringify({ erasure, refresh, follow })).not.toContain("secret-row-detail");
  });
});

describe("erasure retries a pending Rebill cancel", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("REBILL_SECRET_KEY", "sk_test_secret");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 500 })));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function pendingDb(pending: unknown = [{ subscription_id: "sub_retry1" }]) {
    const calls: Array<{ fn: string; args?: Record<string, unknown> }> = [];
    const client: JobDb = {
      rpc: vi.fn(async (fn: string, args?: Record<string, unknown>) => {
        calls.push({ fn, args });
        if (fn === "read_rebill_pending_cancels") return { data: pending, error: null };
        if (fn === "erase_due_creator_accounts") {
          return { data: { result: "ok", erased: 0 }, error: null };
        }
        return { data: null, error: null };
      }),
    };
    return { client, calls };
  }

  it("finishes the row only after Rebill reports cancelled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ id: "sub_retry1", status: "cancelled" })),
    );
    const { client, calls } = pendingDb();
    expect(await runAccountErasure(client)).toEqual({ result: "ok", erased: 0 });
    expect(calls.map((call) => call.fn)).toEqual([
      "read_rebill_pending_cancels",
      "rebill_finish_provider_cancel",
      "erase_due_creator_accounts",
    ]);
    expect(calls[1]?.args).toEqual({ p_subscription_id: "sub_retry1" });
  });

  it("leaves provider_error pending on HTTP 500 and still erases", async () => {
    const { client, calls } = pendingDb();
    expect(await runAccountErasure(client)).toEqual({ result: "ok", erased: 0 });
    expect(calls.map((call) => call.fn)).toEqual([
      "read_rebill_pending_cancels",
      "rebill_queue_provider_cancel",
      "erase_due_creator_accounts",
    ]);
    expect(calls[1]?.args).toEqual({
      p_subscription_id: "sub_retry1",
      p_reason: "provider_error",
    });
  });

  it("leaves provider_error pending when the 200 body is not cancelled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ id: "sub_retry1", status: "active" })),
    );
    const { client, calls } = pendingDb();
    await runAccountErasure(client);
    expect(calls[1]).toEqual({
      fn: "rebill_queue_provider_cancel",
      args: { p_subscription_id: "sub_retry1", p_reason: "provider_error" },
    });
  });

  it("leaves provider_error pending when a 400 read is not cancelled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "GET") return Response.json({ id: "sub_retry1", status: "active" });
        return new Response("bad", { status: 400 });
      }),
    );
    const { client, calls } = pendingDb();
    await runAccountErasure(client);
    expect(calls[1]?.args).toEqual({
      p_subscription_id: "sub_retry1",
      p_reason: "provider_error",
    });
    expect(calls.some((call) => call.fn === "rebill_finish_provider_cancel")).toBe(false);
    expect(calls.at(-1)?.fn).toBe("erase_due_creator_accounts");
  });

  it("queues not_configured without calling Rebill when the secret is missing", async () => {
    vi.stubEnv("REBILL_SECRET_KEY", "");
    const { client, calls } = pendingDb();
    await runAccountErasure(client);
    expect(fetch).not.toHaveBeenCalled();
    expect(calls[1]?.args).toEqual({
      p_subscription_id: "sub_retry1",
      p_reason: "not_configured",
    });
    expect(calls.at(-1)?.fn).toBe("erase_due_creator_accounts");
  });
});
