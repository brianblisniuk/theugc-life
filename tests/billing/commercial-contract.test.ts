/**
 * The V1 commercial contract as the code states it (D049, D051, D052, D056).
 *
 * These are cheap assertions that catch an expensive class of mistake: copy or
 * configuration drifting away from a decision the owner actually made. Prices
 * and durations live in typed config precisely so a single place can be pinned.
 *
 * The behavioural half of D056 — Free limits lifted inside an entitled
 * destination and still applied outside it — is proven against a real database
 * in tests/pipeline/save-to-pipeline.test.ts and tests/pipeline/transitions.test.ts,
 * where the RPCs enforce it. It is not duplicated here.
 */
import { describe, expect, it } from "vitest";

import { BILLING_COPY } from "@/lib/billing/view";
import { FREE_LIMITS, PRICING } from "@/lib/config";

describe("Creator Destination Pass — USD 39 / 30 days (D051)", () => {
  it("is priced at 39", () => {
    expect(PRICING.destinationPass.priceUsd).toBe(39);
  });

  it("lasts 30 days, not the superseded 90 (D024)", () => {
    expect(PRICING.destinationPass.durationDays).toBe(30);
    expect(PRICING.destinationPass.durationDays).not.toBe(90);
  });
});

describe("Creator Pro — USD 199/year (D052)", () => {
  it("launches at 199 for a year", () => {
    expect(PRICING.pro.launchPriceUsd).toBe(199);
    expect(PRICING.pro.durationDays).toBe(365);
  });

  it("keeps 299/249 as future hypotheses, not the launch price", () => {
    expect(PRICING.pro.referencePriceUsd).toBe(299);
    expect(PRICING.pro.laterPriceUsd).toBe(249);
    expect(PRICING.pro.launchPriceUsd).toBeLessThan(PRICING.pro.laterPriceUsd);
  });
});

describe("Free limits stay configuration-driven (D042)", () => {
  it("carries the two distinct allowances", () => {
    expect(FREE_LIMITS.savedHotels).toBe(10);
    expect(FREE_LIMITS.activePipelineItems).toBe(5);
    expect(FREE_LIMITS.activeTrips).toBe(1);
  });

  it("open relationships and engaged workflow are different numbers", () => {
    // D042: saved does not consume the engaged allowance.
    expect(FREE_LIMITS.savedHotels).toBeGreaterThan(FREE_LIMITS.activePipelineItems);
  });
});

describe("no surface implies a gated hotel inventory (D049)", () => {
  it("billing copy sells intelligence and contacts, never 'premium hotels'", () => {
    const all = JSON.stringify(BILLING_COPY);
    expect(all).not.toMatch(/premium hotels?\b/i);
    expect(all).not.toMatch(/premium database/i);
    expect(all).not.toMatch(/richer hotel data/i);
  });

  it("the Free-plan message states what Free already gets", () => {
    // The free tier's story is the asset, not the limit.
    expect(BILLING_COPY.freeBody).toMatch(/discoverable/i);
    expect(BILLING_COPY.freeBody).toMatch(/premium intelligence/i);
  });

  it("the error state still sells nothing", () => {
    expect(BILLING_COPY.errorTitle).not.toMatch(/upgrade|premium|plan/i);
  });
});
