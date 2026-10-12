/**
 * Billing webhook STUB (PR #43): authentication and event gating.
 * Negative controls: replacing `secretMatches` with `true`, or removing the
 * event allowlist, makes the 401 / unsupported_event tests fail; the grant
 * mocks record any call, so "never grants" is asserted directly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const env = { BILLING_WEBHOOK_SECRET: undefined as string | undefined };
const grantDestinationPass = vi.fn();
const grantPro = vi.fn();

vi.mock("@/lib/env.server", () => ({ serverEnv: () => env }));
vi.mock("@/lib/billing/grant", () => ({
  grantDestinationPass: (...a: unknown[]) => grantDestinationPass(...a),
  grantPro: (...a: unknown[]) => grantPro(...a),
}));

const { POST } = await import("@/app/api/billing/webhook/route");
const { secretMatches } = await import("@/lib/billing/webhook-auth");

const USER = "11111111-1111-1111-1111-111111111111";
const good = {
  event: "entitlement.grant",
  user_id: USER,
  product: "pro",
  source_reference: "ref-1",
};

function req(body: unknown, secret?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (secret !== undefined) headers.set("x-billing-secret", secret);
  return new Request("http://localhost/api/billing/webhook", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  env.BILLING_WEBHOOK_SECRET = "s3cret-value";
  grantDestinationPass.mockReset();
  grantPro.mockReset().mockResolvedValue({ result: "granted", entitlementId: "e1" });
});

describe("billing webhook stub — authentication", () => {
  it("401 when the secret is unset, even if the caller sends an empty or any header", async () => {
    env.BILLING_WEBHOOK_SECRET = undefined;
    for (const h of [undefined, "", "anything"]) {
      expect((await POST(req(good, h))).status).toBe(401);
    }
    expect(grantPro).not.toHaveBeenCalled();
  });

  it("401 when the header is missing", async () => {
    expect((await POST(req(good))).status).toBe(401);
    expect(grantPro).not.toHaveBeenCalled();
  });

  it("401 for a wrong secret, a prefix, and a longer value", async () => {
    for (const h of ["wrong", "s3cret", "s3cret-value-extra", "S3CRET-VALUE"]) {
      expect((await POST(req(good, h))).status).toBe(401);
    }
    expect(grantPro).not.toHaveBeenCalled();
  });

  it("200 with the right secret (positive control)", async () => {
    const res = await POST(req(good, "s3cret-value"));
    expect(res.status).toBe(200);
    expect(grantPro).toHaveBeenCalledWith(USER, "ref-1");
  });
});

describe("billing webhook stub — event allowlist and input", () => {
  it("rejects a missing, unknown or non-string event without granting", async () => {
    for (const event of [undefined, "payment.refunded", "", 1, ["entitlement.grant"]]) {
      const res = await POST(req({ ...good, event }, "s3cret-value"));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "unsupported_event" });
    }
    expect(grantPro).not.toHaveBeenCalled();
  });

  it("rejects non-string ids and unknown products", async () => {
    expect((await POST(req({ ...good, user_id: 123 }, "s3cret-value"))).status).toBe(400);
    expect((await POST(req({ ...good, product: "lifetime" }, "s3cret-value"))).status).toBe(400);
    expect((await POST(req({ ...good, product: "destination_pass" }, "s3cret-value"))).status).toBe(
      400,
    );
    expect(grantPro).not.toHaveBeenCalled();
    expect(grantDestinationPass).not.toHaveBeenCalled();
  });

  it("maps a reference conflict to 409 without an entitlement id", async () => {
    grantPro.mockResolvedValue({ result: "source_reference_conflict" });
    const res = await POST(req(good, "s3cret-value"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ result: "source_reference_conflict" });
  });
});

describe("secretMatches", () => {
  it("is false for unset expected, null provided, or any mismatch (length-safe)", () => {
    expect(secretMatches("x", undefined)).toBe(false);
    expect(secretMatches("x", "")).toBe(false);
    expect(secretMatches(null, "x")).toBe(false);
    expect(secretMatches("a", "a".repeat(1000))).toBe(false);
    expect(secretMatches("abc", "abc")).toBe(true);
  });
});
