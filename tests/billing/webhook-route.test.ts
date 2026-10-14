/**
 * Rebill webhook (D138). A bad signature never applies. The account is not
 * read from the body. Payment status comes from the confirm GET, not the body.
 * The old x-billing-secret header does not authorize.
 */
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleRebillWebhook, type WebhookDeps } from "@/lib/billing/rebill-webhook";
import { rebillSignatureValid } from "@/lib/billing/rebill-signature";
import { secretMatches } from "@/lib/billing/webhook-auth";

const SIGNING = "whsec_test_signing_secret";

function sign(body: string, secret = SIGNING): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function request(body: string, signature?: string, extra?: Record<string, string>) {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== undefined) headers.set("x-rebill-signature", signature);
  for (const [key, value] of Object.entries(extra ?? {})) headers.set(key, value);
  return new Request("http://localhost/api/billing/webhook", {
    method: "POST",
    headers,
    body,
  });
}

const envelope = {
  webhook: { id: "we_1", event: "payment.created", logId: "log_payment_1" },
  data: {
    payment: {
      id: "pay_body",
      status: "approved",
      amount: 1,
      currency: "EUR",
      metadata: { checkoutId: "33333333-3333-4333-8333-333333333333", userId: "forged" },
    },
    paymentLinkId: "pl_body",
    subscriptionId: "sub_body",
    userId: "22222222-2222-4222-8222-222222222222",
  },
};

function deps(overrides: Partial<WebhookDeps> = {}): WebhookDeps & { applied: unknown[] } {
  const applied: unknown[] = [];
  return {
    applied,
    env: { secretKey: "sk_test", signingSecret: SIGNING, live: false },
    fetchImpl: vi.fn(async () =>
      Response.json({
        id: "pay_body",
        status: "rejected",
        amount: 30,
        currency: "USD",
        subscriptionId: "sub_confirmed",
        metadata: { checkoutId: "33333333-3333-4333-8333-333333333333" },
      }),
    ) as unknown as typeof fetch,
    apply: async (event) => {
      applied.push(event);
      return { result: "applied" };
    },
    ...overrides,
  };
}

describe("rebill webhook signature", () => {
  it("rejects a missing, unset, odd, or wrong signature", () => {
    const raw = new TextEncoder().encode("{}");
    expect(rebillSignatureValid(raw, null, SIGNING)).toBe(false);
    expect(rebillSignatureValid(raw, sign("{}"), undefined)).toBe(false);
    expect(rebillSignatureValid(raw, "abc", SIGNING)).toBe(false);
    expect(rebillSignatureValid(raw, sign("{}", "other"), SIGNING)).toBe(false);
    expect(rebillSignatureValid(raw, sign("{}").slice(0, -1) + "0", SIGNING)).toBe(false);
    expect(rebillSignatureValid(raw, sign("{}"), SIGNING)).toBe(true);
    expect(rebillSignatureValid(raw, sign("{}").toUpperCase(), SIGNING)).toBe(true);
  });

  it("does not treat the retired billing secret as a signature", () => {
    expect(secretMatches("s3cret-value", "s3cret-value")).toBe(true);
    expect(rebillSignatureValid(new Uint8Array(), "s3cret-value", SIGNING)).toBe(false);
  });
});

describe("rebill webhook handler", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("401 before apply when the signature is missing, wrong, or the secret is unset", async () => {
    const body = JSON.stringify(envelope);
    for (const [signature, secret] of [
      [undefined, SIGNING],
      ["", SIGNING],
      [sign(body, "nope"), SIGNING],
      [sign(body), undefined],
    ] as const) {
      const d = deps({
        env: { secretKey: "sk_test", signingSecret: secret, live: false },
      });
      const res = await handleRebillWebhook(request(body, signature), d);
      expect(res.status).toBe(401);
      expect(d.applied).toHaveLength(0);
    }
  });

  it("ignores x-billing-secret and does not pass a body user id", async () => {
    const body = JSON.stringify(envelope);
    const d = deps();
    const res = await handleRebillWebhook(
      request(body, sign(body), { "x-billing-secret": "s3cret-value" }),
      d,
    );
    expect(res.status).toBe(200);
    expect(d.applied).toHaveLength(1);
    const event = d.applied[0] as {
      payment: Record<string, unknown>;
      userId?: unknown;
    };
    expect(JSON.stringify(event)).not.toMatch(/forged|22222222/);
    expect(event.userId).toBeUndefined();
    expect(event.payment).toMatchObject({
      id: "pay_body",
      status: "rejected",
      amount: 30,
      currency: "USD",
      checkoutId: "33333333-3333-4333-8333-333333333333",
      subscriptionId: "sub_confirmed",
    });
  });

  it("refuses a checkout id that disagrees with the confirmed payment", async () => {
    const mismatched = {
      ...envelope,
      data: {
        ...envelope.data,
        payment: {
          ...envelope.data.payment,
          metadata: { checkoutId: "11111111-1111-4111-8111-111111111111" },
        },
      },
    };
    const body = JSON.stringify(mismatched);
    const mismatch = deps();
    const bad = await handleRebillWebhook(request(body, sign(body)), mismatch);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "checkout_mismatch" });
    expect(mismatch.applied).toHaveLength(0);
  });

  it("does not confirm a payment when the API key is missing, and records ignored events", async () => {
    const payment = JSON.stringify(envelope);
    const unpaid = deps({
      env: { signingSecret: SIGNING, live: false },
    });
    const denied = await handleRebillWebhook(request(payment, sign(payment)), unpaid);
    expect(denied.status).toBe(503);
    expect(unpaid.applied).toHaveLength(0);

    const ignoredBody = JSON.stringify({
      webhook: { event: "subscription.renewal_soon", logId: "log_soon" },
      data: { userId: "forged" },
    });
    const ignored = deps({ env: { signingSecret: SIGNING, live: false } });
    const res = await handleRebillWebhook(request(ignoredBody, sign(ignoredBody)), ignored);
    expect(res.status).toBe(200);
    expect(ignored.applied).toEqual([{ logId: "log_soon", event: "subscription.renewal_soon" }]);
  });

  it("returns 400 when apply says the event is invalid, and 503 when confirm fails", async () => {
    const body = JSON.stringify(envelope);
    const invalid = deps({
      apply: async () => ({ result: "invalid" }),
    });
    expect((await handleRebillWebhook(request(body, sign(body)), invalid)).status).toBe(400);

    const down = deps({
      fetchImpl: vi.fn(async () => new Response("no", { status: 500 })) as unknown as typeof fetch,
    });
    const res = await handleRebillWebhook(request(body, sign(body)), down);
    expect(res.status).toBe(503);
    expect(down.applied).toHaveLength(0);
  });
});
