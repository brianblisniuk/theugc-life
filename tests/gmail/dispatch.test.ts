/**
 * The send dispatcher. Gmail is a mock. No test opens a socket.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { GoogleOAuthAdapter } from "@/lib/gmail/google.server";
import {
  authorizeDispatch,
  handleDispatchPost,
  runScheduledDispatch,
} from "@/lib/gmail/send/dispatch-auth";
import { DISPATCH_CLAIM_BUDGET_MS, dispatchDueGmailSends } from "@/lib/gmail/send/dispatch";
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
          if (!handler) {
            if (fn === "gmail_followup_block_send")
              return { data: { result: "send" }, error: null };
            if (fn === "gmail_send_arm_provider") {
              return { data: { result: "ok", call_provider: true }, error: null };
            }
            if (fn === "gmail_send_remember_provider")
              return { data: { result: "ok" }, error: null };
            return { data: { result: "not_found" }, error: null };
          }
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

  it("the schedule runs in-process and does not send when the secret is absent", async () => {
    const run = vi.fn(async () => ({ sent: 1, deferred: 0, failed: 0, paused: 0 }));
    const missing = await runScheduledDispatch({ secret: null, run });
    expect(missing.statusCode).toBe(500);
    expect(JSON.parse(missing.body)).toEqual({ result: "not_configured" });
    const short = await runScheduledDispatch({ secret: "short-secret", run });
    expect(short.statusCode).toBe(500);
    expect(run).not.toHaveBeenCalled();
    const denied = await runScheduledDispatch({
      secret: SECRET,
      authorization: `Bearer ${SECRET}x`,
      run,
    });
    expect(denied.statusCode).toBe(401);
    expect(run).not.toHaveBeenCalled();
    const ran = await runScheduledDispatch({
      secret: SECRET,
      authorization: `Bearer ${SECRET}`,
      run,
    });
    expect(ran.statusCode).toBe(200);
    expect(JSON.parse(ran.body)).toMatchObject({ result: "ok", sent: 1 });
    expect(ran.body).not.toContain(SECRET);
    expect(run).toHaveBeenCalledTimes(1);
    const source = readFileSync(
      path.join(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
        "src/lib/gmail/send/dispatch-auth.ts",
      ),
      "utf8",
    );
    expect(source).not.toMatch(/google\.server|claude\.server|@anthropic|googleapis|fetchImpl/);
    expect(source).not.toMatch(/header\.length\s*!==/);
    const gate = readFileSync(
      path.join(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
        "src/lib/jobs/scheduled-post.ts",
      ),
      "utf8",
    );
    expect(gate).toContain("timingSafeEqual");
    expect(gate).not.toMatch(/header\.length\s*!==/);
    expect(authorizeDispatch("Bearer short", SECRET)).toBe(false);
    expect(authorizeDispatch(`Bearer ${SECRET}`, `${SECRET}extra-extra`)).toBe(false);
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
    sendDeps.env = {
      nodeEnv: "production",
      sendEnv: "production",
      disabled: "true",
      allowlist: null,
    };
    const summary = await dispatchDueGmailSends(sendDeps, { random: () => 0 });
    expect(sends).not.toHaveBeenCalled();
    expect(codes).toEqual(["kill_switch"]);
    expect(summary).toMatchObject({ sent: 0, failed: 1 });
  });

  it("claims one row at a time and stops claiming at the budget", async () => {
    const ids = ["attempt-a", "attempt-b", "attempt-c"];
    const limits: number[] = [];
    const marked: string[] = [];
    let cursor = 0;
    let sent = 0;
    const { deps: sendDeps, sends } = deps({
      gmail_send_claim_due: (args) => {
        limits.push(Number(args.p_limit));
        const id = ids[cursor];
        cursor += 1;
        if (!id) return { result: "ok", claims: [] };
        return {
          result: "ok",
          claims: [
            {
              result: "reserved",
              call_provider: true,
              attempt_id: id,
              user_id: USER,
              mail_account_id: MAIL,
              from_email: "creator@example.invalid",
              recipient: "desk@hotel.example",
              subject: "Hello",
              body: "A pitch",
              provider_thread_id: null,
              kind: "pitch",
            },
          ],
        };
      },
      gmail_send_mark_provider: (args) => {
        marked.push(String(args.p_attempt_id));
        return { result: "ok", call_provider: true, attempt_id: args.p_attempt_id };
      },
      gmail_send_commit: (args) => ({
        result: "sent",
        attempt_id: args.p_attempt_id,
        event_id: "event-1",
        provider_message_id: "msg-1",
        provider_thread_id: "thread-1",
        binding_status: "pending_thread",
      }),
    });
    sends.mockImplementation(async () => {
      sent += 1;
      return { id: `msg-${sent}`, threadId: `thread-${sent}` };
    });
    const open = await dispatchDueGmailSends(sendDeps, {
      random: () => 0,
      budgetMs: 25_000,
      clock: () => 0,
    });
    expect(open).toMatchObject({ sent: 3, failed: 0 });
    expect(limits).toEqual([1, 1, 1, 1]);
    expect(marked).toEqual(ids);
    expect(sends).toHaveBeenCalledTimes(3);

    cursor = 0;
    limits.length = 0;
    marked.length = 0;
    sent = 0;
    sends.mockClear();
    const stopped = await dispatchDueGmailSends(sendDeps, {
      random: () => 0,
      budgetMs: 25_000,
      clock: () => (sent >= 1 ? 25_000 : 0),
    });
    expect(stopped.sent).toBe(1);
    expect(limits).toEqual([1]);
    expect(marked).toEqual(["attempt-a"]);
    expect(sends).toHaveBeenCalledTimes(1);

    cursor = 0;
    limits.length = 0;
    marked.length = 0;
    sent = 0;
    sends.mockClear();
    const implicit = await dispatchDueGmailSends(sendDeps, {
      random: () => 0,
      clock: () => (sent >= 1 ? DISPATCH_CLAIM_BUDGET_MS : 0),
    });
    expect(DISPATCH_CLAIM_BUDGET_MS).toBe(25_000);
    expect(implicit.sent).toBe(1);
    expect(limits).toEqual([1]);
    expect(sends).toHaveBeenCalledTimes(1);
  });

  it("does not claim when the budget is already spent", async () => {
    let claims = 0;
    const { deps: sendDeps, sends } = deps({
      gmail_send_claim_due: () => {
        claims += 1;
        return { result: "ok", claims: [] };
      },
    });
    const summary = await dispatchDueGmailSends(sendDeps, {
      random: () => 0,
      budgetMs: 0,
      clock: () => 10,
    });
    expect(summary).toEqual({ sent: 0, deferred: 0, failed: 0, paused: 0 });
    expect(claims).toBe(0);
    expect(sends).not.toHaveBeenCalled();
  });

  it("does not send a repeated claim twice", async () => {
    let claims = 0;
    const { deps: sendDeps, sends } = deps({
      gmail_send_claim_due: () => {
        claims += 1;
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
              kind: "pitch",
            },
          ],
        };
      },
      gmail_send_mark_provider: () => ({
        result: "ok",
        call_provider: true,
        attempt_id: ATTEMPT,
      }),
      gmail_send_commit: () => ({
        result: "sent",
        attempt_id: ATTEMPT,
        event_id: "event-1",
        provider_message_id: "msg-1",
        provider_thread_id: "thread-1",
        binding_status: "pending_thread",
      }),
    });
    const summary = await dispatchDueGmailSends(sendDeps, {
      random: () => 0,
      budgetMs: 25_000,
      clock: () => 0,
    });
    expect(summary.sent).toBe(1);
    expect(sends).toHaveBeenCalledTimes(1);
    expect(claims).toBe(2);
  });
});
