/**
 * Bundle Netlify scheduled functions for a runtime that is not Next.js.
 *
 * Netlify's function bundler does not apply the `react-server` export
 * condition, so `import "server-only"` throws when the function loads.
 * It also does not read the `@/` TypeScript paths. This script bundles each
 * function with those two resolved, then Netlify ships the file as-is
 * (`node_bundler = "none"`). The real `server-only` package stays in place
 * for the Next.js build.
 *
 * The script prints function names and byte sizes. It does not print env
 * values. A forbidden import fails the build.
 */
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const OUT_DIR = path.join(ROOT, "netlify", "functions-built");
const SHIM = path.join(ROOT, "scripts", "shims", "server-only.js");
const MAX_BYTES = 15 * 1024 * 1024;

export const SCHEDULED_FUNCTION_NAMES = [
  "gmail-inbox-sync",
  "account-erasure",
  "credit-period-refresh",
  "gmail-followup-housekeeping",
  "gmail-send-dispatch",
] as const;

export type ScheduledFunctionName = (typeof SCHEDULED_FUNCTION_NAMES)[number];

const SERVER_ONLY_THROW = "This module cannot be imported from a Client Component";

const SHARED_FORBIDDEN_TEXT = [
  SERVER_ONLY_THROW,
  "ci-service-role-key",
  "sk-ant-",
  "BEGIN PRIVATE KEY",
  "ANTHROPIC_API_KEY",
];

const NO_PROVIDER = [
  "src/lib/ai/claude.server.ts",
  "src/lib/ai/compose.server.ts",
  "src/lib/contacts/hunter.server.ts",
  "src/lib/contacts/hunter-store.server.ts",
  "node_modules/server-only/index.js",
  "node_modules/@anthropic-ai/",
];

const NO_GMAIL = [
  ...NO_PROVIDER,
  "src/lib/gmail/google.server.ts",
  "src/lib/gmail/send/",
  "src/lib/gmail/sync/scheduled.server.ts",
  "node_modules/google-auth-library/",
];

const RULES: Record<ScheduledFunctionName, { forbid: string[]; require: string[] }> = {
  "gmail-inbox-sync": {
    forbid: [...NO_PROVIDER, "src/lib/gmail/send/"],
    require: [
      "src/lib/gmail/sync/scheduled.server.ts",
      "src/lib/gmail/google.server.ts",
      "src/lib/gmail/sync/read-adapter.ts",
      "scripts/shims/server-only.js",
    ],
  },
  "account-erasure": {
    forbid: NO_GMAIL,
    require: [
      "src/lib/jobs/maintenance.ts",
      "src/lib/supabase/admin.ts",
      "scripts/shims/server-only.js",
    ],
  },
  "credit-period-refresh": {
    forbid: NO_GMAIL,
    require: [
      "src/lib/jobs/maintenance.ts",
      "src/lib/supabase/admin.ts",
      "scripts/shims/server-only.js",
    ],
  },
  "gmail-followup-housekeeping": {
    forbid: NO_GMAIL,
    require: [
      "src/lib/jobs/maintenance.ts",
      "src/lib/supabase/admin.ts",
      "scripts/shims/server-only.js",
    ],
  },
  "gmail-send-dispatch": {
    forbid: NO_PROVIDER,
    require: [
      "src/lib/gmail/send/dispatch.ts",
      "src/lib/gmail/send/guard.ts",
      "src/lib/gmail/google.server.ts",
      "scripts/shims/server-only.js",
    ],
  },
};

export interface ScheduledBundle {
  name: ScheduledFunctionName;
  outfile: string;
  bytes: number;
  inputs: string[];
}

function aliasPlugin(): esbuild.Plugin {
  return {
    name: "scheduled-job-aliases",
    setup(build) {
      build.onResolve({ filter: /^server-only$/ }, () => ({ path: SHIM }));
      build.onResolve({ filter: /^next(\/|$)/ }, (args) => ({
        errors: [{ text: `scheduled function must not import ${args.path}` }],
      }));
      build.onResolve({ filter: /^@\// }, async (args) => {
        return build.resolve(`./${args.path.slice(2)}`, {
          resolveDir: SRC,
          kind: args.kind,
        });
      });
    },
  };
}

function relativeInput(filePath: string): string {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function assertBundle(name: ScheduledFunctionName, outfile: string, inputs: string[]): void {
  const rules = RULES[name];
  for (const required of rules.require) {
    if (!inputs.some((input) => input.includes(required))) {
      throw new Error(`${name} bundle is missing ${required}`);
    }
  }
  for (const forbidden of rules.forbid) {
    const hit = inputs.find((input) => input.includes(forbidden));
    if (hit) throw new Error(`${name} bundle includes forbidden module ${hit}`);
  }
  const text = readFileSync(outfile, "utf8");
  for (const marker of SHARED_FORBIDDEN_TEXT) {
    if (text.includes(marker)) {
      throw new Error(`${name} bundle contains forbidden marker ${marker}`);
    }
  }
  if (!text.includes("process.env.")) {
    throw new Error(`${name} bundle inlined process.env`);
  }
  const bytes = statSync(outfile).size;
  if (bytes > MAX_BYTES) {
    throw new Error(`${name} bundle is ${bytes} bytes`);
  }
}

export async function bundleScheduledFunctions(): Promise<ScheduledBundle[]> {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const built: ScheduledBundle[] = [];
  for (const name of SCHEDULED_FUNCTION_NAMES) {
    const outfile = path.join(OUT_DIR, `${name}.js`);
    const result = await esbuild.build({
      absWorkingDir: ROOT,
      entryPoints: [path.join(ROOT, "netlify", "functions", `${name}.ts`)],
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      minify: false,
      legalComments: "none",
      logLevel: "warning",
      plugins: [aliasPlugin()],
      metafile: true,
    });
    const inputs = Object.keys(result.metafile?.inputs ?? {}).map((input) =>
      relativeInput(path.resolve(ROOT, input)),
    );
    assertBundle(name, outfile, inputs);
    const bytes = statSync(outfile).size;
    built.push({ name, outfile, bytes, inputs });
  }
  return built;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (invokedDirectly()) {
  bundleScheduledFunctions()
    .then((built) => {
      for (const item of built) {
        console.log(`${item.name} ${item.bytes}`);
      }
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "bundle failed";
      console.error(message);
      process.exit(1);
    });
}
