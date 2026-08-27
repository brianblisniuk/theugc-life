/**
 * A05 PUBLICATION APPLY CLI — dry-run by default.
 *
 *   npm run source:publication:apply -- \
 *     --source hotelbeds --environment production --as-of YYYY-MM-DD \
 *     --manifest .data/source-publication/authorized.json [--apply]
 *
 * Without `--apply` the whole transaction is rolled back, so a dry-run exercises
 * exactly the same code — the same pins, the same recomputed D062, the same
 * constraints, the same writes — and leaves nothing behind.
 *
 * With `--apply` this command CREATES CANONICAL INVENTORY. It is the only
 * command in the repository that does, and it requires an explicit persistent
 * `DATABASE_URL`; `TEST_DATABASE_URL` is never a fallback here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import { isValidIsoDate } from "../lifecycle/policy";
import { applyPublicationManifest, PublicationRefusal, type PublicationItem } from "./publish";
import { resolvePublicationTarget } from "./target";

export interface PublishArgs {
  source: string;
  environment: "evaluation" | "production";
  asOf: string;
  manifest: string;
  apply: boolean;
}

export function parsePublishArgs(argv: readonly string[]): PublishArgs {
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
    throw new Error("--manifest <path> is required: an authorized publication manifest.");
  return { source, environment, asOf, manifest, apply: argv.includes("--apply") };
}

export function readPublicationManifest(file: string): PublicationItem[] {
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
      "Manifest must be an array of publication items, or an object with an `items` array.",
    );
  return items as PublicationItem[];
}

async function main(): Promise<void> {
  const args = parsePublishArgs(process.argv.slice(2));
  const target = resolvePublicationTarget(process.env, { apply: args.apply });
  const items = readPublicationManifest(args.manifest);

  const client = new Client({ connectionString: target.url });
  await client.connect();
  try {
    console.info("\n[source-publication:apply] A05 atomic D062 publication\n");
    console.info(
      `  mode          ${args.apply ? "APPLY (creates canonical inventory)" : "DRY-RUN (nothing is written)"}`,
    );
    console.info(`  database      ${target.classification.redactedTarget}`);
    console.info(`  source        ${args.source} / ${args.environment}`);
    console.info(`  as-of         ${args.asOf}  (explicit; never the system clock)`);
    console.info(`  manifest      ${items.length} authorized item(s)\n`);

    const report = await applyPublicationManifest(client, items, {
      source: args.source,
      environment: args.environment,
      asOf: args.asOf,
      apply: args.apply,
    });

    const tally: Record<string, number> = {};
    for (const o of report.outcomes) tally[o.state] = (tally[o.state] ?? 0) + 1;
    for (const [state, n] of Object.entries(tally).sort())
      console.info(`  ${String(n).padStart(5)}  ${state}`);
    console.info("");
    for (const o of report.outcomes) {
      if (o.state === "refused")
        console.info(`  REFUSED ${o.sourcePropertyId}: ${o.refusal}\n            ${o.detail}`);
      else
        console.info(
          `  ${o.state.toUpperCase()} ${o.sourcePropertyId}: hotel ${o.hotelId}, link ${o.hotelSourceIdentityId}, receipt ${o.publicationReceiptId}`,
        );
    }
    console.info(
      `\n  canonical writes: ${report.canonicalWrites.hotels} hotels, ` +
        `${report.canonicalWrites.hotelSourceIdentities} hotel_source_identities, ` +
        `${report.canonicalWrites.publicationReceipts} publication receipts\n` +
        "  A05 writes no hotel_contacts, no media and no intelligence. Publication is identity, not enrichment.\n",
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
    const prefix = error instanceof PublicationRefusal ? "REFUSED" : "failed";
    console.error(`\n[source-publication:apply] ${prefix}: ${message}\n`);
    process.exitCode = error instanceof PublicationRefusal ? 2 : 1;
  });
