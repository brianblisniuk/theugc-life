import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

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

async function waitForSignup(page: Page): Promise<string> {
  const timeoutMs = 20_000;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), timeoutMs);
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // The route announcer is also role=alert and empty. Only the form error counts.
    page
      .waitForURL(/\/onboarding$/, { timeout: timeoutMs })
      .then(() => finish("ok"))
      .catch(() => undefined);
    page
      .locator("form")
      .getByRole("alert")
      .waitFor({ state: "visible", timeout: timeoutMs })
      .then(async () => {
        const text = (await page.locator("form").getByRole("alert").innerText()).trim();
        finish(`alert:${text}`);
      })
      .catch(() => undefined);
    page
      .getByRole("heading", { name: "Something went wrong" })
      .waitFor({ state: "visible", timeout: timeoutMs })
      .then(() => finish("crash:Something went wrong"))
      .catch(() => undefined);
    page
      .getByText("Check your email to confirm your account.")
      .waitFor({ state: "visible", timeout: timeoutMs })
      .then(() => finish("confirm:Check your email to confirm your account."))
      .catch(() => undefined);
    page
      .waitForURL(/\/login/, { timeout: timeoutMs })
      .then(() => finish("login:sent to login"))
      .catch(() => undefined);
  });
}

async function signUp(page: Page, input: { email: string; name: string; username: string }) {
  await page.goto("/signup");
  await page.getByLabel("Email").fill(input.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  const outcome = await waitForSignup(page);
  expect(outcome, `signup error: ${outcome}`).toBe("ok");
  const welcome = page.getByRole("heading", { name: "Welcome" });
  try {
    await welcome.waitFor({ state: "visible", timeout: 10_000 });
  } catch (error) {
    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ").trim().slice(0, 180);
    throw new Error(`signup error: ${text}`, { cause: error });
  }
  await page.getByLabel("Display name").fill(input.name);
  await page.getByLabel("Username").fill(input.username);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => url.pathname === "/app/onboarding");
  await page.getByRole("link", { name: "Back to home", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/app");
}

/** The next server-action POST. A flash is not proof the write was stored. */
async function postAction(page: Page, act: () => Promise<void>) {
  const pending = page.waitForResponse(
    (response) => {
      const request = response.request();
      return request.method() === "POST" && request.headers()["next-action"] !== undefined;
    },
    { timeout: 20_000 },
  );
  await act();
  const response = await pending;
  expect(response.ok(), `action status ${response.status()}`).toBe(true);
  return response;
}

/** Wait for the action response, then reload so the assertion sees stored rows. */
async function commitAction(page: Page, act: () => Promise<void>): Promise<void> {
  await postAction(page, act);
  await page.reload();
}

/**
 * The public toggle without a reload. The button and the link must match the
 * flag that was stored. A private profile is not found at the public URL.
 */
async function expectPublicProfile(page: Page, username: string, on: boolean): Promise<void> {
  const href = `/creators/${username}`;
  const buttonName = on ? "Make private" : "Make public";
  const button = page.getByRole("button", { name: buttonName, exact: true });
  try {
    await expect(button).toBeVisible();
  } catch (error) {
    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ").trim().slice(0, 500);
    throw new Error(`public toggle wanted ${buttonName}; page: ${text}`, { cause: error });
  }
  if (on) await expect(page.getByRole("link", { name: href })).toBeVisible();
  else await expect(page.getByRole("link", { name: href })).toHaveCount(0);
  const response = await page.request.get(href);
  expect(response.status()).toBe(on ? 200 : 404);
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
  test.setTimeout(300_000);
  const stamp = Date.now().toString(36);
  const adaEmail = `e2e-ada-${stamp}@example.test`;
  const beaEmail = `e2e-bea-${stamp}@example.test`;

  const adaContext = await openContext(browser);
  const ada = await adaContext.newPage();
  const adaUsername = username("e2eada");
  await signUp(ada, { email: adaEmail, name: ADA_NAME, username: adaUsername });
  const balanceText = async (page: typeof ada) =>
    (await page.getByTestId("credit-balance").innerText()).replace(/\s+/g, " ").trim();
  const balanceNumber = (label: string) => {
    const match = label.match(/^(\d+) credits? available$/);
    if (!match) throw new Error(`credit counter was ${label}`);
    return Number(match[1]);
  };
  await expect(ada.getByTestId("credit-balance")).toBeVisible();
  const balanceAfterOnboarding = balanceNumber(await balanceText(ada));
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
  expect(balanceNumber(await balanceText(ada))).toBe(balanceAfterOnboarding);
  await expect(ada.getByRole("button", { name: "Unlock contact · 1 credit" })).toBeVisible();
  await expect(ada.getByText("found-222222222222@fake-provider.test")).toHaveCount(0);
  await postAction(ada, () =>
    ada.getByRole("button", { name: "Unlock contact · 1 credit" }).click(),
  );
  await expect(ada.getByTestId("added-to-pipeline")).toHaveText("Added to Pipeline");
  await ada.reload();
  await expect(ada.getByText("Already unlocked")).toBeVisible();
  await expect(ada.getByText("found-222222222222@fake-provider.test")).toBeVisible();
  await expect(ada.getByTestId("added-to-pipeline")).toHaveCount(0);
  expect(balanceNumber(await balanceText(ada))).toBe(balanceAfterOnboarding - 1);
  await expect(ada.getByRole("heading", { name: "Saved", exact: true })).toBeVisible();
  await expect(ada.getByText("This hotel is in your pipeline.")).toBeVisible();
  await expect(ada.getByRole("button", { name: "Save to Pipeline" })).toHaveCount(0);

  await commitAction(ada, () => ada.getByRole("button", { name: "Add to trip" }).click());
  await expect(ada.locator("#add-to-trip option:checked")).toContainText("already on this trip");

  await ada.goto("/app/pipeline");
  const pipelineContact = ada.getByTestId("pipeline-contact");
  await expect(pipelineContact).toHaveCount(1);
  await expect(pipelineContact).toHaveText("found-222222222222@fake-provider.test");
  await ada.goto(HOTEL_PATH);

  await ada.getByLabel("Gmail thread id").fill(FIXTURE_THREAD_ID);
  await commitAction(ada, () => ada.getByRole("button", { name: "Link thread" }).click());
  await expect(ada.getByText(`Linked thread ${FIXTURE_THREAD_ID}`)).toBeVisible();
  const confirmation = ada.getByTestId("gmail-confirmation");
  await expect(confirmation.getByText("Did this happen this way?")).toBeVisible();
  await expect(ada.getByRole("button", { name: "Prioritize this hotel" })).toHaveCount(0);
  await commitAction(ada, () =>
    confirmation.getByRole("button", { name: "Yes", exact: true }).click(),
  );
  await expect(ada.getByTestId("gmail-confirmation-stored")).toContainText(
    "You confirmed this. It did not enter the network: there is no single canonical hotel for this email.",
  );

  await ada.getByRole("button", { name: "Mark as pitched" }).click();
  await ada.locator("#pitch-channel").selectOption("email");
  await ada.locator("#pitch-date").fill(day(-1));
  await commitAction(ada, () => ada.getByRole("button", { name: "Mark as pitched" }).click());
  await expect(ada.getByRole("heading", { name: "Sent", exact: true })).toBeVisible();
  const personal = ada.getByTestId("personal-intelligence");
  await expect(personal.getByText("Manually recorded", { exact: true })).toBeVisible();
  await expect(personal.getByText("Pitch sent", { exact: true })).toBeVisible();
  await expect(personal.getByText("Verified via Gmail", { exact: true })).toHaveCount(0);

  await ada.getByRole("button", { name: "Mark replied" }).click();
  await ada.locator("#reply-date").fill(day(0));
  await ada.locator("#reply-sentiment").selectOption("positive");
  await commitAction(ada, () => ada.getByRole("button", { name: "Mark replied" }).click());
  await expect(ada.getByRole("heading", { name: "Replied", exact: true })).toBeVisible();

  await ada.getByRole("button", { name: "Start negotiation" }).click();
  await commitAction(ada, () => ada.getByRole("button", { name: "Start negotiation" }).click());
  await expect(ada.getByRole("heading", { name: "Negotiating", exact: true })).toBeVisible();

  await ada.getByRole("button", { name: "Mark as won" }).click();
  await ada.locator("#won-type").selectOption("stay");
  await ada.locator("#won-date").fill(day(0));
  await commitAction(ada, () => ada.getByRole("button", { name: "Mark as won" }).click());
  await expect(ada.getByRole("heading", { name: "Agreed", exact: true })).toBeVisible();
  await expect(
    ada.getByRole("heading", { name: "Collaboration agreed", exact: true }),
  ).toBeVisible();

  await ada.locator("#compensation-structure").selectOption("in_kind");
  await ada.locator("#in-kind-description").fill("E2E stay");
  await commitAction(ada, () => ada.getByRole("button", { name: "Save compensation" }).click());
  await expect(ada.locator("#in-kind-description")).toHaveValue("E2E stay");
  const deliverableForm = ada.getByRole("form", { name: "Add deliverable" });
  await deliverableForm.getByLabel("Platform").fill(PLATFORM);
  await commitAction(ada, () =>
    deliverableForm.getByRole("button", { name: "Add deliverable" }).click(),
  );
  await expect(ada.locator("#in-kind-description")).toHaveValue("E2E stay");
  await expect(ada.getByText(`· ${PLATFORM}`)).toBeVisible();
  await expect(ada.getByText("No deliverables yet")).toHaveCount(0);

  await ada.getByRole("link", { name: "My Profile", exact: true }).click();
  await ada.waitForURL("**/app/profile");
  await ada.getByRole("textbox", { name: "Bio" }).fill(BIO);
  await commitAction(ada, () => ada.getByRole("button", { name: "Save profile" }).click());
  await expect(ada.getByRole("textbox", { name: "Bio" })).toHaveValue(BIO);
  await expectPublicProfile(ada, adaUsername, false);
  await postAction(ada, () => ada.getByRole("button", { name: "Make public" }).click());
  await expectPublicProfile(ada, adaUsername, true);
  await postAction(ada, () => ada.getByRole("button", { name: "Make private" }).click());
  await expectPublicProfile(ada, adaUsername, false);
  await postAction(ada, () => ada.getByRole("button", { name: "Make public" }).click());
  await expectPublicProfile(ada, adaUsername, true);
  await ada.reload();
  await expectPublicProfile(ada, adaUsername, true);
  await ada.getByRole("checkbox", { name: "Bio" }).check();
  await commitAction(ada, () => ada.getByRole("button", { name: "Save sharing choices" }).click());
  await expect(ada.getByRole("checkbox", { name: "Bio" })).toBeChecked();
  // The raw token is only in the action response. Unrouting while that POST is
  // intercepted marks the route handled and drops the body.
  let token = "";
  const captureCreate = async (route: Route) => {
    const request = route.request();
    if (token || request.method() !== "POST" || request.headers()["next-action"] === undefined) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const text = await response.text();
    const found = text.match(/"token":"([0-9a-f]{64})"/)?.[1] ?? "";
    await route.fulfill({ response, body: text });
    if (found) token = found;
  };
  await ada.route("**/*", captureCreate);
  await ada.getByRole("button", { name: "Create link" }).click();
  await expect.poll(() => token, { timeout: 20_000 }).toMatch(/^[0-9a-f]{64}$/);
  await ada.unroute("**/*", captureCreate);
  await ada.reload();
  await expect(ada.getByText("A link is active")).toBeVisible();
  await expect(ada.getByRole("button", { name: "Revoke link" })).toBeVisible();
  await expect(ada.getByText("Copy this link now. It will not be shown again.")).toHaveCount(0);
  const shareUrl = `/p/${token}`;

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
  await commitAction(ada, () => ada.getByRole("button", { name: "Revoke link" }).click());
  await expect(ada.getByText("The last link is revoked.")).toBeVisible();
  await expect(ada.getByRole("button", { name: "Revoke link" })).toHaveCount(0);
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
  await expect(
    bea.getByRole("heading", { name: "No network fact yet", exact: true }),
  ).toBeVisible();
  await expect(bea.getByText("You confirmed this.")).toHaveCount(0);
  await expect(bea.getByText("Did this happen this way?")).toHaveCount(0);
  await expect(bea.getByText("Manually recorded", { exact: true })).toHaveCount(0);
  await expect(bea.getByRole("button", { name: "Prioritize this hotel" })).toHaveCount(0);
  await expect(bea.getByText(FIXTURE_THREAD_ID)).toHaveCount(0);
  await expect(bea.getByText("Collaboration agreed")).toHaveCount(0);
  await expect(bea.getByText(BIO)).toHaveCount(0);
  await expect(bea.getByText(ADA_NAME)).toHaveCount(0);
  await expect(bea.getByText("found-222222222222@fake-provider.test")).toHaveCount(0);
  await expect(bea.getByText("Already unlocked")).toHaveCount(0);
  await expect(bea.getByRole("button", { name: "Unlock contact · 1 credit" })).toBeVisible();

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
  await expect(bea.getByText("On trip")).toHaveCount(0);

  await bea.goto("/app/profile");
  await expect(bea.getByLabel("Display name")).toHaveValue(BEA_NAME);
  await expect(bea.getByText(ADA_NAME)).toHaveCount(0);
  await expect(bea.getByText(BIO)).toHaveCount(0);
  await expect(bea.getByText(adaEmail)).toHaveCount(0);

  await anonContext.close();
  await beaContext.close();
  await adaContext.close();
});
