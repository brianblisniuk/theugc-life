/**
 * Credit numbers are config. The UI module and the migration that seeds
 * credit_config name the same placeholders. Neither file is a price.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FREE_LIMITS } from "@/lib/config";
import {
  ADDED_TO_PIPELINE_TOAST,
  ALREADY_UNLOCKED_LABEL,
  CREDITS_CONFIG,
  PLAN_PRICES,
  addedToPipelineToast,
  creditsLeftLabel,
  OUT_OF_CREDITS_COPY,
  unlockChrome,
  unlockContactLabel,
} from "@/lib/credits/config";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("credit config", () => {
  it("keeps the D101 seed as history", () => {
    const sql = readFileSync(
      path.join(ROOT, "supabase/migrations/0058_contact_cache_seed_and_free_grant.sql"),
      "utf8",
    );
    expect(sql).toContain("15");
    expect(sql).toContain("50");
    expect(sql).toContain("150");
    expect(sql).toContain("array[10, 25, 50]");
    expect(sql).toContain("grandfather_visible_contact_unlocks");
    expect(sql).toContain("insert into public.contact_unlocks");
  });

  it("matches the live pricing migration", () => {
    const sql = readFileSync(
      path.join(ROOT, "supabase/migrations/0075_plan_tier_and_pricing.sql"),
      "utf8",
    );
    expect(sql).toContain(`free_weekly_credits = ${CREDITS_CONFIG.freeWeeklyCredits}`);
    expect(sql).toContain(`free_weekly_period_days = ${CREDITS_CONFIG.freeWeeklyPeriodDays}`);
    expect(sql).toContain(`pro_monthly_credits = ${CREDITS_CONFIG.planMonthlyCredits.pro}`);
    expect(sql).toContain(`max_monthly_credits = ${CREDITS_CONFIG.planMonthlyCredits.max}`);
    expect(sql).toContain(`pro_price_annual_per_month_usd = ${PLAN_PRICES.pro.annualPerMonthUsd}`);
    expect(sql).toContain(`pro_price_monthly_usd = ${PLAN_PRICES.pro.monthlyUsd}`);
    expect(sql).toContain(`max_price_annual_per_month_usd = ${PLAN_PRICES.max.annualPerMonthUsd}`);
    expect(sql).toContain(`max_price_monthly_usd = ${PLAN_PRICES.max.monthlyUsd}`);
    expect(sql).toContain(
      `array[${CREDITS_CONFIG.packs.map((pack) => pack.credits).join(", ")}]::integer[]`,
    );
    expect(sql).toContain(
      `array[${CREDITS_CONFIG.packs.map((pack) => pack.priceUsd).join(", ")}]::integer[]`,
    );
    expect(sql).not.toContain("insert into public.credit_ledger");
  });

  it("charges one configured credit for an assistant draft", () => {
    const sql = readFileSync(path.join(ROOT, "supabase/migrations/0082_ai_assistant.sql"), "utf8");
    expect(sql).toContain(`set ai_draft_cost = ${CREDITS_CONFIG.aiDraftCost}`);
    expect(sql).toContain("ai_draft");
    const charge = readFileSync(
      path.join(ROOT, "supabase/migrations/0083_ai_draft_credit.sql"),
      "utf8",
    );
    expect(charge).toContain("-v_cost");
    expect(charge).toContain("'ai_draft'");
    expect(charge).not.toMatch(/gmail\.send|messages\.send/);
  });

  it("does not refresh a stored address from the bounce review action", () => {
    const source = readFileSync(path.join(ROOT, "src/lib/credits/actions.ts"), "utf8");
    const review = source.slice(source.indexOf("export async function reviewContactReportAction"));
    expect(review).not.toContain("getContactProvider");
    expect(review).not.toContain("upsert_contact_cache");
  });

  it("debits the configured cost, not a literal -1", () => {
    const sql = readFileSync(
      path.join(ROOT, "supabase/migrations/0057_contact_credits.sql"),
      "utf8",
    );
    expect(sql).toContain("-v_cost");
    expect(sql).not.toMatch(/-\s*1\s*,\s*'unlock'/);
    expect(sql).toContain("has_unlocked_hotel_contact");
    expect(sql).not.toMatch(/create policy hotel_contacts_select[\s\S]*has_premium_hotel_access/);
  });

  it("shows the live prices on the public pages and starts checkout only on billing", () => {
    const pricing = readFileSync(path.join(ROOT, "src/app/(public)/pricing/page.tsx"), "utf8");
    const landing = readFileSync(path.join(ROOT, "src/app/(public)/page.tsx"), "utf8");
    const billing = readFileSync(path.join(ROOT, "src/app/(app)/app/billing/page.tsx"), "utf8");
    for (const source of [pricing, landing]) {
      expect(source).toContain("PLAN_PRICES");
      expect(source).not.toMatch(/rebill|stripe|startCheckout|buy now/i);
    }
    expect(billing).toContain("PLAN_PRICES");
    expect(billing).toContain("startRebillCheckoutAction");
    expect(billing).toContain("refreshOwnGrants");
    expect(pricing).toContain("Signed-in creators buy packs from the billing page.");
    expect(pricing).toContain("FREE_LIMITS.savedHotels");
    expect(landing).toContain("PLAN_PRICES.pro.annualPerMonthUsd");
    expect(landing).toContain("PLAN_PRICES.max.annualPerMonthUsd");
  });

  it("labels the unlock from the cost and keeps a failed balance off zero", () => {
    expect(unlockContactLabel(1)).toBe("Unlock contact (1 credit)");
    expect(unlockContactLabel(2)).toBe("Unlock contact (2 credits)");
    expect(ALREADY_UNLOCKED_LABEL).toBe("Already unlocked");
    expect(creditsLeftLabel(1)).toBe("1 credit left");
    expect(creditsLeftLabel(15)).toBe("15 credits left");
    expect(OUT_OF_CREDITS_COPY).not.toMatch(/checkout|billing|buy/i);
    expect(addedToPipelineToast({ status: "unlocked", pipelineAdded: true })).toBe(
      ADDED_TO_PIPELINE_TOAST,
    );
    expect(addedToPipelineToast({ status: "already_unlocked", pipelineAdded: true })).toBe(
      ADDED_TO_PIPELINE_TOAST,
    );
    expect(addedToPipelineToast({ status: "unlocked", pipelineAdded: false })).toBeNull();
    expect(
      addedToPipelineToast({ status: "insufficient_credits", pipelineAdded: true }),
    ).toBeNull();
    expect(addedToPipelineToast({ status: "not_found", pipelineAdded: true })).toBeNull();
    expect(addedToPipelineToast({ status: "pipeline_limit", pipelineAdded: true })).toBeNull();
    expect(addedToPipelineToast(null)).toBeNull();
    expect(unlockChrome({ unlocked: true, balance: 0, cost: 1 })).toBe("already");
    expect(unlockChrome({ unlocked: false, balance: null, cost: 1 })).toBe("unknown");
    expect(unlockChrome({ unlocked: false, balance: 0, cost: 1 })).toBe("out");
    expect(unlockChrome({ unlocked: false, balance: 1, cost: 1 })).toBe("unlock");
  });

  it("pins the unlock pipeline allowance to FREE_LIMITS.savedHotels", () => {
    const sql = readFileSync(
      path.join(ROOT, "supabase/migrations/0062_unlock_saves_pipeline.sql"),
      "utf8",
    );
    expect(sql).toContain(`v_free_saved_hotels constant integer := ${FREE_LIMITS.savedHotels};`);
    expect(sql).toContain("save_hotel_to_pipeline");
    expect(sql).not.toContain("insert into public.trips");
  });
});
