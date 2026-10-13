/**
 * Credit numbers are config. The UI module and the migration that seeds
 * credit_config name the same placeholders. Neither file is a price.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ALREADY_UNLOCKED_LABEL,
  CREDITS_CONFIG,
  creditsLeftLabel,
  OUT_OF_CREDITS_COPY,
  unlockChrome,
  unlockContactLabel,
} from "@/lib/credits/config";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("credit config placeholders", () => {
  it("matches the seed migration", () => {
    const sql = readFileSync(
      path.join(ROOT, "supabase/migrations/0058_contact_cache_seed_and_free_grant.sql"),
      "utf8",
    );
    expect(sql).toContain(String(CREDITS_CONFIG.freeCredits));
    expect(sql).toContain(String(CREDITS_CONFIG.planMonthlyCredits.pro));
    expect(sql).toContain(String(CREDITS_CONFIG.planMonthlyCredits.proPlus));
    expect(sql).toContain(String(CREDITS_CONFIG.unlockCost));
    expect(sql).toContain(String(CREDITS_CONFIG.cacheTtlDays));
    expect(sql).toContain("false");
    for (const size of CREDITS_CONFIG.packSizes) expect(sql).toContain(String(size));
    expect(sql).toContain("grandfather_visible_contact_unlocks");
    expect(sql).toContain("insert into public.contact_unlocks");
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

  it("labels the unlock from the cost and keeps a failed balance off zero", () => {
    expect(unlockContactLabel(1)).toBe("Unlock contact (1 credit)");
    expect(unlockContactLabel(2)).toBe("Unlock contact (2 credits)");
    expect(ALREADY_UNLOCKED_LABEL).toBe("Already unlocked");
    expect(creditsLeftLabel(1)).toBe("1 credit left");
    expect(creditsLeftLabel(15)).toBe("15 credits left");
    expect(OUT_OF_CREDITS_COPY).not.toMatch(/checkout|billing|buy/i);
    expect(unlockChrome({ unlocked: true, balance: 0, cost: 1 })).toBe("already");
    expect(unlockChrome({ unlocked: false, balance: null, cost: 1 })).toBe("unknown");
    expect(unlockChrome({ unlocked: false, balance: 0, cost: 1 })).toBe("out");
    expect(unlockChrome({ unlocked: false, balance: 1, cost: 1 })).toBe("unlock");
  });
});
