/**
 * Scheduled jobs post to an internal route. They do not import Gmail or Claude.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_ERASURE_PATH,
  CREDIT_PERIOD_PATH,
  FOLLOWUP_HOUSEKEEPING_PATH,
  GMAIL_SEND_DISPATCH_PATH,
  INBOX_SYNC_PATH,
  runScheduledPost,
} from "@/lib/jobs/scheduled-post";
import { handler as erasureHandler } from "../../netlify/functions/account-erasure";
import { handler as creditHandler } from "../../netlify/functions/credit-period-refresh";
import { handler as followupHandler } from "../../netlify/functions/gmail-followup-housekeeping";
import { handler as inboxHandler } from "../../netlify/functions/gmail-inbox-sync";

const SECRET = "schedule-secret-0001";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("scheduled post", () => {
  it("fails closed when the secret, site, or path is not usable", async () => {
    const fetchImpl = vi.fn();
    const cases = [
      { secret: null, siteUrl: "https://app.example", path: INBOX_SYNC_PATH },
      { secret: "too-short", siteUrl: "https://app.example", path: INBOX_SYNC_PATH },
      { secret: SECRET, siteUrl: null, path: INBOX_SYNC_PATH },
      { secret: SECRET, siteUrl: "https://app.example", path: "/api/gmail" },
    ];
    for (const item of cases) {
      const result = await runScheduledPost({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        siteUrl: item.siteUrl,
        secret: item.secret,
        path: item.path,
      });
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body)).toEqual({ result: "not_configured" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts the bearer to the named internal route", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const result = await runScheduledPost({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      siteUrl: "https://app.example/",
      secret: SECRET,
      path: ACCOUNT_ERASURE_PATH,
    });
    expect(result.statusCode).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith("https://app.example/api/internal/account-erasure", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
    });
  });
});

describe("netlify handlers", () => {
  const handlers = [
    {
      name: "gmail-inbox-sync",
      handler: inboxHandler,
      path: INBOX_SYNC_PATH,
      secret: "GMAIL_SYNC_SECRET",
    },
    {
      name: "account-erasure",
      handler: erasureHandler,
      path: ACCOUNT_ERASURE_PATH,
      secret: "ACCOUNT_ERASURE_SECRET",
    },
    {
      name: "credit-period-refresh",
      handler: creditHandler,
      path: CREDIT_PERIOD_PATH,
      secret: "CREDIT_PERIOD_SECRET",
    },
    {
      name: "gmail-followup-housekeeping",
      handler: followupHandler,
      path: FOLLOWUP_HOUSEKEEPING_PATH,
      secret: "GMAIL_FOLLOWUP_SECRET",
    },
  ] as const;

  it("each handler posts its own path and does not import a provider", async () => {
    const previousUrl = process.env.URL;
    const previousSite = process.env.NEXT_PUBLIC_SITE_URL;
    process.env.URL = "https://jobs.example";
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    try {
      for (const item of handlers) {
        process.env[item.secret] = SECRET;
        fetchImpl.mockClear();
        const result = await item.handler();
        expect(result.statusCode).toBe(200);
        expect(fetchImpl).toHaveBeenCalledWith(`https://jobs.example${item.path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${SECRET}` },
        });
        const source = readFileSync(
          path.join(ROOT, "netlify/functions", `${item.name}.ts`),
          "utf8",
        );
        expect(source).not.toMatch(/google\.server|claude\.server|@anthropic|googleapis/);
        delete process.env[item.secret];
      }
    } finally {
      globalThis.fetch = original;
      if (previousUrl === undefined) delete process.env.URL;
      else process.env.URL = previousUrl;
      if (previousSite === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
      else process.env.NEXT_PUBLIC_SITE_URL = previousSite;
    }
  });

  it("declares the four new schedules next to the send dispatcher", () => {
    const toml = readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
    expect(toml).toContain('[functions."gmail-send-dispatch"]');
    expect(toml).toContain('schedule = "* * * * *"');
    expect(toml).toContain('[functions."gmail-inbox-sync"]');
    expect(toml).toContain('schedule = "*/15 * * * *"');
    expect(toml).toContain('[functions."account-erasure"]');
    expect(toml).toContain('schedule = "15 6 * * *"');
    expect(toml).toContain('[functions."credit-period-refresh"]');
    expect(toml).toContain('schedule = "45 6 * * *"');
    expect(toml).toContain('[functions."gmail-followup-housekeeping"]');
    expect(toml).toContain('schedule = "7,22,37,52 * * * *"');
    expect(GMAIL_SEND_DISPATCH_PATH).toBe("/api/internal/gmail-send-dispatch");
  });
});
