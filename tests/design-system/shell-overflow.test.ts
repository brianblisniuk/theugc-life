/**
 * Shell overflow at the V12.1 viewports. Measures a real layout engine.
 * The wide table sits in a scroll container, so the page itself must not
 * grow sideways at 390 or 1440.
 */
import { existsSync, readFileSync } from "node:fs";

import { chromium, type Page } from "@playwright/test";
import { describe, expect, it } from "vitest";

function chromePath(): string {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/local/bin/google-chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const bundled = chromium.executablePath();
  if (existsSync(bundled)) return bundled;
  throw new Error(
    "Shell overflow tests need Chrome or Playwright Chromium. Set CHROME_PATH or run npx playwright install chromium.",
  );
}

function shellDocument(): string {
  const globals = readFileSync("src/app/globals.css", "utf8");
  const root = globals.match(/:root\s*\{[\s\S]*?\n\}/);
  if (!root) throw new Error("globals.css is missing :root");
  const v12 = readFileSync("src/app/v12.css", "utf8");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; }
${root[0]}
${v12}
</style>
</head>
<body>
<div class="v12-shell">
  <aside class="v12-sidebar" aria-label="Main navigation">
    <a class="v12-brand" href="/app"><span>theugc</span><span class="v12-dot"></span><span>life</span></a>
    <div class="v12-nav-section">Your workspace</div>
    <a class="v12-nav-link" href="/app" aria-current="page">Home</a>
    <a class="v12-nav-link" href="/app/discover">Discover</a>
    <a class="v12-nav-link" href="/app/trips">My Trips</a>
    <div class="v12-nav-section">Outreach and relationships</div>
    <a class="v12-nav-link" href="/app/pipeline">Pipeline</a>
    <a class="v12-nav-link" href="/app/inbox">Inbox</a>
  </aside>
  <div class="v12-maincol">
    <header class="v12-topbar">
      <button class="v12-menu" type="button">Menu</button>
      <strong class="v12-location">Hotel detail with a long working title</strong>
      <span class="v12-dotsep">/</span>
      <span class="v12-subtle">Your workspace</span>
      <div class="v12-topbar-right">
        <span class="v12-top-pill">Pro</span>
        <p class="v12-top-pill is-lime">999 credits available</p>
      </div>
    </header>
    <main class="v12-content">
      <ol class="v12-crumbs">
        <li><a href="/app">Home</a></li>
        <li><a href="/app/discover">Discover</a></li>
        <li><span aria-current="page">A very long hotel name that must wrap inside the column</span></li>
      </ol>
      <div class="v12-actions">
        <button class="v12-btn is-primary" type="button">Primary action</button>
        <button class="v12-btn" type="button">Secondary action</button>
        <button class="v12-btn" type="button">Another action</button>
        <button class="v12-btn" type="button">One more action</button>
      </div>
      <div class="v12-tablewrap">
        <div style="min-width:1600px;height:12px">wide row</div>
      </div>
    </main>
  </div>
  <nav class="v12-mobile" aria-label="Quick navigation">
    <a href="/app">Home</a>
    <a href="/app/discover">Explore</a>
    <a href="/app/trips">Trips</a>
    <a href="/app/inbox">Inbox</a>
    <a href="/app/pipeline">Pipeline</a>
  </nav>
</div>
</body>
</html>`;
}

async function measure(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.setContent(shellDocument(), { waitUntil: "load" });
  return page.evaluate(() => {
    const root = document.documentElement;
    const offenders: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.right <= root.clientWidth + 1) continue;
      let parent: HTMLElement | null = el.parentElement;
      let clipped = false;
      while (parent) {
        const style = getComputedStyle(parent);
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          clipped = true;
          break;
        }
        parent = parent.parentElement;
      }
      if (!clipped && getComputedStyle(el).position !== "fixed") {
        offenders.push(el.className || el.tagName);
      }
    }
    return {
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      offenders: offenders.slice(0, 8),
    };
  });
}

describe("shell viewport overflow", () => {
  it("does not overflow the page at 390 or 1440", async () => {
    const browser = await chromium.launch({
      executablePath: chromePath(),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const page = await browser.newPage();
      for (const [width, height] of [
        [390, 844],
        [1440, 900],
      ] as const) {
        const result = await measure(page, width, height);
        expect(result.offenders, `${width}px offenders`).toEqual([]);
        expect(result.scrollWidth, `${width}px scrollWidth`).toBeLessThanOrEqual(
          result.clientWidth + 1,
        );
      }
    } finally {
      await browser.close();
    }
  }, 60_000);
});
