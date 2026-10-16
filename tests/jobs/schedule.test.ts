/**
 * Scheduled jobs run in-process. They do not POST to the public site.
 * Gmail and Google are mocks. No test opens a socket.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_ERASURE_PATH,
  CREDIT_PERIOD_PATH,
  FOLLOWUP_HOUSEKEEPING_PATH,
  GMAIL_SEND_DISPATCH_PATH,
  INBOX_SYNC_PATH,
  runScheduledJob,
} from "@/lib/jobs/scheduled-post";
import { handler as erasureHandler } from "../../netlify/functions/account-erasure";
import { handler as creditHandler } from "../../netlify/functions/credit-period-refresh";
import { handler as followupHandler } from "../../netlify/functions/gmail-followup-housekeeping";
import { handler as inboxHandler } from "../../netlify/functions/gmail-inbox-sync";
import { handler as dispatchHandler } from "../../netlify/functions/gmail-send-dispatch";

const SECRET = "schedule-secret-0001";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const runs = vi.hoisted(() => ({
  inbox: vi.fn(async () => ({ accounts: 2, results: ["not_due", "progressed"] })),
  erasure: vi.fn(async () => ({ result: "ok", erased: 0 })),
  credit: vi.fn(async () => ({ result: "ok", users: 1 })),
  followup: vi.fn(async () => ({ result: "ok", stopped: 1, enqueued: 0 })),
  dispatch: vi.fn(async () => ({ sent: 0, deferred: 0, failed: 0, paused: 0 })),
  admin: vi.fn(() => ({ rpc: async () => ({ data: null, error: null }) })),
  sendDeps: vi.fn(() => ({ marker: "deps" })),
}));

vi.mock("../../src/lib/gmail/sync/scheduled.server", () => ({
  runProductionInboxSync: runs.inbox,
}));
vi.mock("../../src/lib/jobs/maintenance", () => ({
  runAccountErasure: runs.erasure,
  runAnnualCreditRefresh: runs.credit,
  runFollowupHousekeeping: runs.followup,
}));
vi.mock("../../src/lib/supabase/admin", () => ({
  createAdminClient: runs.admin,
}));
vi.mock("../../src/lib/gmail/send/dispatch", () => ({
  dispatchDueGmailSends: runs.dispatch,
}));
vi.mock("../../src/lib/gmail/send/dispatch.server", () => ({
  productionSendDeps: runs.sendDeps,
}));

const JOB_SECRETS = [
  "GMAIL_SYNC_SECRET",
  "ACCOUNT_ERASURE_SECRET",
  "CREDIT_PERIOD_SECRET",
  "GMAIL_FOLLOWUP_SECRET",
  "GMAIL_DISPATCH_SECRET",
] as const;

describe("scheduled job gate", () => {
  it("fails closed and does not run the job when the secret is missing or short", async () => {
    const run = vi.fn(async () => ({ accounts: 1 }));
    for (const secret of [null, "", "too-short", "x".repeat(15)]) {
      const result = await runScheduledJob({ secret, run });
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body)).toEqual({ result: "not_configured" });
      expect(result.body).not.toContain("too-short");
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("runs once when the secret is configured and keeps the job result", async () => {
    const run = vi.fn(async () => ({ result: "error", erased: 0 }));
    const result = await runScheduledJob({ secret: SECRET, run });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ result: "error", erased: 0 });
    expect(result.body).not.toContain(SECRET);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not log the secret when the job throws", async () => {
    const error = new Error("job failed");
    const spies = (["error", "warn", "log", "info"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    await expect(
      runScheduledJob({
        secret: SECRET,
        run: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
    const dumped = spies.flatMap((spy) => spy.mock.calls.flat().map((part) => String(part)));
    expect(dumped.join("\n")).not.toContain(SECRET);
    for (const spy of spies) spy.mockRestore();
  });
});

describe("netlify handlers", () => {
  const handlers = [
    {
      name: "gmail-inbox-sync",
      handler: inboxHandler,
      secret: "GMAIL_SYNC_SECRET",
      run: runs.inbox,
      body: { result: "ok", accounts: 2, results: ["not_due", "progressed"] },
    },
    {
      name: "account-erasure",
      handler: erasureHandler,
      secret: "ACCOUNT_ERASURE_SECRET",
      run: runs.erasure,
      body: { result: "ok", erased: 0 },
    },
    {
      name: "credit-period-refresh",
      handler: creditHandler,
      secret: "CREDIT_PERIOD_SECRET",
      run: runs.credit,
      body: { result: "ok", users: 1 },
    },
    {
      name: "gmail-followup-housekeeping",
      handler: followupHandler,
      secret: "GMAIL_FOLLOWUP_SECRET",
      run: runs.followup,
      body: { result: "ok", stopped: 1, enqueued: 0 },
    },
    {
      name: "gmail-send-dispatch",
      handler: dispatchHandler,
      secret: "GMAIL_DISPATCH_SECRET",
      run: runs.dispatch,
      body: { result: "ok", sent: 0, deferred: 0, failed: 0, paused: 0 },
    },
  ] as const;

  beforeEach(() => {
    for (const key of JOB_SECRETS) delete process.env[key];
    runs.inbox.mockClear();
    runs.erasure.mockClear();
    runs.credit.mockClear();
    runs.followup.mockClear();
    runs.dispatch.mockClear();
    runs.admin.mockClear();
    runs.sendDeps.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("scheduled job opened the network");
      }),
    );
  });

  it("each handler runs its own job and ignores a caller bearer", async () => {
    for (const item of handlers) {
      process.env[item.secret] = SECRET;
      const result = await item.handler({
        headers: { authorization: "Bearer attacker-supplied-secret-value" },
      } as never);
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual(item.body);
      expect(result.body).not.toContain(SECRET);
      expect(result.body).not.toContain("attacker-supplied");
      expect(item.run).toHaveBeenCalledTimes(1);
      for (const other of handlers) {
        if (other.run !== item.run) expect(other.run).not.toHaveBeenCalled();
      }
      delete process.env[item.secret];
      item.run.mockClear();
    }
  });

  it("does not sync, erase, enqueue, or send when that job's secret is absent", async () => {
    for (const item of handlers) {
      const result = await item.handler();
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body)).toEqual({ result: "not_configured" });
    }
    expect(runs.inbox).not.toHaveBeenCalled();
    expect(runs.erasure).not.toHaveBeenCalled();
    expect(runs.credit).not.toHaveBeenCalled();
    expect(runs.followup).not.toHaveBeenCalled();
    expect(runs.dispatch).not.toHaveBeenCalled();
    expect(runs.admin).not.toHaveBeenCalled();
    expect(runs.sendDeps).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a configured follow-up does not dispatch a send", async () => {
    process.env.GMAIL_FOLLOWUP_SECRET = SECRET;
    await followupHandler();
    expect(runs.followup).toHaveBeenCalledTimes(1);
    expect(runs.dispatch).not.toHaveBeenCalled();
    expect(runs.sendDeps).not.toHaveBeenCalled();
    expect(runs.inbox).not.toHaveBeenCalled();
  });

  it("a configured dispatch does not run inbox sync", async () => {
    process.env.GMAIL_DISPATCH_SECRET = SECRET;
    await dispatchHandler();
    expect(runs.dispatch).toHaveBeenCalledTimes(1);
    expect(runs.sendDeps).toHaveBeenCalledTimes(1);
    expect(runs.inbox).not.toHaveBeenCalled();
    expect(runs.followup).not.toHaveBeenCalled();
  });

  it("handler source does not post to the site or import Claude", () => {
    for (const name of [
      "gmail-inbox-sync",
      "account-erasure",
      "credit-period-refresh",
      "gmail-followup-housekeeping",
      "gmail-send-dispatch",
    ]) {
      const source = readFileSync(path.join(ROOT, "netlify/functions", `${name}.ts`), "utf8");
      expect(source).not.toMatch(
        /runScheduledPost|fetchImpl|claude\.server|@anthropic|completeClaude/,
      );
      expect(source).not.toMatch(/console\.(log|info|warn|error|debug)/);
      expect(source).toContain("runScheduled");
    }
    const inbox = readFileSync(path.join(ROOT, "netlify/functions/gmail-inbox-sync.ts"), "utf8");
    expect(inbox).toContain("runProductionInboxSync");
    expect(inbox).not.toMatch(/dispatchDueGmailSends|sendMessage/);
    const dispatch = readFileSync(
      path.join(ROOT, "netlify/functions/gmail-send-dispatch.ts"),
      "utf8",
    );
    expect(dispatch).toContain("dispatchDueGmailSends");
    expect(dispatch).not.toContain("runProductionInboxSync");
    for (const name of [
      "account-erasure",
      "credit-period-refresh",
      "gmail-followup-housekeeping",
    ]) {
      const source = readFileSync(path.join(ROOT, "netlify/functions", `${name}.ts`), "utf8");
      expect(source).not.toMatch(
        /google\.server|dispatchDueGmailSends|runProductionInboxSync|googleapis/,
      );
    }
    const sync = readFileSync(path.join(ROOT, "src/lib/gmail/sync/scheduled.server.ts"), "utf8");
    const worker = readFileSync(path.join(ROOT, "src/lib/gmail/sync/worker.ts"), "utf8");
    expect(sync).not.toMatch(/sendMessage|messages\/send/);
    expect(worker).not.toMatch(/sendMessage|messages\/send/);
  });

  it("declares background schedules and keeps the bearer routes", () => {
    const toml = readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
    expect(toml).toContain('directory = "netlify/functions-built"');
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
    for (const name of [
      "gmail-send-dispatch",
      "gmail-inbox-sync",
      "account-erasure",
      "credit-period-refresh",
      "gmail-followup-housekeeping",
    ]) {
      const block = toml.slice(toml.indexOf(`[functions."${name}"]`));
      const next = block.indexOf("\n[", 1);
      const section = next === -1 ? block : block.slice(0, next);
      expect(section).toContain("background = true");
      expect(section).toContain('node_bundler = "none"');
    }
    expect(INBOX_SYNC_PATH).toBe("/api/internal/gmail-inbox-sync");
    expect(ACCOUNT_ERASURE_PATH).toBe("/api/internal/account-erasure");
    expect(CREDIT_PERIOD_PATH).toBe("/api/internal/credit-period-refresh");
    expect(FOLLOWUP_HOUSEKEEPING_PATH).toBe("/api/internal/gmail-followup-housekeeping");
    expect(GMAIL_SEND_DISPATCH_PATH).toBe("/api/internal/gmail-send-dispatch");
    for (const route of [
      "src/app/api/internal/gmail-inbox-sync/route.ts",
      "src/app/api/internal/account-erasure/route.ts",
      "src/app/api/internal/credit-period-refresh/route.ts",
      "src/app/api/internal/gmail-followup-housekeeping/route.ts",
      "src/app/api/internal/gmail-send-dispatch/route.ts",
    ]) {
      const source = readFileSync(path.join(ROOT, route), "utf8");
      expect(source).toContain("handleDispatchPost");
      expect(source).toContain('import "server-only"');
    }
  });
});
