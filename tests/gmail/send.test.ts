/**
 * D04 send guard, MIME, the real adapter's test refusal, and the orchestration
 * around a scripted database. No test here opens a socket to Gmail.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GoogleAdapterError,
  googleOAuthAdapter,
  type GoogleOAuthAdapter,
} from "@/lib/gmail/google.server";
import { assessSendGuard, planCapsFromEnv, sendGuardFromProcess, spacingSeconds } from "@/lib/gmail/send/guard";
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

  it("uses a configured list outside production and when sending is open", () => {
    expect(
      assessSendGuard(
        {
          nodeEnv: "production",
          sendEnv: "production",
          allowlist: "one@example.com, two@example.com",
        },
        "TWO@example.com",
      ).ok,
    ).toBe(true);
    expect(
      assessSendGuard({ sendEnv: "production", allowlist: "one@example.com" }, "two@example.com"),
    ).toEqual({ ok: false, code: "allowlist" });
    expect(
      assessSendGuard({ nodeEnv: "development", allowlist: "one@example.com" }, "one@example.com")
        .ok,
    ).toBe(true);
  });

  it("allows any recipient only when GMAIL_SEND_ENV=production and the list is unset", () => {
    expect(assessSendGuard({ sendEnv: "production" }, "guest@hotel.example").ok).toBe(true);
    expect(
      assessSendGuard(
        { nodeEnv: "test", sendEnv: "production", allowlist: "  " },
        "guest@hotel.example",
      ).ok,
    ).toBe(true);
  });

  it("NODE_ENV=production without GMAIL_SEND_ENV still enforces the default allowlist", () => {
    const blocked = assessSendGuard({ nodeEnv: "production" }, "guest@hotel.example");
    expect(blocked).toEqual({ ok: false, code: "allowlist" });
    expect(assessSendGuard({ nodeEnv: "production" }, "hello@theugc.life").ok).toBe(true);
    expect(
      assessSendGuard(
        { nodeEnv: "production", allowlist: "  ", sendEnv: "" },
        "guest@hotel.example",
      ),
    ).toEqual({ ok: false, code: "allowlist" });
    expect(
      assessSendGuard({ nodeEnv: "production", sendEnv: "staging" }, "desk@hotel.example"),
    ).toEqual({ ok: false, code: "allowlist" });
    expect(
      assessSendGuard({ nodeEnv: "production", sendEnv: "Production" }, "desk@hotel.example"),
    ).toEqual({ ok: false, code: "allowlist" });
  });

  it("GMAIL_SEND_ENV=production opens sending only when the allowlist is unset", () => {
    expect(assessSendGuard({ sendEnv: "production" }, "guest@hotel.example").ok).toBe(true);
    expect(
      assessSendGuard({ nodeEnv: "development", sendEnv: "production" }, "desk@hotel.example").ok,
    ).toBe(true);
    expect(
      assessSendGuard({ nodeEnv: "production", sendEnv: " production " }, "desk@hotel.example").ok,
    ).toBe(true);
    expect(
      assessSendGuard(
        { sendEnv: "production", allowlist: "one@example.com" },
        "desk@hotel.example",
      ),
    ).toEqual({ ok: false, code: "allowlist" });
    expect(
      assessSendGuard({ sendEnv: "production", disabled: "true" }, "hello@theugc.life"),
    ).toEqual({ ok: false, code: "kill_switch" });
  });

  it("the kill switch wins over the allowlist", () => {
    for (const disabled of ["true", "1", "yes", " TRUE "]) {
      expect(
        assessSendGuard(
          { nodeEnv: "production", sendEnv: "production", disabled, allowlist: "" },
          "hello@theugc.life",
        ),
      ).toEqual({ ok: false, code: "kill_switch" });
    }
    expect(
      assessSendGuard({ sendEnv: "production", disabled: "false" }, "guest@hotel.example").ok,
    ).toBe(true);
    expect(
      assessSendGuard({ nodeEnv: "production", disabled: "no" }, "guest@hotel.example"),
    ).toEqual({
      ok: false,
      code: "allowlist",
    });
  });

  it("reads GMAIL_SEND_ENV from the process and does not treat NODE_ENV as production", () => {
    const bag = process.env as Record<string, string | undefined>;
    const previous = {
      NODE_ENV: bag.NODE_ENV,
      GMAIL_SEND_ENV: bag.GMAIL_SEND_ENV,
      GMAIL_SEND_ALLOWLIST: bag.GMAIL_SEND_ALLOWLIST,
      GMAIL_SEND_DISABLED: bag.GMAIL_SEND_DISABLED,
    };
    const restore = () => {
      for (const key of Object.keys(previous) as (keyof typeof previous)[]) {
        const value = previous[key];
        if (value === undefined) delete bag[key];
        else bag[key] = value;
      }
    };
    bag.NODE_ENV = "production";
    delete bag.GMAIL_SEND_ENV;
    delete bag.GMAIL_SEND_ALLOWLIST;
    delete bag.GMAIL_SEND_DISABLED;
    try {
      expect(assessSendGuard(sendGuardFromProcess(), "guest@hotel.example")).toEqual({
        ok: false,
        code: "allowlist",
      });
      expect(assessSendGuard(sendGuardFromProcess(), "hello@theugc.life").ok).toBe(true);
      bag.GMAIL_SEND_ENV = "production";
      expect(assessSendGuard(sendGuardFromProcess(), "guest@hotel.example").ok).toBe(true);
    } finally {
      restore();
    }
  });

  it("parses the soft daily caps and leaves clamping to the database", () => {
    expect(planCapsFromEnv(undefined)).toEqual({ pro: 120, max: 300 });
    expect(planCapsFromEnv({ proDailyCap: "", maxDailyCap: "nope" })).toEqual({ pro: 120, max: 300 });
    expect(planCapsFromEnv({ proDailyCap: "1000", maxDailyCap: "1" })).toEqual({ pro: 1000, max: 1 });
    expect(spacingSeconds(() => 0)).toBe(180);
    expect(spacingSeconds(() => 0.999)).toBe(300);
    expect(spacingSeconds(() => Number.NaN)).toBe(180);
  });
});

describe("plain message", () => {
  it("rejects a header break in from, to, or subject", () => {
    expect(() =>
      buildPlainMessage({
        from: "a@b.co\r\nBcc: x@y.co",
        to: "c@d.co",
        subject: "Hi",
        body: "Body",
      }),
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
    env: {
      nodeEnv: "production",
      sendEnv: "production",
      disabled: null,
      allowlist: null,
    },
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

  it("does not call Gmail when NODE_ENV is production and GMAIL_SEND_ENV is unset", async () => {
    const fail = vi.fn(() => ({
      result: "failed",
      call_provider: false,
      failure_code: "allowlist",
      attempt_id: ATTEMPT,
    }));
    const { deps, sends } = scripted({
      gmail_send_reserve: () => reserved,
      gmail_send_fail: fail,
    });
    deps.env = { nodeEnv: "production", sendEnv: null, disabled: null, allowlist: null };
    const outcome = await sendGmailMessage(input, deps);
    expect(outcome).toMatchObject({ result: "failed", failureCode: "allowlist" });
    expect(sends).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalled();
  });

  it("does not call Gmail when the kill switch is on, and records the failure", async () => {
    const fail = vi.fn(() => ({
      result: "failed",
      call_provider: false,
      failure_code: "kill_switch",
      attempt_id: ATTEMPT,
    }));
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

  it("leaves a queued send for the dispatcher and does not call Gmail", async () => {
    const { deps, sends, calls } = scripted({
      gmail_send_reserve: () => ({
        result: "queued",
        call_provider: false,
        attempt_id: ATTEMPT,
      }),
    });
    const outcome = await sendGmailMessage(input, deps);
    expect(outcome).toMatchObject({ result: "queued", attemptId: ATTEMPT });
    expect(sends).not.toHaveBeenCalled();
    expect(calls.map((call) => call.fn)).toEqual(["gmail_send_reserve"]);
  });

  it("sends once and commits the provider ids", async () => {
    const { deps, sends } = scripted({
      gmail_send_reserve: () => reserved,
      gmail_send_mark_provider: () => ({
        result: "ok",
        call_provider: true,
        attempt_id: ATTEMPT,
        daily_cap: 20,
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
