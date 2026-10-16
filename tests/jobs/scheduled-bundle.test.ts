/**
 * The deployed function file must load under plain Node, with Gmail mocked
 * by refusing the network. A configured secret is not executed here: that
 * would construct the production client.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  SCHEDULED_FUNCTION_NAMES,
  bundleScheduledFunctions,
  type ScheduledBundle,
} from "../../scripts/bundle-scheduled-functions";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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
  it("builds every schedule without the server-only throw", () => {
    expect(built.map((item) => item.name)).toEqual([...SCHEDULED_FUNCTION_NAMES]);
    for (const item of built) {
      expect(item.bytes).toBeGreaterThan(1000);
      expect(item.bytes).toBeLessThanOrEqual(15 * 1024 * 1024);
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
});
