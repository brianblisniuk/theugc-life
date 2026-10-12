/**
 * E05 redaction, health, and security headers. No vendor and no private payload.
 */
import { describe, expect, it } from "vitest";

import { healthPayload } from "@/lib/http/health";
import {
  contentSecurityPolicy,
  REFERRER_POLICY,
  securityHeaders,
} from "@/lib/http/security-headers";
import { gmailListSurface, mailboxFromProbe } from "@/lib/gmail/sync-surface";
import { logger } from "@/lib/logger";
import { redactPath, redactString } from "@/lib/log/redact";
import { normalizeRequestId, requestLogLine } from "@/lib/log/request";
import { billingAccessState } from "@/lib/billing/view";
import { pipelineListState } from "@/lib/pipeline/view";
import { inboxListState } from "@/lib/surfaces/lists";
import {
  DISCOVER_LIST_COPY,
  PROFILE_LIST_COPY,
  REVOKED_INBOX_COPY,
  SYNC_ERROR_INBOX_COPY,
  TRIP_LIST_COPY,
  discoverListOutcome,
  tripListOutcome,
} from "@/lib/surfaces/list-outcome";

const SHARE_TOKEN = "ab".repeat(32);
const AUTH = "11111111-1111-1111-1111-111111111111";

describe("log redaction", () => {
  it("strips emails, tokens, message bodies, and share tokens", () => {
    const redacted = logger._redact({
      userId: "u1",
      email: "creator@hotel.test",
      share_token: SHARE_TOKEN,
      shareToken: "shown-once",
      message_body: "Meet at the hotel tomorrow",
      snippet: "quoted mail",
      access_token: "tok-live",
      detail: `reply to creator@hotel.test about /p/${SHARE_TOKEN} Bearer raw-token`,
      authorization: "Bearer another",
    }) as Record<string, unknown>;

    const packed = JSON.stringify(redacted);
    expect(redacted.userId).toBe("u1");
    expect(redacted.email).toBe("[redacted]");
    expect(redacted.share_token).toBe("[redacted]");
    expect(redacted.shareToken).toBe("[redacted]");
    expect(redacted.message_body).toBe("[redacted]");
    expect(redacted.snippet).toBe("[redacted]");
    expect(redacted.access_token).toBe("[redacted]");
    expect(redacted.authorization).toBe("[redacted]");
    expect(packed).not.toContain("creator@hotel.test");
    expect(packed).not.toContain(SHARE_TOKEN);
    expect(packed).not.toContain("Meet at the hotel");
    expect(packed).not.toContain("quoted mail");
    expect(packed).not.toContain("raw-token");
    expect(packed).not.toContain("tok-live");
  });

  it("redacts a share path and does not keep the query string", () => {
    expect(redactPath(`/p/${SHARE_TOKEN}?x=1`)).toBe("/p/[redacted]");
    expect(redactString(`see /p/${SHARE_TOKEN}`)).not.toContain(SHARE_TOKEN);
  });

  it("puts a request id on the log line and does not log the share token", () => {
    const id = normalizeRequestId(null);
    const line = requestLogLine({
      requestId: id,
      method: "GET",
      path: `/p/${SHARE_TOKEN}?token=${SHARE_TOKEN}`,
    });
    expect(line).toContain(id);
    expect(line).not.toContain(SHARE_TOKEN);
    expect(line).toContain("/p/[redacted]");
  });
});

describe("health", () => {
  it("returns status ok and no other fields", () => {
    expect(healthPayload()).toEqual({ status: "ok" });
    expect(Object.keys(healthPayload())).toEqual(["status"]);
  });
});

