/**
 * D04 send guard, MIME, the real adapter's test refusal, and the orchestration
 * around a scripted database. No test here opens a socket to Gmail.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { GoogleAdapterError, googleOAuthAdapter, type GoogleOAuthAdapter } from "@/lib/gmail/google.server";
import { assessSendGuard, dailyCapFromEnv } from "@/lib/gmail/send/guard";
import { MimeRejected, buildPlainMessage, encodeRawMessage } from "@/lib/gmail/send/mime";
import { sendGmailMessage, type SendDeps } from "@/lib/gmail/send/service.server";

const USER = "d04a0000-0000-4000-8000-000000000001";
const MAIL = "d04a0000-0000-4000-8000-000000000010";
const ATTEMPT = "d04a0000-0000-4000-8000-000000000020";
const KEY = "idempotency-key-0001";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("send guard", () => {
  it("allows only hello@theugc.life outside production when the list is unset", () => {
    expect(assessSendGuard({ nodeEnv: "development" }, "hello@theugc.life").ok).toBe(true);
    expect(assessSendGuard({ nodeEnv: "test" }, "Hello@TheUGC.life").ok).toBe(true);
    const blocked = assessSendGuard({ nodeEnv: "development" }, "other@example.com");
    expect(blocked).toEqual({ ok: false, code: "allowlist" });
  });

  it("uses a configured list outside production and in production", () => {
    expect(
      assessSendGuard(
        { nodeEnv: "production", allowlist: "one@example.com, two@example.com" },
        "TWO@example.com",
      ).ok,
    ).toBe(true);
    expect(
      assessSendGuard({ nodeEnv: "production", allowlist: "one@example.com" }, "two@example.com"),
    ).toEqual({ ok: false, code: "allowlist" });
  });

  it("allows any recipient in production only when the list is unset", () => {
    expect(assessSendGuard({ nodeEnv: "production" }, "guest@hotel.example").ok).toBe(true);
    expect(assessSendGuard({ nodeEnv: "production", allowlist: "  " }, "guest@hotel.example").ok).toBe(
      true,
    );
  });

  it("the kill switch wins over the allowlist", () => {
    for (const disabled of ["true", "1", "yes", " TRUE "]) {
      expect(
        assessSendGuard({ nodeEnv: "production", disabled, allowlist: "" }, "hello@theugc.life"),
      ).toEqual({ ok: false, code: "kill_switch" });
    }
    expect(assessSendGuard({ nodeEnv: "production", disabled: "false" }, "guest@hotel.example").ok).toBe(
      true,
    );
  });

  it("parses the daily cap and leaves clamping to the database", () => {
    expect(dailyCapFromEnv(undefined)).toBe(20);
    expect(dailyCapFromEnv("")).toBe(20);
    expect(dailyCapFromEnv("nope")).toBe(20);
    expect(dailyCapFromEnv("1000")).toBe(1000);
    expect(dailyCapFromEnv("1")).toBe(1);
  });
});

describe("plain message", () => {
  it("rejects a header break in from, to, or subject", () => {
    expect(() =>
      buildPlainMessage({ from: "a@b.co\r\nBcc: x@y.co", to: "c@d.co", subject: "Hi", body: "Body" }),
    ).toThrow(MimeRejected);
    expect(() =>
      buildPlainMessage({ from: "a@b.co", to: "c@d.co\nBcc: x", subject: "Hi", body: "Body" }),
    ).toThrow(MimeRejected);
    expect(() =>
      buildPlainMessage({ from: "a@b.co", to: "c@d.co", subject: "Hi\r\nBcc: x", body: "Body" }),
    ).toThrow(MimeRejected);
  });

  it("encodes a non-ascii subject and base64url-encodes the raw message", () => {
    const rfc822 = buildPlainMessage({
      from: "creator@example.invalid",
      to: "desk@hotel.example",
      subject: "Café",
      body: "Line one\nLine two",
    });
    expect(rfc822).toContain("Subject: =?UTF-8?B?");
    expect(rfc822).toContain("Line one\r\nLine two");
    expect(rfc822.startsWith("From: creator@example.invalid\r\n")).toBe(true);
    expect(encodeRawMessage(rfc822)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("real Gmail adapter", () => {
  it("throws before fetch when NODE_ENV is test", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      googleOAuthAdapter.sendMessage({ accessToken: "token", raw: "cmF3" }),
    ).rejects.toMatchObject({ code: "gmail_send_blocked_in_test" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

function scripted(handlers: Record<string, (args: Record<string, unknown>) => unknown>): {
  deps: SendDeps;
  sends: ReturnType<typeof vi.fn>;
  calls: { fn: string }[];
} {
  const calls: { fn: string }[] = [];
  const sends = vi.fn(async () => ({ id: "msg-1", threadId: "thread-1" }));
  const google = { sendMessage: sends } as unknown as GoogleOAuthAdapter;
  const deps: SendDeps = {
    google,
    env: { nodeEnv: "production", disabled: null, allowlist: null, dailyLimit: "20" },
    getAccessToken: async () => ({ result: "ok", accessToken: "access-token" }),
    db: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn });
        const handler = handlers[fn];
        if (!handler) return { data: { result: "not_found", call_provider: false }, error: null };
        return { data: handler(args), error: null };
      },
    } as unknown as SendDeps["db"],
  };
  return { deps, sends, calls };
}

const reserved = {
  result: "reserved",
  call_provider: true,
  attempt_id: ATTEMPT,
  mail_account_id: MAIL,
  from_email: "creator@example.invalid",
  recipient: "desk@hotel.example",
  subject: "Hello",
  body: "A pitch",
  provider_thread_id: null,
};

describe("send orchestration", () => {
  const input = {
    userId: USER,
    mailAccountId: MAIL,
    idempotencyKey: KEY,
    kind: "pitch" as const,
    recipient: "desk@hotel.example",
    subject: "Hello",
    body: "A pitch",
    hotelId: "d04a0000-0000-4000-8000-000000000030",
  };

  it("does not call Gmail when the kill switch is on, and records the failure", async () => {
    const fail = vi.fn(() => ({ result: "failed", call_provider: false, failure_code: "kill_switch", attempt_id: ATTEMPT }));
    const { deps, sends } = scripted({
      gmail_send_reserve: () => reserved,
      gmail_send_fail: fail,
    });
    deps.env = { nodeEnv: "production", disabled: "true" };
    const outcome = await sendGmailMessage(input, deps);
    expect(outcome).toMatchObject({ result: "failed", failureCode: "kill_switch" });
    expect(sends).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalled();
  });

  it("replays a sent key without calling Gmail", async () => {
    const { deps, sends, calls } = scripted({
      gmail_send_reserve: () => ({
        result: "sent",
        call_provider: false,
        attempt_id: ATTEMPT,
        event_id: "event-1",
        provider_message_id: "msg-1",
        provider_thread_id: "thread-1",
        binding_status: "pending_thread",
      }),
    });
    const outcome = await sendGmailMessage(input, deps);
    expect(outcome.result).toBe("sent");
    expect(sends).not.toHaveBeenCalled();
    expect(calls.map((call) => call.fn)).toEqual(["gmail_send_reserve"]);
  });

  it("sends once and commits the provider ids", async () => {
    const { deps, sends } = scripted({
      gmail_send_reserve: () => reserved,
      gmail_send_mark_provider: () => ({ result: "ok", call_provider: true, attempt_id: ATTEMPT, daily_cap: 20 }),
      gmail_send_commit: () => ({
        result: "sent",
        attempt_id: ATTEMPT,
        event_id: "event-1",
        provider_message_id: "msg-1",
        provider_thread_id: "thread-1",
        binding_status: "pending_thread",
      }),
    });
    const outcome = await sendGmailMessage(input, deps);
    expect(outcome).toMatchObject({
      result: "sent",
      providerMessageId: "msg-1",
      providerThreadId: "thread-1",
    });
    expect(sends).toHaveBeenCalledTimes(1);
  });

  it("records token revocation without calling Gmail", async () => {
    const { deps, sends } = scripted({
      gmail_send_reserve: () => reserved,
      gmail_send_mark_provider: () => ({ result: "ok", call_provider: true, attempt_id: ATTEMPT }),
      gmail_send_fail: () => ({
        result: "failed",
        attempt_id: ATTEMPT,
        failure_code: "token_revoked",
      }),
    });
    deps.getAccessToken = async () => ({ result: "reauth_required" });
    const outcome = await sendGmailMessage(input, deps);
    expect(outcome).toMatchObject({ result: "failed", failureCode: "token_revoked" });
    expect(sends).not.toHaveBeenCalled();
  });

  it("stores unknown when the provider call throws after it starts", async () => {
    const fail = vi.fn(() => ({ result: "unknown", attempt_id: ATTEMPT, failure_code: "unknown" }));
    const { deps, sends } = scripted({
      gmail_send_reserve: () => reserved,
      gmail_send_mark_provider: () => ({ result: "ok", call_provider: true, attempt_id: ATTEMPT }),
      gmail_send_fail: fail,
    });
    sends.mockRejectedValueOnce(new GoogleAdapterError("gmail_send_transport", false));
    const outcome = await sendGmailMessage(input, deps);
    expect(outcome).toMatchObject({ result: "unknown", attemptId: ATTEMPT });
    expect(fail).toHaveBeenCalled();
    const args = fail.mock.calls[0] as unknown as [Record<string, unknown>] | undefined;
    expect(args?.[0]?.p_code).toBe("unknown");
  });
});
