/**
 * Discover and Hotel Detail stay on the UX02 contract.
 * These checks read the screens. They do not render a browser.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

describe("UX02 tokens and shell", () => {
  it("defaults to dark, shares token names with light, and keeps the accent a fill", () => {
    const css = source("src/app/globals.css");
    const layout = source("src/app/layout.tsx");
    expect(css).toContain("[data-theme=\"dark\"]");
    expect(css).toContain("[data-theme=\"light\"]");
    expect(css).toContain("--accent: #dfff4f");
    expect(css).toContain("--accent-ink: #17191b");
    expect(css).toMatch(/font-family:[^;]*Archivo/);
    expect(layout).toContain('data-theme="dark"');
    expect(layout).toContain("Archivo");
    expect(layout).toContain("THEME_BOOT_SCRIPT");
    expect(css).not.toMatch(/--accent:\s*#ffe01b/i);
  });
});

describe("Discover screen", () => {
  it("keeps one layout, keyword chips, and this page's pins", () => {
    const page = source("src/app/(app)/app/discover/page.tsx");
    const filters = source("src/components/hotels/discover-filters.tsx");
    const copy = source("src/lib/ux02/copy.ts");
    expect(page).toContain("result.pins");
    expect(page).toContain("discoverFilterChips");
    expect(page).toContain("discoverSortGate");
    expect(page).toContain("DISCOVER_ERROR_TITLE");
    expect(page).toContain("DISCOVER_NO_RESULTS_TITLE");
    expect(page).toContain("VIEW_PLANS");
    expect(copy).toContain("Hotels couldn't be loaded.");
    expect(copy).toContain("No hotels match your filters.");
    expect(copy).toContain('export const VIEW_PLANS = "View plans"');
    expect(page).not.toMatch(/anthropic|claude|openai|generateObject/i);
    expect(filters).toContain('name="q"');
    expect(filters).not.toMatch(/anthropic|claude|openai/i);
    expect(source("src/lib/hotels/filters.ts")).toContain("export const DISCOVER_PAGE_SIZE = 24");
  });
});

describe("Hotel Detail screen", () => {
  it("uses four tabs, a real next step, and initials until a verified photo exists", () => {
    const page = source("src/app/(app)/app/hotels/[id]/page.tsx");
    const panel = source("src/components/hotels/next-step-panel.tsx");
    expect(page).toContain("HotelSectionNav");
    expect(page).toContain("NextStepPanel");
    expect(page).toContain("initialsFromName");
    expect(page).toContain("No verified photograph on file.");
    expect(page).not.toMatch(/<img[\s>]/);
    expect(page).not.toMatch(/unsplash|placeholder\.com|stock/i);
    expect(panel).toContain('aria-label="Your next step"');
    expect(panel).toContain("model.primaryLabel");
    expect(source("src/lib/ux02/copy.ts")).toContain('export const GENERATE_PITCH = "Generate pitch"');
    expect(source("src/lib/credits/config.ts")).toContain("chargeOnNotFound: false");
    expect(source("src/components/contacts/report-contact.tsx")).toContain(
      "Report incorrect contact",
    );
    expect(source("src/lib/ux02/copy.ts")).toContain('export const ON_TRIP = "On trip"');
    expect(source("src/components/hotels/hotel-row.tsx")).toContain("ON_TRIP");
  });
});
