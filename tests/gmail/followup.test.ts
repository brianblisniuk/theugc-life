/**
 * Follow-up copy and the send gate. Gmail is not called.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { GoogleOAuthAdapter } from "@/lib/gmail/google.server";
import { describeFollowUp, type FollowUpNext } from "@/lib/gmail/followup/next-action";
import { dispatchDueGmailSends } from "@/lib/gmail/send/dispatch";
import type { SendDeps } from "@/lib/gmail/send/service.server";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function next(overrides: Partial<FollowUpNext> = {}): FollowUpNext {
  return {
    state: "needs_opt_in",
    sequence: 1,
    followupId: null,
    recipient: "desk@hotel.example",
    subject: null,
    body: null,
    earliestSendAt: "2026-10-16T09:00:00.000Z",
    stopReason: null,
    hold: null,
    ...overrides,
  };
}

describe("follow-up next action", () => {
  it("says nothing sends until the creator schedules the text", () => {
    const copy = describeFollowUp(next(), "Oct 16, 2026, 9:00 AM");
    expect(copy.heading).toBe("Follow-up 1 is not scheduled.");
    expect(copy.detail).toContain("Nothing sends until you schedule that text");
    expect(copy.detail).toContain("desk@hotel.example");
    expect(copy.detail).toContain("Oct 16, 2026, 9:00 AM");
  });

  it("shows the approved text's send time while it is scheduled and queued", () => {
    const scheduled = describeFollowUp(
      next({ state: "scheduled", sequence: 2, subject: "Re: Hello", body: "Following up." }),
      "Wed",
    );
    expect(scheduled.heading).toContain("Follow-up 2 is scheduled");
    expect(scheduled.detail).toContain("will not send before Wed");
    expect(scheduled.detail).toContain("exactly what will send");

    const queued = describeFollowUp(next({ state: "queued" }), "Wed");
    expect(queued.heading).toContain("send queue");
    expect(queued.detail).toContain("business hours");
  });

  it("names why a follow-up stopped", () => {
    expect(
      describeFollowUp(next({ state: "stopped", stopReason: "hotel_replied" }), "").detail,
    ).toContain("hotel replied");
    expect(
      describeFollowUp(next({ state: "stopped", stopReason: "bounced" }), "").detail,
    ).toContain("bounced");
    expect(
      describeFollowUp(next({ state: "stopped", stopReason: "pipeline_closed" }), "").detail,
    ).toContain("won or closed");
    expect(
      describeFollowUp(next({ state: "stopped", stopReason: "cancelled" }), "").detail,
    ).toContain("cancelled");
    expect(
      describeFollowUp(next({ state: "stopped", stopReason: "recipient_rejected" }), "").detail,
    ).toContain("no longer a contact");
  });

  it("says a held follow-up is waiting and will not send yet", () => {
    const paused = describeFollowUp(next({ state: "held", hold: "sends_paused" }), "Wed");
    expect(paused.heading).toContain("will not send yet");
    expect(paused.detail).toContain("bounced");
    const plan = describeFollowUp(next({ state: "held", hold: "plan_required" }), "");
    expect(plan.detail).toContain("Pro");
  });

  it("does not describe two sent follow-ups as pending", () => {
    const copy = describeFollowUp(next({ state: "complete", sequence: null }), "");
    expect(copy.heading).toBe("Both follow-ups were sent.");
    expect(copy.detail).toContain("Nothing else is scheduled");
  });
});

describe("follow-up dispatch gate", () => {
  it("does not call Gmail when the follow-up has been stopped", async () => {
    const sends = vi.fn(async () => ({ id: "msg", threadId: "thread" }));
    const fails: string[] = [];
    const deps: SendDeps = {
      google: { sendMessage: sends } as unknown as GoogleOAuthAdapter,
      env: { nodeEnv: "production", sendEnv: "production", disabled: null, allowlist: null },
      getAccessToken: async () => ({ result: "ok", accessToken: "token" }),
      db: {
        rpc: async (fn: string, args: Record<string, unknown>) => {
          if (fn === "gmail_send_claim_due") {
            return {
              data: {
                result: "ok",
                claims: [
                  {
                    result: "reserved",
                    call_provider: true,
                    attempt_id: "attempt-1",
                    user_id: "user-1",
                    mail_account_id: "mail-1",
                    from_email: "creator@example.invalid",
                    recipient: "desk@hotel.example",
                    subject: "Re: Hello",
                    body: "Following up on a collaboration.",
                    provider_thread_id: "thread-1",
                    kind: "follow_up",
                  },
                ],
              },
              error: null,
            };
          }
          if (fn === "gmail_followup_block_send") {
            return { data: { result: "stopped", stop_reason: "hotel_replied" }, error: null };
          }
          if (fn === "gmail_send_fail") {
            fails.push(String(args.p_code));
            return { data: { result: "failed", failure_code: args.p_code }, error: null };
          }
          return { data: { result: "not_found" }, error: null };
        },
      } as unknown as SendDeps["db"],
    };
    const summary = await dispatchDueGmailSends(deps, { random: () => 0 });
    expect(sends).not.toHaveBeenCalled();
    expect(fails).toEqual(["followup_stopped"]);
    expect(summary.failed).toBe(1);
    expect(summary.sent).toBe(0);
  });
});

describe("follow-up action source", () => {
  it("does not import Gmail or Claude", () => {
    const source = readFileSync(path.join(ROOT, "src/lib/gmail/followup/actions.ts"), "utf8");
    expect(source).not.toMatch(/google\.server|completeClaude|sendGmailMessage|sendMessage/);
  });
});
