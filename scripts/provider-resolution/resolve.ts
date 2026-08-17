/**
 * source:resolve — pre-publication star, location and physical-hospitality
 * resolution.
 *
 *   npm run source:resolve -- --provider hotelbeds --destination bali
 *   npm run source:resolve -- --provider hotelbeds --destination bali --apply
 *
 * DRY-RUN by default. Local/disposable database only, evaluation-locked, and it
 * makes no provider request of any kind — every input is already in Postgres.
 *
 * It writes NO canonical row: no `hotels`, no `hotel_source_identities`, no
 * match candidate, no review, and it moves no identity out of `unresolved`.
 * There is no SQL for any of those tables in this directory.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import {
  resolveIngestionTarget,
  UnsafeIngestionTargetError,
} from "../provider-ingestion/db-target";
import { CLASSIFICATION_POLICIES, resolveDestination } from "./resolver";

const EVALUATION = "evaluation" as const;

export interface ResolveArgs {
  provider: string;
  destination: string | null;
  apply: boolean;
}

export function parseArgs(argv: readonly string[]): ResolveArgs {
  const get = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
  };

  const environment = get("environment");
  if (environment && environment !== EVALUATION) {
    throw new Error(
      `--environment ${environment} is not available. Pre-publication resolution is locked to ` +
        "`evaluation` in this block: production ingestion does not exist yet, so there is no " +
        "production data to resolve.",
    );
  }

  const provider = get("provider") ?? "hotelbeds";
  if (!CLASSIFICATION_POLICIES[provider]) {
    throw new Error(
      `No reviewed classification policy for '${provider}'. Known: ` +
        `${Object.keys(CLASSIFICATION_POLICIES).join(", ")}.`,
    );
  }

  return { provider, destination: get("destination"), apply: argv.includes("--apply") };
}

export async function resolveDestinationId(client: Client, slug: string): Promise<string> {
  const res = await client.query<{ id: string }>(
    "select id from public.destinations where slug = $1",
    [slug],
  );
  const row = res.rows[0];
  if (!row) {
    throw new Error(`Canonical destination '${slug}' does not exist in public.destinations.`);
  }
  return row.id;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = resolveIngestionTarget(process.env);

  console.info("\n[source:resolve] pre-publication star + location + scope resolution\n");
  console.info(`  mode          ${args.apply ? "APPLY" : "DRY-RUN (no writes)"}`);
  console.info(`  provider      ${args.provider}`);
  console.info(`  environment   ${EVALUATION} (locked)`);
  console.info(`  destination   ${args.destination ?? "(all)"}`);
  console.info(`  database      ${target.classification.redactedTarget}`);
  console.info("");

  const client = new Client({ connectionString: target.url });
  await client.connect();
  try {
    const destinationId = args.destination
      ? await resolveDestinationId(client, args.destination)
      : null;

    const started = Date.now();
    const counts = await resolveDestination(client, {
      source: args.provider,
      environment: EVALUATION,
      destinationId,
      apply: args.apply,
    });
    const ms = Date.now() - started;

    const { star, location } = counts;
    const starTotal =
      star.exact_four + star.exact_five + star.classified_not_v1_scope + star.unresolved;

    console.info(`  candidates              ${counts.identities}`);
    console.info("");
    console.info("  STAR");
    console.info(`    exact_four            ${star.exact_four}`);
    console.info(`    exact_five            ${star.exact_five}`);
    console.info(`    classified_not_v1     ${star.classified_not_v1_scope}`);
    console.info(`    unresolved            ${star.unresolved}`);
    console.info(
      `    ---- total            ${starTotal}${starTotal === counts.identities ? " ✓ accounts for every candidate" : " ✗ MISMATCH"}`,
    );
    console.info(`    conflicts             ${counts.starConflicts}`);
    console.info("");
    console.info("  LOCATION");
    console.info(`    resolved              ${location.resolved}`);
    console.info(`    coordinates_missing   ${location.coordinates_missing}`);
    console.info(`    coordinates_implaus.  ${location.coordinates_implausible}`);
    console.info(`    plausibility_unknown  ${location.coordinates_plausibility_unknown}`);
    const locTotal =
      location.resolved +
      location.coordinates_missing +
      location.coordinates_implausible +
      location.coordinates_plausibility_unknown;
    console.info(
      `    ---- total            ${locTotal}${locTotal === counts.identities ? " ✓ accounts for every candidate" : " ✗ MISMATCH"}`,
    );
    console.info(`    conflicts             ${counts.locationConflicts}`);
    console.info("");
    // PHYSICAL HOSPITALITY — a D062 INPUT, not V1 eligibility. D060: property
    // type alone does not decide eligibility.
    console.info("  SCOPE (physical hospitality)");
    console.info(`    physical_hospitality  ${counts.scope.physical_hospitality}`);
    console.info(`    not_physical_hosp.    ${counts.scope.not_physical_hospitality}`);
    console.info(`    unresolved            ${counts.scope.unresolved}`);
    const scopeTotal =
      counts.scope.physical_hospitality +
      counts.scope.not_physical_hospitality +
      counts.scope.unresolved;
    console.info(
      `    ---- total            ${scopeTotal}${scopeTotal === counts.identities ? " ✓ accounts for every candidate" : " ✗ MISMATCH"}`,
    );
    console.info("");
    console.info("  STAR x SCOPE (composed by NEITHER — this is not eligibility)");
    for (const so of ["exact_four", "exact_five", "classified_not_v1_scope", "unresolved"]) {
      const cells = ["physical_hospitality", "not_physical_hospitality", "unresolved"]
        .map((sc) => `${sc.replace("_hospitality", "")}=${counts.starByScope[`${so}|${sc}`] ?? 0}`)
        .join("  ");
      console.info(`    ${so.padEnd(24)}${cells}`);
    }
    console.info("");
    // Append-only bookkeeping. On a replay of identical evidence under an
    // identical policy every one of these must be 0 — that is the whole claim.
    console.info("  APPEND-ONLY LEDGER");
    console.info(
      `    revisions appended    star ${counts.revisionsCreated.star}, location ${counts.revisionsCreated.location}, scope ${counts.revisionsCreated.scope}`,
    );
    console.info(
      `    head pointers moved   star ${counts.pointerMoves.star}, location ${counts.pointerMoves.location}, scope ${counts.pointerMoves.scope}`,
    );
    console.info("");
    console.info("  canonical writes: 0 hotels, 0 links, 0 candidates, 0 reviews");
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
      console.error(`\n[source:resolve] STOP\n\n${err.message}\n`);
      process.exit(2);
    }
    console.error(`\n[source:resolve] failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
