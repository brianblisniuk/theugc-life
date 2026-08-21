/**
 * READ-ONLY review-pack CLI.
 *
 *   npm run source:human-review:prepare -- \
 *     --source hotelbeds --environment evaluation --as-of 2026-08-17 \
 *     --destination bali --limit 10 --out .data/human-review/pack.json
 *
 * Writes a pack whose human-decision fields are EMPTY. This command never
 * decides anything, and there is no --apply here.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import { isValidIsoDate } from "../lifecycle/policy";
import { buildReviewPack } from "./pack";
import { resolveReviewWriteTarget } from "./target";

export interface PrepareArgs {
  source: string;
  environment: "evaluation" | "production";
  asOf: string;
  destinationSlug: string | null;
  limit: number;
  out: string | null;
  require: string[];
}

export function parsePrepareArgs(argv: readonly string[]): PrepareArgs {
  const get = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
  };
  const asOf = get("as-of");
  if (!asOf || !isValidIsoDate(asOf))
    throw new Error("--as-of YYYY-MM-DD is required and must be a real date. No clock is read.");
  const environment = get("environment");
  if (environment !== "evaluation" && environment !== "production")
    throw new Error("--environment must be explicit: evaluation or production.");
  const source = get("source");
  if (!source) throw new Error("--source <provider> is required and has no implicit default.");
  const limitRaw = get("limit");
  const limit = limitRaw === null ? 25 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer.");
  return {
    source,
    environment,
    asOf,
    destinationSlug: get("destination"),
    limit,
    out: get("out"),
    require: (get("require") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

async function main(): Promise<void> {
  const args = parsePrepareArgs(process.argv.slice(2));
  // Prepare never writes, but it must still refuse an unclassifiable target: a
  // review pack built from a database nobody can identify is not evidence.
  const target = resolveReviewWriteTarget(process.env, {
    environment: args.environment,
    apply: false,
  });
  const client = new Client({ connectionString: target.url });
  await client.connect();
  try {
    const pack = await buildReviewPack(client, args);
    const json = JSON.stringify(pack, null, 2);
    if (args.out) {
      mkdirSync(path.dirname(args.out), { recursive: true });
      writeFileSync(args.out, json + "\n");
      console.info(
        `[human-review:prepare] ${pack.items.length} item(s) written to ${args.out}\n` +
          `  evaluated ${pack.preparedFrom.evaluated}, human-review-ready ${pack.preparedFrom.ready}\n` +
          "  Every human-decision field is EMPTY. This command decides nothing.",
      );
    } else {
      console.info(json);
    }
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly)
  main().catch((error: unknown) => {
    console.error(
      `\n[human-review:prepare] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
