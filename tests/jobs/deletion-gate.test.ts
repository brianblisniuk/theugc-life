/**
 * A pending deletion does not start Google and does not send mail.
 * Gmail and Claude are stubs. No socket is opened.
 */
import { randomBytes } from "node:crypto";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { startGmailAuthorization, type GmailDeps } from "@/lib/gmail/connection.server";
import { gmailConnectionOffered } from "@/lib/gmail/panel-actions";
import type { GoogleOAuthAdapter } from "@/lib/gmail/google.server";
import { sendGmailMessage, type SendDeps } from "@/lib/gmail/send/service.server";
import { runAccountSync, type SyncDeps } from "@/lib/gmail/sync/worker";

const USER = "d1780000-0000-4000-8000-0000000000a1";
const MAIL = "d1780000-0000-4000-8000-0000000000a2";

beforeAll(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-client-secret";
  process.env.GOOGLE_OAUTH_REDIRECT_URI =
    "https://example.invalid/api/integrations/gmail/oauth/callback";
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY_V1 = randomBytes(32).toString("base64");
});

describe("deletion gate", () => {
  it("hides connect and reconnect while deletion is pending", () => {
    expect(gmailConnectionOffered(true)).toBe(false);
    expect(gmailConnectionOffered(false)).toBe(true);
  });

  it("does not build a Google URL when oauth begin refuses", async () => {
    const buildAuthorizationUrl = vi.fn(() => "https://accounts.google.com/o/oauth2/v2/auth");
    const deps = {
      google: { buildAuthorizationUrl } as unknown as GoogleOAuthAdapter,
      db: {
        rpc: async () => ({ data: { result: "deletion_pending" }, error: null }),
      },
    } as unknown as GmailDeps;
    const started = await startGmailAuthorization({ userId: USER, purpose: "connect" }, deps);
    expect(started).toEqual({ result: "deletion_pending" });
    expect(buildAuthorizationUrl).not.toHaveBeenCalled();
  });

  it("does not call Gmail when reserve returns deletion_pending", async () => {
    const sendMessage = vi.fn();
    const deps = {
      google: { sendMessage } as unknown as GoogleOAuthAdapter,
      env: { nodeEnv: "test", sendEnv: null, disabled: null, allowlist: null },
      getAccessToken: async () => ({ result: "ok", accessToken: "token" }),
      db: {
        rpc: async () => ({
          data: { result: "deletion_pending", call_provider: false },
          error: null,
        }),
      },
    } as unknown as SendDeps;
    const outcome = await sendGmailMessage(
      {
        userId: USER,
        mailAccountId: MAIL,
        idempotencyKey: "deletion-key-000001",
        kind: "pitch",
        recipient: "desk@hotel.example",
        subject: "Hello",
        body: "A pitch",
        hotelId: "d1780000-0000-4000-8000-0000000000a3",
      },
      deps,
    );
    expect(outcome).toEqual({
      result: "failed",
      attemptId: null,
      failureCode: "deletion_pending",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("stops a sync before any Gmail read when the claim is deletion_pending", async () => {
    const read = vi.fn();
    const deps = {
      db: {
        rpc: async () => ({ data: { result: "deletion_pending" }, error: null }),
      },
      gmail: new Proxy(
        {},
        {
          get() {
            return read;
          },
        },
      ),
      accessToken: async () => ({ result: "ok", accessToken: "token" }),
      sleep: async () => undefined,
      random: () => 0,
      maxSteps: 3,
      leaseSeconds: 60,
      runPipeline: async () => undefined,
    } as unknown as SyncDeps;
    const outcome = await runAccountSync({ userId: USER, mailAccountId: MAIL }, deps);
    expect(outcome.result).toBe("deletion_pending");
    expect(outcome.gmailCalls).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });
});
