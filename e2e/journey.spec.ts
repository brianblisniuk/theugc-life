import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { FIXTURE_THREAD_ID, seedMailbox } from "./support/mailbox";
import { blockExternalNetwork } from "./support/network";

const HOTEL_PATH = "/app/hotels/22222222-2222-4222-8222-222222222222";
const HOTEL_NAME = "E2E Harbor House";
const ADA_NAME = "E2E Ada Creator";
const BEA_NAME = "E2E Bea Creator";
const BIO = "E2E bio visible on the link";
const ADA_MAILBOX = "e2e-ada-mailbox@example.invalid";
const BEA_MAILBOX = "e2e-bea-mailbox@example.invalid";
const PASSWORD = "e2e-password";
const PLATFORM = "e2e-platform";

const externalHosts: string[] = [];

function day(offset: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function username(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}`.slice(0, 30);
}

async function signUp(page: Page, input: { email: string; name: string; username: string }) {
  await page.goto("/signup");
  await page.getByLabel("Email").fill(input.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  try {
    await expect(page).toHaveURL(/\/onboarding$/, { timeout: 20_000 });
  } catch (error) {
    const text = await page.locator("body").innerText();
    throw new Error(`signup stayed on ${page.url()}: ${text}`, { cause: error });
  }
  await page.getByLabel("Display name").fill(input.name);
  await page.getByLabel("Username").fill(input.username);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => url.pathname === "/app");
}

async function openContext(browser: { newContext: () => Promise<BrowserContext> }) {
  const context = await browser.newContext();
  await blockExternalNetwork(context, externalHosts);
  return context;
}

test.describe.configure({ mode: "serial" });

test.afterEach(() => {
  expect(externalHosts).toEqual([]);
});

test("health carries security headers and no private fields", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body).toEqual({ status: "ok" });
  const headers = response.headers();
  const csp = headers["content-security-policy"] ?? "";
  expect(csp).toContain("https://maps.googleapis.com");
  expect(csp).toContain("https://maps.gstatic.com");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-request-id"]?.length ?? 0).toBeGreaterThan(7);
  const packed = JSON.stringify(body);
  expect(packed).not.toContain("@");
  expect(packed).not.toContain("token");
});

test("creator journey, revoked inbox, and the other creator sees nothing private", async ({
  browser,
}) => {
  const stamp = Date.now().toString(36);
  const adaEmail = `e2e-ada-${stamp}@example.test`;
  const beaEmail = `e2e-bea-${stamp}@example.test`;

  const adaContext = await openContext(browser);
  const ada = await adaContext.newPage();
  await signUp(ada, { email: adaEmail, name: ADA_NAME, username: username("e2eada") });
  await seedMailbox({
    loginEmail: adaEmail,
    mailboxEmail: ADA_MAILBOX,
    state: "connected",
    threadId: FIXTURE_THREAD_ID,
  });

  await ada.goto("/app/trips");
  await ada.getByLabel("Destination").selectOption({ label: "E2E Bay" });
  await ada.getByLabel("Name (optional)").fill("E2E Ada trip");
  await ada.getByLabel("Start").fill(day(0));
  await ada.getByLabel("End").fill(day(7));
  await ada.getByRole("button", { name: "Create trip" }).click();
  await ada.waitForURL(/\/app\/trips\/[0-9a-f-]{36}$/);
  const tripUrl = ada.url();

  await ada.goto("/app/discover");
  await expect(ada.getByText("We couldn’t load hotels just now")).toHaveCount(0);
  await ada.getByRole("link", { name: HOTEL_NAME }).click();
  await ada.waitForURL(new RegExp(`${HOTEL_PATH}$`));
  await expect(ada.locator('aside[aria-label="Map"]')).toHaveCount(0);
  await expect(ada.locator('script[src*="maps.googleapis.com"]')).toHaveCount(0);

  await ada.getByRole("button", { name: "Add to trip" }).click();
  await expect(ada.getByText("Added to this trip.")).toBeVisible();
  await ada.getByRole("button", { name: "Save to Pipeline" }).click();
  await expect(ada.getByText("Saved to your pipeline.")).toBeVisible();
  await ada.reload();

  await ada.getByLabel("Gmail thread id").fill(FIXTURE_THREAD_ID);
  await ada.getByRole("button", { name: "Link thread" }).click();
  await expect(ada.getByText("Saved", { exact: true })).toBeVisible();
  await expect(ada.getByText(FIXTURE_THREAD_ID)).toBeVisible();

  await ada.getByRole("button", { name: "Mark as pitched" }).click();
  await ada.locator("#pitch-channel").selectOption("email");
  await ada.locator("#pitch-date").fill(day(-1));
  await ada.getByRole("button", { name: "Mark as pitched" }).click();
  await expect(ada.getByText("Updated to Pitched.")).toBeVisible();
  await ada.reload();

  await ada.getByRole("button", { name: "Mark replied" }).click();
  await ada.locator("#reply-date").fill(day(0));
  await ada.locator("#reply-sentiment").selectOption("positive");
  await ada.getByRole("button", { name: "Mark replied" }).click();
  await expect(ada.getByText("Updated to Replied.")).toBeVisible();
  await ada.reload();

  await ada.getByRole("button", { name: "Start negotiation" }).click();
  await ada.getByRole("button", { name: "Start negotiation" }).click();
  await expect(ada.getByText("Updated to Negotiating.")).toBeVisible();
  await ada.reload();

  await ada.getByRole("button", { name: "Mark as won" }).click();
  await ada.locator("#won-type").selectOption("stay");
  await ada.locator("#won-date").fill(day(0));
  await ada.getByRole("button", { name: "Mark as won" }).click();
  await expect(ada.getByText("Collaboration agreed.")).toBeVisible();
  await ada.reload();
  await expect(ada.getByRole("heading", { name: "Collaboration agreed" })).toBeVisible();

  await ada.locator("#compensation-structure").selectOption("in_kind");
  await ada.getByRole("button", { name: "Save compensation" }).click();
  await expect(ada.getByText("Saved", { exact: true }).first()).toBeVisible();
  await ada.getByLabel("Platform").fill(PLATFORM);
  await ada.getByRole("button", { name: "Add deliverable" }).click();
  await ada.reload();
  await expect(ada.getByText(PLATFORM)).toBeVisible();

  await ada.getByRole("link", { name: "Profile" }).click();
  await ada.waitForURL("**/app/profile");
  await ada.getByLabel("Bio").fill(BIO);
  await ada.getByRole("button", { name: "Save profile" }).click();
  await expect(ada.getByText("Saved.", { exact: true })).toBeVisible();
  await ada.getByRole("checkbox", { name: "Bio" }).check();
  await ada.getByRole("button", { name: "Save sharing choices" }).click();
  await expect(ada.getByText("Saved. A field you turned off is gone from the link.")).toBeVisible();
  await ada.getByRole("button", { name: "Create link" }).click();
  await expect(ada.getByText("Copy this link now. It will not be shown again.")).toBeVisible();
  const shareUrl = (await ada.locator("p.font-mono").innerText()).trim();
  expect(shareUrl).toMatch(/\/p\/[a-f0-9]{64}$/);

  const anonContext = await openContext(browser);
  const anon = await anonContext.newPage();
  await anon.goto(shareUrl);
  await expect(anon.getByRole("heading", { name: "Bio" })).toBeVisible();
  await expect(anon.getByText(BIO)).toBeVisible();
  await expect(anon.getByText(ADA_NAME)).toHaveCount(0);
  await expect(anon.getByText(adaEmail)).toHaveCount(0);
  await expect(anon.getByText(ADA_MAILBOX)).toHaveCount(0);
  await expect(anon.getByText("Audience")).toHaveCount(0);

  await ada.reload();
  await ada.getByRole("button", { name: "Revoke link" }).click();
  await expect(ada.getByText("Revoked. That address no longer works.")).toBeVisible();
  await anon.reload();
  await expect(anon.getByText("This link is not available")).toBeVisible();
  await expect(anon.getByText(BIO)).toHaveCount(0);
  await expect(anon.getByText(ADA_NAME)).toHaveCount(0);

  await anon.goto("/app");
  await anon.waitForURL(/\/login/);
  await anon.goto("/admin");
  await anon.waitForURL(/\/login/);
  await anon.goto(tripUrl);
  await anon.waitForURL(/\/login/);
  await anon.goto("/api/health");
  await expect(anon.getByText('{"status":"ok"}')).toBeVisible();

  await ada.goto("/admin");
  await ada.waitForURL((url) => url.pathname === "/app");
  await expect(ada.getByText("Admin workflows arrive in Sprint 1")).toHaveCount(0);

  const beaContext = await openContext(browser);
  const bea = await beaContext.newPage();
  await signUp(bea, { email: beaEmail, name: BEA_NAME, username: username("e2ebea") });
  await seedMailbox({
    loginEmail: beaEmail,
    mailboxEmail: BEA_MAILBOX,
    state: "revoked",
  });

  await bea.goto(tripUrl);
  await expect(bea.getByRole("heading", { name: "Trip not found" })).toBeVisible();
  await bea.goto(HOTEL_PATH);
  await expect(bea.getByRole("button", { name: "Save to Pipeline" })).toBeVisible();
  await expect(bea.getByText(FIXTURE_THREAD_ID)).toHaveCount(0);
  await expect(bea.getByText("Collaboration agreed")).toHaveCount(0);
  await expect(bea.getByText(BIO)).toHaveCount(0);
  await expect(bea.getByText(ADA_NAME)).toHaveCount(0);

  await bea.goto("/app/pipeline");
  await expect(bea.getByText("Your pipeline is empty")).toBeVisible();
  await expect(bea.getByText("We couldn’t load your pipeline")).toHaveCount(0);
  await expect(bea.getByText(HOTEL_NAME)).toHaveCount(0);

  await bea.goto("/app/trips");
  await expect(bea.getByText("No trips yet")).toBeVisible();
  await expect(bea.getByText("We couldn’t load your trips")).toHaveCount(0);

  await bea.goto("/app/collaborations");
  await expect(bea.getByText("No collaborations yet")).toBeVisible();
  await expect(bea.getByText("We couldn’t load your collaborations")).toHaveCount(0);
  await expect(bea.getByText(HOTEL_NAME)).toHaveCount(0);

  await bea.goto("/app/inbox");
  await expect(bea.getByRole("heading", { name: "Gmail authorization stopped" })).toBeVisible();
  await expect(bea.getByText("not an empty inbox")).toBeVisible();
  await expect(bea.getByText("No inbox links yet")).toHaveCount(0);
  await expect(bea.getByText(FIXTURE_THREAD_ID)).toHaveCount(0);
  await expect(bea.getByText(ADA_MAILBOX)).toHaveCount(0);
  await bea.getByRole("link", { name: "Try again" }).click();
  await expect(bea.getByRole("heading", { name: "Gmail authorization stopped" })).toBeVisible();
  await expect(bea.getByText("not an empty inbox")).toBeVisible();

  await bea.goto("/app/discover");
  await expect(bea.getByRole("link", { name: HOTEL_NAME })).toBeVisible();
  await expect(bea.getByText("We couldn’t load hotels just now")).toHaveCount(0);
  await expect(bea.getByText("On a trip")).toHaveCount(0);

  await bea.goto("/app/profile");
  await expect(bea.getByLabel("Display name")).toHaveValue(BEA_NAME);
  await expect(bea.getByText(ADA_NAME)).toHaveCount(0);
  await expect(bea.getByText(BIO)).toHaveCount(0);
  await expect(bea.getByText(adaEmail)).toHaveCount(0);

  await anonContext.close();
  await beaContext.close();
  await adaContext.close();
});
