/**
 * D09 share-link display. Unknown is not zero. A banned key is not rendered.
 */
import { describe, expect, it } from "vitest";

import {
  consumeShareLinkRequest,
  resetShareLinkRateLimit,
  shareLinkClientKey,
} from "@/lib/profile/share-rate-limit";
import {
  formatSelfReportedEngagement,
  formatSelfReportedFollowers,
  mapPublicShare,
  parseEngagement,
  parseFollowerCount,
  parseShareExpiry,
} from "@/lib/profile/share-contract";

describe("self-reported audience", () => {
  it("renders null as unknown and keeps a recorded zero", () => {
    expect(formatSelfReportedFollowers(null)).toBe("Unknown");
    expect(formatSelfReportedFollowers(0)).toBe("0");
    expect(formatSelfReportedEngagement(null)).toBe("Unknown");
    expect(formatSelfReportedEngagement("")).toBe("Unknown");
    expect(formatSelfReportedEngagement("about 3 percent")).toBe("about 3 percent");
  });

  it("does not turn a blank follower box into zero", () => {
    expect(parseFollowerCount("")).toEqual({ ok: true, value: null });
    expect(parseFollowerCount("0")).toEqual({ ok: true, value: 0 });
    expect(parseFollowerCount("00").ok).toBe(false);
    expect(parseFollowerCount("-1").ok).toBe(false);
    expect(parseEngagement("")).toEqual({ ok: true, value: null });
  });
});

describe("public share payload", () => {
  it("rejects a payload that carries an email, a note, or a verified audience", () => {
    expect(
      mapPublicShare({ result: "ok", profile: { bio: "Hi", email: "a@test.local" } }).status,
    ).toBe("error");
    expect(
      mapPublicShare({
        result: "ok",
        profile: {
          audience: { followers: null, engagement: null, attribution: "verified" },
        },
      }).status,
    ).toBe("error");
    expect(
      mapPublicShare({
        result: "ok",
        profile: {
          past_collaborations: [
            {
              hotel_name: "Reef",
              status: "completed",
              collaboration_type: "stay",
              start_date: null,
              end_date: null,
              private_notes: "secret",
            },
          ],
        },
      }).status,
    ).toBe("error");
  });

  it("shows unknown compensation and unpaid without a zero", () => {
    const unknown = mapPublicShare({
      result: "ok",
      profile: {
        past_collaborations: [
          {
            hotel_name: "Reef",
            status: "completed",
            collaboration_type: null,
            start_date: null,
            end_date: null,
            compensation: { structure: "unknown" },
          },
        ],
      },
    });
    expect(unknown.status).toBe("ok");
    if (unknown.status !== "ok") return;
    expect(unknown.view.collaborations?.[0]?.compensation).toBe("Unknown");
    expect(unknown.view.collaborations?.[0]?.typeLabel).toBe("Unknown");

    const unpaid = mapPublicShare({
      result: "ok",
      profile: {
        past_collaborations: [
          {
            hotel_name: "Reef",
            status: "cancelled",
            collaboration_type: "stay",
            start_date: null,
            end_date: "2026-04-02",
            compensation: { structure: "unpaid" },
          },
        ],
      },
    });
    expect(unpaid.status).toBe("ok");
    if (unpaid.status !== "ok") return;
    expect(unpaid.view.collaborations?.[0]?.compensation).toBe("Unpaid");
    expect(JSON.stringify(unpaid.view)).not.toMatch(/0\.00|"0"/);
  });

  it("treats not_found as an empty object with no profile", () => {
    expect(mapPublicShare({ result: "not_found" })).toEqual({ status: "not_found" });
    expect(mapPublicShare({ result: "not_found", profile: {} }).status).toBe("error");
  });
});

describe("share expiry", () => {
  it("treats a blank expiry as no expiry and rejects a past date", () => {
    const now = Date.parse("2026-10-13T12:00:00.000Z");
    expect(parseShareExpiry("", now)).toEqual({ ok: true, expiresAt: null });
    expect(parseShareExpiry("2026-10-12", now).ok).toBe(false);
    expect(parseShareExpiry("2026-02-31", now).ok).toBe(false);
    expect(parseShareExpiry("2026-10-13", now)).toEqual({
      ok: true,
      expiresAt: "2026-10-13T23:59:59.999Z",
    });
  });
});

describe("share link rate limit", () => {
  it("stops the 31st request in the window without using the token as the key", () => {
    resetShareLinkRateLimit();
    expect(shareLinkClientKey(null)).toBe("unknown");
    expect(shareLinkClientKey("  ")).toBe("unknown");
    const key = shareLinkClientKey("203.0.113.5");
    expect(key).toBe("203.0.113.5");
    for (let i = 0; i < 30; i += 1) {
      expect(consumeShareLinkRequest(key, 1_000).allowed).toBe(true);
    }
    const blocked = consumeShareLinkRequest(key, 1_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(consumeShareLinkRequest("203.0.113.9", 1_000).allowed).toBe(true);
  });
});