describe("security headers", () => {
  it("allows Maps origins, denies framing, and sets referrer-policy", () => {
    const headers = securityHeaders("http://127.0.0.1:54321");
    const csp = headers["Content-Security-Policy"] ?? "";
    expect(csp).toContain("https://maps.googleapis.com");
    expect(csp).toContain("https://maps.gstatic.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("http://127.0.0.1:54321");
    expect(csp).toContain("ws://127.0.0.1:54321");
    expect(headers["Referrer-Policy"]).toBe(REFERRER_POLICY);
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(contentSecurityPolicy("not a url")).not.toContain("not a url");
  });
});

describe("gmail sync surface", () => {
  it("shows a revoked token as an error, not an empty inbox", () => {
    const surface = gmailListSurface({ mailbox: "revoked", linkCount: 0, readFailed: false });
    expect(surface).toEqual({ kind: "error", reason: "revoked" });
    expect(gmailListSurface({ mailbox: "revoked", linkCount: 0, readFailed: false })).toEqual(
      surface,
    );
    const state = inboxListState({
      failed: false,
      identityFailed: false,
      total: 0,
      rawRows: [],
      viewerId: AUTH,
      authUserId: AUTH,
      mailbox: "revoked",
    });
    expect(state.kind).toBe("error");
    if (state.kind !== "error") return;
    expect(state.title).toBe(REVOKED_INBOX_COPY.title);
    expect(state.body).toContain("not an empty inbox");
    expect(state.body).not.toContain("No inbox links yet");
  });

  it("shows a sync failure as an error, and a second classification does not change it", () => {
    const once = gmailListSurface({ mailbox: "sync_error", linkCount: 0, readFailed: false });
    const twice = gmailListSurface({ mailbox: "sync_error", linkCount: 0, readFailed: false });
    expect(once).toEqual({ kind: "error", reason: "sync" });
    expect(twice).toEqual(once);
    const state = inboxListState({
      failed: false,
      identityFailed: false,
      total: 0,
      rawRows: [],
      viewerId: AUTH,
      authUserId: AUTH,
      mailbox: "sync_error",
    });
    expect(state.kind).toBe("error");
    if (state.kind !== "error") return;
    expect(state).toMatchObject(SYNC_ERROR_INBOX_COPY);
  });

  it("keeps a connected mailbox with no links empty, and a missing deployment unconfigured", () => {
    expect(gmailListSurface({ mailbox: "connected", linkCount: 0, readFailed: false }).kind).toBe(
      "empty",
    );
    expect(
      mailboxFromProbe({
        configured: false,
        authUserId: AUTH,
        failed: false,
        data: [],
      }),
    ).toBe("unconfigured");
    expect(
      mailboxFromProbe({
        configured: true,
        authUserId: AUTH,
        failed: false,
        data: [{ user_id: AUTH, connection_state: "reauth_required" }],
      }),
    ).toBe("revoked");
  });
});

describe("empty versus error on every list", () => {
  it("trips, discover, pipeline, billing, and profile do not share a title", () => {
    expect(tripListOutcome({ failed: true, count: 0 })).toBe("error");
    expect(tripListOutcome({ failed: false, count: 0 })).toBe("empty");
    expect(TRIP_LIST_COPY.errorTitle).not.toBe(TRIP_LIST_COPY.emptyTitle);

    expect(discoverListOutcome({ failed: true, count: 0, filtered: false, page: 1 })).toBe("error");
    expect(discoverListOutcome({ failed: false, count: 0, filtered: false, page: 1 })).toBe(
      "empty",
    );
    expect(discoverListOutcome({ failed: false, count: 0, filtered: true, page: 1 })).toBe(
      "filtered_empty",
    );
    expect(DISCOVER_LIST_COPY.errorTitle).not.toBe(DISCOVER_LIST_COPY.emptyTitle);

    const pipelineError = pipelineListState({ failed: true, page: null, status: null });
    const pipelineEmpty = pipelineListState({
      failed: false,
      page: {
        items: [],
        total: 0,
        page: 1,
        pageSize: 50,
        totalPages: 0,
        hasPrevious: false,
        hasNext: false,
      },
      status: null,
    });
    expect(pipelineError.kind).toBe("error");
    expect(pipelineEmpty.kind).toBe("empty");
    if (pipelineError.kind === "error" && pipelineEmpty.kind === "empty") {
      expect(pipelineError.title).not.toBe(pipelineEmpty.title);
    }

    const billingError = billingAccessState({ status: "error" });
    const billingEmpty = billingAccessState({ status: "ok", entitlements: [] });
    expect(billingError.kind).toBe("error");
    expect(billingEmpty.kind).toBe("free");
    if (billingError.kind === "error" && billingEmpty.kind === "free") {
      expect(billingError.title).not.toBe(billingEmpty.title);
    }

    expect(PROFILE_LIST_COPY.error).toContain("not an empty profile");
    expect(PROFILE_LIST_COPY.shareError).toContain("not an empty share link");
  });
});
