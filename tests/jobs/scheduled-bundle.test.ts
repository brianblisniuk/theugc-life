/**
 * The deployed function file must load under plain Node, with Gmail mocked
 * by refusing the network. A configured secret is not executed here: that
 * would construct the production client.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  SCHEDULED_FUNCTION_NAMES,
  bundleScheduledFunctions,
  type ScheduledBundle,
} from "../../scripts/bundle-scheduled-functions";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SECRET = "schedule-secret-0001";
const SERVICE_ROLE = "service-role-fixture-value";
const ANON_KEY = "anon-key-fixture-value";
const MAILBOX = "user@example.com";

let built: ScheduledBundle[] = [];

beforeAll(async () => {
  built = await bundleScheduledFunctions();
}, 120_000);

function invoke(
  name: string,
  secretName: string | null,
  secret: string | null,
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NODE_ENV: "test",
  };
  if (secretName && secret) env[secretName] = secret;
  const script = `
    const calls = [];
    global.fetch = async () => {
      calls.push("fetch");
      throw new Error("network");
    };
    const { handler } = require(${JSON.stringify(path.join(ROOT, "netlify", "functions-built", `${name}.js`))});
    handler().then((result) => {
      if (calls.length) {
        console.error("fetch was called");
        process.exit(2);
      }
      process.stdout.write(JSON.stringify(result));
    }).catch((error) => {
      console.error(error && error.message ? "handler threw" : "handler threw");
      process.exit(1);
    });
  `;
  const child = spawnSync(process.execPath, ["-e", script], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

describe("scheduled function bundle", () => {
  it("builds every schedule as CommonJS without the server-only throw", () => {
    expect(built.map((item) => item.name)).toEqual([...SCHEDULED_FUNCTION_NAMES]);
    for (const item of built) {
      expect(item.bytes).toBeGreaterThan(1000);
      expect(item.bytes).toBeLessThanOrEqual(15 * 1024 * 1024);
      const text = readFileSync(item.outfile, "utf8");
      expect(text.startsWith('"use strict"')).toBe(true);
      expect(text).toContain("module.exports");
      expect(text).toContain("handler");
      expect(text).not.toContain("This module cannot be imported from a Client Component");
      expect(text).not.toContain('require("server-only")');
      expect(text).not.toMatch(/^import /m);
      expect(text).not.toMatch(/^export /m);
    }
  });

  it("does not call the network when the secret is missing or short", () => {
    const secrets: Record<string, string> = {
      "gmail-inbox-sync": "GMAIL_SYNC_SECRET",
      "account-erasure": "ACCOUNT_ERASURE_SECRET",
      "credit-period-refresh": "CREDIT_PERIOD_SECRET",
      "gmail-followup-housekeeping": "GMAIL_FOLLOWUP_SECRET",
      "gmail-send-dispatch": "GMAIL_DISPATCH_SECRET",
    };
    for (const name of SCHEDULED_FUNCTION_NAMES) {
      const missing = invoke(name, null, null);
      expect(missing.status, missing.stderr).toBe(0);
      expect(JSON.parse(missing.stdout)).toEqual({
        statusCode: 500,
        body: JSON.stringify({ result: "not_configured" }),
      });
      const short = invoke(name, secrets[name] ?? null, "too-short");
      expect(short.status, short.stderr).toBe(0);
      expect(JSON.parse(short.stdout).statusCode).toBe(500);
      expect(short.stdout).not.toContain("too-short");
    }
  });

  it("does not call the network when the secret is set and the bearer is absent", () => {
    const secrets: Record<string, string> = {
      "gmail-inbox-sync": "GMAIL_SYNC_SECRET",
      "account-erasure": "ACCOUNT_ERASURE_SECRET",
      "credit-period-refresh": "CREDIT_PERIOD_SECRET",
      "gmail-followup-housekeeping": "GMAIL_FOLLOWUP_SECRET",
      "gmail-send-dispatch": "GMAIL_DISPATCH_SECRET",
    };
    for (const name of SCHEDULED_FUNCTION_NAMES) {
      const denied = invoke(name, secrets[name] ?? null, SECRET);
      expect(denied.status, denied.stderr).toBe(0);
      expect(JSON.parse(denied.stdout)).toEqual({
        statusCode: 401,
        body: JSON.stringify({ result: "forbidden" }),
      });
      expect(denied.stdout).not.toContain(SECRET);
    }
  });

  it("reaches the database call on Node 20, where WebSocket is missing", () => {
    const secrets: Record<string, string> = {
      "gmail-inbox-sync": "GMAIL_SYNC_SECRET",
      "account-erasure": "ACCOUNT_ERASURE_SECRET",
      "credit-period-refresh": "CREDIT_PERIOD_SECRET",
      "gmail-followup-housekeeping": "GMAIL_FOLLOWUP_SECRET",
      "gmail-send-dispatch": "GMAIL_DISPATCH_SECRET",
    };
    for (const name of SCHEDULED_FUNCTION_NAMES) {
      const child = invokePastClientInit(name, secrets[name] ?? "");
      expect(child.status, child.stderr).toBe(0);
      const parsed = JSON.parse(child.stdout) as {
        result: { statusCode: number; body: string };
        fetches: number;
      };
      expect(parsed.fetches).toBeGreaterThan(0);
      expect([200, 500]).toContain(parsed.result.statusCode);
      const combined = `${child.stdout}\n${child.stderr}`;
      expect(combined).not.toContain("native WebSocket");
      expect(combined).not.toContain(SECRET);
      expect(combined).not.toContain(SERVICE_ROLE);
      expect(combined).not.toContain(ANON_KEY);
      expect(combined).not.toContain(MAILBOX);
      if (parsed.result.statusCode === 500) {
        const body = JSON.parse(parsed.result.body) as { result: string; code: string };
        expect(body.result).toBe("error");
        expect(body.code).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,39}$/);
        expect(child.stderr).toContain("[job] scheduled run failed");
      }
    }
  });
});

function invokePastClientInit(
  name: string,
  secretName: string,
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NODE_ENV: "test",
    [secretName]: SECRET,
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
    NEXT_PUBLIC_SITE_URL: "https://jobs.example",
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE,
  };
  const script = `
    delete globalThis.WebSocket;
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      const error = new Error("network");
      error.code = "ECONNREFUSED";
      throw error;
    };
    const { handler } = require(${JSON.stringify(path.join(ROOT, "netlify", "functions-built", `${name}.js`))});
    handler({ headers: { authorization: "Bearer " + ${JSON.stringify(SECRET)} } }).then((result) => {
      process.stdout.write(JSON.stringify({ result, fetches: calls.length }));
    }).catch((error) => {
      console.error(error && error.name ? error.name : "handler threw");
      process.exit(1);
    });
  `;
  const child = spawnSync(process.execPath, ["-e", script], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}
