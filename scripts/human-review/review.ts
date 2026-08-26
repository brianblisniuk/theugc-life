/**
 * REVIEW APPLY CLI — dry-run by default.
 *
 *   npm run source:human-review:apply -- \
 *     --source hotelbeds --environment evaluation --as-of 2026-08-17 \
 *     --manifest .data/human-review/reviewed.json [--apply]
 *
 * Without `--apply` the whole transaction is rolled back, so a dry-run exercises
 * exactly the same code — the same stale checks, the same readiness recompute,
 * the same constraints — and leaves nothing behind.
 *
 * This command NEVER writes a canonical hotel. There is no publication here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import { isValidIsoDate } from "../lifecycle/policy";
import { applyReviewedManifest, ReviewRefusal, type ReviewedItem } from "./apply";
import { resolveReviewWriteTarget } from "./target";

export interface ApplyArgs {
  source: string;
  environment: "evaluation" | "production";
  asOf: string;
  manifest: string;
  apply: boolean;
}

export function parseApplyArgs(argv: readonly string[]): ApplyArgs {
  const get = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
  };
  const asOf = get("as-of");
  if (!asOf || !isValidIsoDate(asOf))
    throw new Error("--as-of YYYY-MM-DD is required and must be a real date.");
  const environment = get("environment");
  if (environment !== "evaluation" && environment !== "production")
    throw new Error("--environment must be explicit: evaluation or production.");
  const source = get("source");
  if (!source) throw new Error("--source <provider> is required and has no implicit default.");
  const manifest = get("manifest");
  if (!manifest)
    throw new Error("--manifest <path> is required: a reviewed manifest a human filled in.");
  return { source, environment, asOf, manifest, apply: argv.includes("--apply") };
}

export function readManifest(file: string): ReviewedItem[] {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  const items = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" &&
        parsed !== null &&
        Array.isArray((parsed as { items?: unknown }).items)
      ? (parsed as { items: unknown[] }).items
      : null;
  if (!items)
    throw new Error(
      "Manifest must be an array of reviewed items, or an object with an `items` array.",
    );
  return items as ReviewedItem[];
}

async function main(): Promise<void> {
  const args = parseApplyArgs(process.argv.slice(2));
  const target = resolveReviewWriteTarget(process.env, {
    environment: args.environment,
    apply: args.apply,
  });
  const items = readManifest(args.manifest);

  const client = new Client({ connectionString: target.url });
  await client.connect();
  try {
    console.info("\n[human-review:apply] A04.5 human pre-publication review evidence\n");
    console.info(`  mode          ${args.apply ? "APPLY" : "DRY-RUN (nothing is written)"}`);
    console.info(`  database      ${target.classification.redactedTarget}`);
    console.info(`  source        ${args.source} / ${args.environment}`);
    console.info(`  as-of         ${args.asOf}  (explicit; never the system clock)`);
    console.info(`  manifest      ${items.length} reviewed item(s)\n`);

    const report = await applyReviewedManifest(client, items, {
      source: args.source,
      environment: args.environment,
      asOf: args.asOf,
      apply: args.apply,
    });

    const tally: Record<string, number> = {};
    for (const o of report.outcomes) tally[o.state] = (tally[o.state] ?? 0) + 1;
    for (const [state, n] of Object.entries(tally).sort()) {
      console.info(`  ${String(n).padStart(5)}  ${state}`);
    }
    console.info("");
    for (const o of report.outcomes) {
      if (o.state === "refused")
        console.info(`  REFUSED ${o.sourcePropertyId}: ${o.refusal}\n            ${o.detail}`);
    }
    console.info(
      "\n  canonical writes: 0 hotels, 0 hotel_source_identities, 0 hotel_contacts\n" +
        "  A04.5 records evidence. Publication remains A05, and A04 remains a preview.\n",
    );
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly)
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const prefix = error instanceof ReviewRefusal ? "REFUSED" : "failed";
    console.error(`\n[human-review:apply] ${prefix}: ${message}\n`);
    process.exitCode = error instanceof ReviewRefusal ? 2 : 1;
  });
