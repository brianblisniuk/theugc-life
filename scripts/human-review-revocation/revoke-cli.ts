/**
 * REVOCATION APPLY CLI — dry-run by default.
 *
 *   npm run source:review:revoke:apply -- \
 *     --source hotelbeds --environment evaluation \
 *     --manifest .data/human-review/revocation.json [--apply]
 *
 * A separate command under a separate namespace, on purpose. Withdrawing
 * authorization is not a variant of reviewing, and nobody should reach it by
 * adding a flag to the command they use every day.
 *
 * Without `--apply` the transaction is rolled back, so a dry-run exercises the
 * same pins, the same idempotency check and the same constraints, and leaves
 * nothing behind. Either way this command writes NO canonical row: revoking is
 * the opposite of publishing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import { resolveReviewWriteTarget } from "../human-review/target";
import { applyRevocationManifest, RevocationRefusal, type RevocationItem } from "./revoke";

export interface RevokeApplyArgs {
  source: string;
  environment: "evaluation" | "production";
  manifest: string;
  apply: boolean;
}

export function parseRevokeApplyArgs(argv: readonly string[]): RevokeApplyArgs {
  const get = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
  };
  const environment = get("environment");
  if (environment !== "evaluation" && environment !== "production")
    throw new Error("--environment must be explicit: evaluation or production.");
  const source = get("source");
  if (!source) throw new Error("--source <provider> is required and has no implicit default.");
  const manifest = get("manifest");
  if (!manifest)
    throw new Error("--manifest <path> is required: a revocation manifest a human filled in.");
  return { source, environment, manifest, apply: argv.includes("--apply") };
}

/**
 * A prepared pack carries EMPTY `reviewerLabel`/`revocationNote` placeholders, so
 * a manifest handed straight back unedited is a manifest nobody actually
 * decided. `validateRevocationItem` refuses those, which is the intent.
 */
export function readRevocationManifest(file: string): RevocationItem[] {
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
      "Manifest must be an array of revocation items, or an object with an `items` array.",
    );
  return items as RevocationItem[];
}

async function main(): Promise<void> {
  const args = parseRevokeApplyArgs(process.argv.slice(2));
  const target = resolveReviewWriteTarget(process.env, {
    environment: args.environment,
    apply: args.apply,
  });
  const items = readRevocationManifest(args.manifest);

  const client = new Client({ connectionString: target.url });
  await client.connect();
  try {
    console.info("\n[review:revoke] A04.6 withdrawal of a previous human approval\n");
    console.info(`  mode          ${args.apply ? "APPLY" : "DRY-RUN (nothing is written)"}`);
    console.info(`  database      ${target.classification.redactedTarget}`);
    console.info(`  source        ${args.source} / ${args.environment}`);
    console.info(`  manifest      ${items.length} revocation(s)\n`);

    const report = await applyRevocationManifest(client, items, {
      source: args.source,
      environment: args.environment,
      apply: args.apply,
    });

    const tally: Record<string, number> = {};
    for (const o of report.outcomes) tally[o.state] = (tally[o.state] ?? 0) + 1;
    for (const [state, n] of Object.entries(tally).sort())
      console.info(`  ${String(n).padStart(5)}  ${state}`);
    console.info("");
    for (const o of report.outcomes)
      if (o.state === "refused")
        console.info(`  REFUSED ${o.sourcePropertyId}: ${o.refusal}\n            ${o.detail}`);

    console.info(
      "\n  canonical writes: 0 hotels, 0 hotel_source_identities, 0 hotel_contacts\n" +
        "  A revocation removes authorization. It never publishes, deletes or rewrites history.\n" +
        "  There is no un-revoke: a later approval is a fresh review of fresh evidence.\n",
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
    const prefix = error instanceof RevocationRefusal ? "REFUSED" : "failed";
    console.error(`\n[review:revoke] ${prefix}: ${message}\n`);
    process.exitCode = error instanceof RevocationRefusal ? 2 : 1;
  });
