/**
 * The send dispatcher. Gmail is a mock. No test opens a socket.
 */
import { describe, expect, it, vi } from "vitest";

import type { GoogleOAuthAdapter } from "@/lib/gmail/google.server";
import { authorizeDispatch, handleDispatchPost, runScheduledDispatch } from "@/lib/gmail/send/dispatch-auth";
import { dispatchDueGmailSends } from "@/lib/gmail/send/dispatch";
import type { SendDeps } from "@/lib/gmail/send/service.server";

const USER = "d04a0000-0000-4000-8000-000000000001";
const MAIL = "d04a0000-0000-4000-8000-000000000010";
const ATTEMPT = "d04a0000-0000-4000-8000-000000000020";
const SECRET = "dispatch-secret-0001";

function deps(handlers: Record<string, (args: Record<string, unknown>) => unknown>): {
  deps: SendDeps;
  sends: ReturnType<typeof vi.fn>;
} {
  const sends = vi.fn(async () => ({ id: "msg-1", threadId: "thread-1" }));
  return {
    sends,
    deps: {
      google: { sendMessage: sends } as unknown as GoogleOAuthAdapter,
      env: { nodeEnv: "production", sendEnv: "production", disabled: null, allowlist: null },
      getAccessToken: async () => ({ result: "ok", accessToken: "access-token" }),
      db: {
        rpc: async (fn: string, args: Record<string, unknown>) => {
          const handler = handlers[fn];
          if (!handler) return { data: { result: "not_found" }, error: null };
          return { data: handler(args), error: null };
        },
      } as unknown as SendDeps["db"],
    },
  };
}

describe("dispatch auth", () => {
  it("rejects a missing, short, or mismatched bearer without calling the dispatcher", async () => {
    const run = vi.fn(async () => ({ sent: 1, deferred: 0, failed: 0, paused: 0 }));
    expect(authorizeDispatch(null, SECRET)).toBe(false);
    expect(authorizeDispatch(`Bearer ${SECRET}`, "short")).toBe(false);
    expect(authorizeDispatch(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(authorizeDispatch(`Bearer ${SECRET}`, SECRET)).toBe(true);
    const denied = await handleDispatchPost("Bearer nope-nope-nope", SECRET, run);
    expect(denied.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
    const allowed = await handleDispatchPost(`Bearer ${SECRET}`, SECRET, run);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ result: "ok", sent: 1 });
  });

  it("the scheduled function posts to the app route and does not import a provider", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result: "ok" }), { status: 200 }));
    const missing = await runScheduledDispatch({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      siteUrl: null,
      secret: SECRET,
    });
    expect(missing.statusCode).toBe(500);
    expect(fetchImpl).not.toHaveBeenCalled();
    const posted = await runScheduledDispatch({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      siteUrl: "https://app.example/",
      secret: SECRET,
    });
    expect(posted.statusCode).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://app.example/api/internal/gmail-send-dispatch",
      expect.objectContaining({
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );
  });
});

describe("dispatch due sends", () => {
  it("delivers one claimed row through the mock and skips a paused claim", async () => {
    const { deps: sendDeps, sends } = deps({
      gmail_send_claim_due: (args) => {
        expect(args.p_pro_cap).toBe(120);
        expect(args.p_max_cap).toBe(300);
        expect(args.p_spacing_seconds).toBeGreaterThanOrEqual(180);
        expect(args.p_spacing_seconds).toBeLessThanOrEqual(300);
        return {
          result: "ok",
          claims: [
            {
              result: "reserved",
              call_provider: true,
              attempt_id: ATTEMPT,
              user_id: USER,
              mail_account_id: MAIL,
              from_email: "creator@example.invalid",
              recipient: "desk@hotel.example",
              subject: "Hello",
              body: "A pitch",
              provider_thread_id: null,
            },
            { user_id: "", result: "reserved" },
          ],
        };
      },
      gmail_send_mark_provider: () => ({ result: "ok", call_provider: true, attempt_id: ATTEMPT }),
      gmail_send_commit: () => ({
        result: "sent",
        attempt_id: ATTEMPT,
        event_id: "event-1",
        provider_message_id: "msg-1",
        provider_thread_id: "thread-1",
        binding_status: "pending_thread",
      }),
    });
    const summary = await dispatchDueGmailSends(sendDeps, { random: () => 0 });
    expect(summary.sent).toBe(1);
    expect(sends).toHaveBeenCalledTimes(1);
  });

  it("does not call Gmail when the allowlist is unset outside production", async () => {
    const codes: string[] = [];
    const { deps: sendDeps, sends } = deps({
      gmail_send_claim_due: () => ({
        result: "ok",
        claims: [
          {
            result: "reserved",
            call_provider: true,
            attempt_id: ATTEMPT,
            user_id: USER,
            mail_account_id: MAIL,
            from_email: "creator@example.invalid",
            recipient: "desk@hotel.example",
            subject: "Hello",
            body: "A pitch",
            provider_thread_id: null,
          },
        ],
      }),
      gmail_send_fail: (args) => {
        codes.push(String(args.p_code));
        return { result: "failed", failure_code: args.p_code, attempt_id: ATTEMPT };
      },
    });
    sendDeps.env = { nodeEnv: "production", sendEnv: null, disabled: null, allowlist: null };
    const summary = await dispatchDueGmailSends(sendDeps, { random: () => 0 });
    expect(sends).not.toHaveBeenCalled();
    expect(codes).toEqual(["allowlist"]);
    expect(summary).toMatchObject({ sent: 0, failed: 1 });
  });

  it("does not call Gmail when the kill switch is on", async () => {
    const codes: string[] = [];
    const { deps: sendDeps, sends } = deps({
      gmail_send_claim_due: () => ({
        result: "ok",
        claims: [
          {
            result: "reserved",
            call_provider: true,
            attempt_id: ATTEMPT,
            user_id: USER,
            mail_account_id: MAIL,
            from_email: "creator@example.invalid",
            recipient: "hello@theugc.life",
            subject: "Hello",
            body: "A pitch",
            provider_thread_id: null,
          },
        ],
      }),
      gmail_send_fail: (args) => {
        codes.push(String(args.p_code));
        return { result: "failed", failure_code: args.p_code, attempt_id: ATTEMPT };
      },
    });
    sendDeps.env = { nodeEnv: "production", sendEnv: "production", disabled: "true", allowlist: null };
    const summary = await dispatchDueGmailSends(sendDeps, { random: () => 0 });
    expect(sends).not.toHaveBeenCalled();
    expect(codes).toEqual(["kill_switch"]);
    expect(summary).toMatchObject({ sent: 0, failed: 1 });
  });
});
