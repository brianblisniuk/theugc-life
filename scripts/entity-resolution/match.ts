/**
 * source:match — pre-publication entity-resolution EVIDENCE.
 *
 *   npm run source:match -- --provider hotelbeds
 *   npm run source:match -- --provider hotelbeds --apply
 *
 * DRY-RUN by default. Local/disposable database only, evaluation-locked, and it
 * makes no provider request of any kind — every input is already in Postgres.
 *
 * It answers "what else could this source property be?" and never "should this
 * be published?". It writes NO `hotels`, NO `hotel_source_identities`, NO
 * `source_property_reviews`, NO `new_property` candidate, and it moves no
 * identity out of `unresolved`. There is no SQL for any of those here.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import {
  resolveIngestionTarget,
  UnsafeIngestionTargetError,
} from "../provider-ingestion/db-target";
import { BLOCKING_REASONS } from "./candidates";
import { generateCandidates } from "./writer";

const EVALUATION = "evaluation" as const;

export interface MatchArgs {
  provider: string;
  apply: boolean;
  clusters: number;
}

export function parseArgs(argv: readonly string[]): MatchArgs {
  const get = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
  };
  const environment = get("environment");
  if (environment && environment !== EVALUATION) {
    throw new Error(
      `--environment ${environment} is not available. Entity-resolution evidence is locked to ` +
        "`evaluation` in this block: production ingestion does not exist yet.",
    );
  }
  return {
    provider: get("provider") ?? "hotelbeds",
    apply: argv.includes("--apply"),
    clusters: Number(get("clusters") ?? 10),
  };
}

function table(title: string, bucket: Record<string, number>): void {
  const entries = Object.entries(bucket).sort((a, b) => b[1] - a[1]);
  console.info(`    ${title.padEnd(22)}${entries.map(([k, v]) => `${k}=${v}`).join("  ") || "—"}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = resolveIngestionTarget(process.env);

  console.info("\n[source:match] pre-publication entity-resolution evidence\n");
  console.info(`  mode          ${args.apply ? "APPLY" : "DRY-RUN (no writes)"}`);
  console.info(`  provider      ${args.provider}`);
  console.info(`  environment   ${EVALUATION} (locked)`);
  console.info(`  database      ${target.classification.redactedTarget}`);
  console.info("");

  const client = new Client({ connectionString: target.url });
  await client.connect();
  try {
    const started = Date.now();
    const counts = await generateCandidates(client, {
      source: args.provider,
      environment: EVALUATION,
      runId: null,
      apply: args.apply,
    });
    const ms = Date.now() - started;

    console.info(`  identities evaluated       ${counts.identities}`);
    console.info(`  with >=1 machine candidate ${counts.identitiesWithCandidate}`);
    console.info(
      `  NO MACHINE CANDIDATE       ${counts.identitiesWithoutCandidate}   <- NOT "new property"`,
    );
    console.info(`  candidate pairs            ${counts.pairs}`);
    console.info("");
    console.info("  BLOCKING REASON (a reason to COMPARE, never a match)");
    for (const reason of BLOCKING_REASONS) {
      console.info(`    ${reason.padEnd(28)}${counts.pairsByReason[reason]}`);
    }
    console.info("");
    console.info("  SHARED-KEY CLUSTERS (a key naming a GROUP — never expanded to pairs)");
    console.info(`    clusters              ${counts.sharedKeyClusters}`);
    console.info(`    identities involved   ${counts.sharedKeyClusteredIdentities}`);
    const biggest = [...counts.discovery.sharedKeyClusters]
      .sort((a, b) => b.identityIds.length - a.identityIds.length)
      .slice(0, args.clusters);
    for (const c of biggest) {
      console.info(`      ${c.reason.padEnd(28)}${c.key} → ${c.identityIds.length} identities`);
    }
    console.info("");
    console.info("  CROSS-DESTINATION COLLISIONS (anomaly for review, never a pair)");
    console.info(`    collisions            ${counts.crossDestinationCollisions}`);
    for (const c of counts.discovery.crossDestinationCollisions.slice(0, args.clusters)) {
      console.info(`      ${c.reason.padEnd(28)}${c.key} → ${c.identityIds.length} identities`);
    }
    console.info("");
    console.info("  INCOMPLETE GEOGRAPHY (destination unknown — never a pair)");
    console.info(`    shared keys           ${counts.discovery.incompleteGeography.length}`);
    for (const c of counts.discovery.incompleteGeography.slice(0, args.clusters)) {
      console.info(`      ${c.reason.padEnd(28)}${c.key} → ${c.identityIds.length} identities`);
    }
    console.info("");
    console.info("  PAIR EVIDENCE");
    table("name", counts.evidence.name);
    table("domain", counts.evidence.domain);
    table("address", counts.evidence.address);
    table("phone", counts.evidence.phone);
    table("brand", counts.evidence.brand);
    console.info(
      `    coordinate distance   known on ${counts.evidence.coordinateDistanceKnown} pairs (raw metres, no threshold)`,
    );
    table(
      "agreeing_dimensions",
      Object.fromEntries(Object.entries(counts.agreeingDimensions).map(([k, v]) => [k, v])),
    );
    console.info("      ^ descriptive only. Nothing in this codebase compares it to a number.");
    console.info("");
    console.info("  WRITES");
    console.info(`    candidates created    ${counts.candidatesCreated}`);
    console.info(`    evidence refreshed    ${counts.candidatesEvidenceUpdated}`);
    console.info(`    already decided       ${counts.candidatesDecidedSkipped} (left untouched)`);
    console.info(
      `    stood down            ${counts.candidatesSuperseded} (no current blocking rule)`,
    );
    console.info(`    reactivated           ${counts.candidatesReactivated} (evidence returned)`);
    console.info("    new_property rows     0 (only an explicit review finding may create one)");
    console.info("");
    console.info("  canonical writes: 0 hotels, 0 links, 0 reviews, 0 terminal transitions");
    console.info(`  duration      ${ms} ms`);
    console.info(args.apply ? "" : "\n  Re-run with --apply to write.\n");
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((err: unknown) => {
    if (err instanceof UnsafeIngestionTargetError) {
      console.error(`\n[source:match] STOP\n\n${err.message}\n`);
      process.exit(2);
    }
    console.error(`\n[source:match] failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
