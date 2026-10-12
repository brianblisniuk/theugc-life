import { defineConfig } from "@playwright/test";

/**
 * Local only. CI starts Supabase and `next start` before invoking Playwright.
 * The suite does not open a browser server of its own and does not call a vendor.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000",
    timezoneId: "UTC",
    trace: "retain-on-failure",
  },
});
