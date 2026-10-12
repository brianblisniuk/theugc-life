/**
 * D078 form validation. Unknown is not a number, amounts are non-negative
 * minor units, and a proof link is https only.
 */
import { describe, expect, it } from "vitest";

import {
  parseCompensationForm,
  parseDeliverableForm,
  parseWorkspacePayload,
} from "@/lib/collaboration/contract";
import { attributedValueLabel, formatMinor, valuationLabel } from "@/lib/collaboration/display";
import { majorToMinor } from "@/lib/collaboration/currencies";

describe("D078 compensation input", () => {
  it("rejects a negative cash amount and an unknown currency", () => {
    expect(majorToMinor("-1", "USD").ok).toBe(false);
    expect(majorToMinor("10.555", "USD").ok).toBe(false);
    expect(majorToMinor("10.5", "JPY").ok).toBe(false);
    expect(majorToMinor("10.50", "USD")).toEqual({ ok: true, minor: 1050 });
    expect(majorToMinor("0", "USD")).toEqual({ ok: true, minor: 0 });

    const badCurrency = parseCompensationForm({
      structure: "paid",
      cashAmount: "10",
      cashCurrency: "ZZZ",
      paymentStatus: "pending",
    });
    expect(badCurrency.ok).toBe(false);

    const negative = parseCompensationForm({
      structure: "paid",
      cashAmount: "-5",
      cashCurrency: "USD",
      paymentStatus: "pending",
    });
    expect(negative.ok).toBe(false);
  });

  it("rejects http and javascript proof URLs", () => {
    const http = parseDeliverableForm({
      deliverableType: "reel",
      quantity: "1",
      status: "pending",
      proofUrl: "http://example.com/proof",
    });
    expect(http.ok).toBe(false);
    const script = parseDeliverableForm({
      deliverableType: "reel",
      quantity: "1",
      status: "pending",
      proofUrl: "javascript:alert(1)",
    });
    expect(script.ok).toBe(false);
    const ok = parseDeliverableForm({
      deliverableType: "reel",
      quantity: "2",
      status: "submitted",
      proofUrl: "https://example.com/proof/1",
    });
    expect(ok.ok).toBe(true);
  });

  it("does not render unknown as zero", () => {
    expect(formatMinor(null, "USD")).toBe("Unknown");
    expect(formatMinor(null, null)).toBe("Unknown");
    expect(formatMinor(0, "USD")).toBe("0.00 USD");
    expect(
      attributedValueLabel({
        kind: "unknown",
        label: "unknown",
        basis: "unknown",
        amount_minor: null,
        currency: null,
      }),
    ).toBe("Unknown");
    expect(
      valuationLabel({
        kind: "unknown",
        label: "unknown",
        reason: "structure_unknown",
        currency: null,
        total_minor: null,
      }),
    ).toBe("Unknown");
  });

  it("refuses a read payload that stores unknown as zero", () => {
    const payload = parseWorkspacePayload({
      result: "ok",
      compensation: {
        authority: "creator",
        structure: "unknown",
        cash_amount_minor: null,
        cash_currency: null,
        in_kind_description: null,
        in_kind_estimate_minor: null,
        in_kind_estimate_currency: null,
        in_kind_estimate_label: null,
        payment_status: "not_applicable",
      },
      suggestion: null,
      valuation: {
        kind: "unknown",
        label: "unknown",
        reason: "structure_unknown",
        currency: null,
        total_minor: 0,
      },
      deliverables: [],
    });
    expect(payload).toBeNull();
  });
});
