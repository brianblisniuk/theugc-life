/**
 * Rebill webhook (D138). A bad signature never applies. The account is not
 * read from the body. Payment status comes from the confirm GET, not the body.
 * The old x-billing-secret header does not authorize.
 */
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readWebhookEnvelope } from "@/lib/billing/rebill-confirm";
import {
  applyResultFromRpc,
  handleRebillWebhook,
  rebillWebhookHttpStatus,
  type WebhookDeps,
} from "@/lib/billing/rebill-webhook";
import { rebillSignatureValid } from "@/lib/billing/rebill-signature";

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
    const short = "short-secret";
    expect(short.length).toBeLessThan(16);
    expect(rebillSignatureValid(raw, sign("{}", short), short)).toBe(false);
  });

  it("does not treat the retired billing secret as a signature", () => {
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
      paymentLinkId: null,
      subscriptionId: "sub_confirmed",
    });
  });

  it("prefers the confirmed checkout id and does not fall back to the body", async () => {
    const body = JSON.stringify(envelope);
    const d = deps({
      fetchImpl: vi.fn(async () =>
        Response.json({
          id: "pay_body",
          status: "approved",
          amount: 30,
          currency: "USD",
        }),
      ) as unknown as typeof fetch,
    });
    const res = await handleRebillWebhook(request(body, sign(body)), d);
    expect(res.status).toBe(200);
    const event = d.applied[0] as { payment: Record<string, unknown> };
    expect(event.payment.checkoutId).toBeNull();
    expect(event.payment.paymentLinkId).toBeNull();
    expect(event.payment.subscriptionId).toBeNull();
    expect(JSON.stringify(event)).not.toMatch(/33333333|pl_body|sub_body|forged/);
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

  it("returns 503 when apply errors so Rebill retries, and 200 for a finished result", async () => {
    const body = JSON.stringify(envelope);
    expect(rebillWebhookHttpStatus("applied")).toBe(200);
    expect(rebillWebhookHttpStatus("duplicate")).toBe(200);
    expect(rebillWebhookHttpStatus("ignored")).toBe(200);
    expect(rebillWebhookHttpStatus("revoked")).toBe(200);
    expect(rebillWebhookHttpStatus("deletion_pending")).toBe(200);
    expect(rebillWebhookHttpStatus("invalid")).toBe(400);
    expect(rebillWebhookHttpStatus("error")).toBe(503);
    expect(rebillWebhookHttpStatus(undefined)).toBe(503);

    for (const result of ["applied", "duplicate", "ignored", "revoked"] as const) {
      const d = deps({
        apply: async () => ({ result }),
      });
      const res = await handleRebillWebhook(request(body, sign(body)), d);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ result });
    }

    const errored = deps({
      apply: async () => ({ result: "error" }),
    });
    const bad = await handleRebillWebhook(request(body, sign(body)), errored);
    expect(bad.status).toBe(503);
    expect(await bad.json()).toEqual({ result: "error" });

    const thrown = deps({
      apply: async () => {
        throw new Error("apply_rebill_event failed");
      },
    });
    const down = await handleRebillWebhook(request(body, sign(body)), thrown);
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ result: "error" });

    const ignoredBody = JSON.stringify({
      webhook: { event: "payment.available", logId: "log_available_err" },
      data: {},
    });
    const ignoredError = deps({
      apply: async () => ({ result: "error" }),
    });
    const ignored = await handleRebillWebhook(
      request(ignoredBody, sign(ignoredBody)),
      ignoredError,
    );
    expect(ignored.status).toBe(503);
    expect(await ignored.json()).toEqual({ result: "error" });

    expect(applyResultFromRpc(null, { message: "db down" })).toEqual({ result: "error" });
    expect(applyResultFromRpc({ result: "applied" }, null)).toEqual({ result: "applied" });
    expect(applyResultFromRpc({ result: 1 }, null)).toEqual({ result: "error" });
  });

  it("accepts payment.updated with data.id and data.status, and grants from the confirm GET", async () => {
    const body = JSON.stringify({
      webhook: { event: "payment.updated", logId: "log_flat_pay" },
      data: {
        id: "pay_flat1",
        status: "approved",
        amount: 1,
        currency: "EUR",
        userId: "forged-user",
      },
    });
    const fetched: string[] = [];
    const d = deps({
      fetchImpl: vi.fn(async (input: string | URL | Request) => {
        fetched.push(String(input));
        return Response.json({
          id: "pay_flat1",
          status: "refunded",
          amount: 30,
          currency: "USD",
        });
      }) as unknown as typeof fetch,
    });
    const res = await handleRebillWebhook(request(body, sign(body)), d);
    expect(res.status).toBe(200);
    expect(fetched.some((url) => url.endsWith("/payments/pay_flat1"))).toBe(true);
    const event = d.applied[0] as { payment: Record<string, unknown> };
    expect(event.payment).toMatchObject({
      id: "pay_flat1",
      status: "refunded",
      amount: 30,
      currency: "USD",
    });
    expect(JSON.stringify(event)).not.toContain("forged-user");
    expect(JSON.stringify(event)).not.toContain('"approved"');

    const missingStatus = JSON.stringify({
      webhook: { event: "payment.updated", logId: "log_flat_nostatus" },
      data: { id: "pay_flat2" },
    });
    const refused = deps();
    const missing = await handleRebillWebhook(request(missingStatus, sign(missingStatus)), refused);
    expect(missing.status).toBe(400);
    expect(refused.applied).toHaveLength(0);
    expect(
      readWebhookEnvelope({
        webhook: { event: "payment.updated", logId: "log_nested" },
        data: { id: "pay_ignored", status: "approved", payment: { id: "pay_nested" } },
      })?.paymentId,
    ).toBe("pay_nested");
  });
});
