/**
 * Database jobs. The database client is a stub. No network call is made.
 */
import { describe, expect, it, vi } from "vitest";

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
