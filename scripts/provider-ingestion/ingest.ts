/**
 * source:ingest — replay a cached provider evaluation into the 0027 source
 * infrastructure.
 *
 *   npm run source:ingest -- --provider hotelbeds --destination bali
 *   npm run source:ingest -- --provider hotelbeds --destination bali --apply
 *
 * DRY-RUN BY DEFAULT. `--apply` is required for any write, the target must be a
 * disposable local database, and the environment is locked to `evaluation` with
 * no flag to change it.
 *
 * This command makes NO provider requests and needs no provider credentials.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import { buildBatch } from "./adapters/hotelbeds-cached";
import {
  ArtifactConsistencyError,
  assertArtifactsConsistent,
  assertGeographyConsistent,
  GeographyContradictionError,
} from "./consistency";
import { resolveIngestionTarget, UnsafeIngestionTargetError } from "./db-target";
import {
  buildManifest,
  HOTELBEDS_CACHED_SELECTIONS,
  manifestPath,
  MissingArtifactError,
  ArtifactDigestMismatchError,
  ManifestIntegrityError,
  verifyManifest,
  type IngestionManifest,
} from "./manifest";
import { applyIngestion, previewIngestion, DEFAULT_CHUNK_SIZE } from "./writer";
import type { AdapterOutcome } from "./adapters/hotelbeds-cached";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

interface Args {
  provider: string;
  destination: string;
  apply: boolean;
  chunkSize: number;
  refreshManifest: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
  };

  // There is no production ingestion mode in this block, so an explicit attempt
  // to reach one is an error rather than a silently ignored flag.
  const environment = get("environment");
  if (environment && environment !== "evaluation") {
    throw new Error(
      `--environment ${environment} is not available. Provider ingestion is locked to ` +
        "`evaluation` in this block: there is no production ingestion path yet, and this " +
        "flag exists only to refuse the request explicitly rather than ignore it.",
    );
  }

  const provider = get("provider") ?? "hotelbeds";
  const destination = get("destination");
  if (!destination) {
    throw new Error("--destination is required (e.g. --destination bali).");
  }

  const chunkRaw = get("chunk-size");
  const chunkSize = chunkRaw ? Number(chunkRaw) : DEFAULT_CHUNK_SIZE;
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 5000) {
    throw new Error("--chunk-size must be an integer between 1 and 5000.");
  }

  return {
    provider,
    destination,
    apply: argv.includes("--apply"),
    chunkSize,
    refreshManifest: argv.includes("--refresh-manifest"),
  };
}

/**
 * Get the manifest for this destination: reuse the frozen one when present,
 * otherwise freeze a new one. Either way every artifact is re-hashed before use.
 */
export async function resolveManifest(args: Args): Promise<IngestionManifest> {
  const selection = HOTELBEDS_CACHED_SELECTIONS[args.destination];
  if (!selection || selection.provider !== args.provider) {
    throw new Error(
      `No cached artifact selection for ${args.provider}/${args.destination}. ` +
        `Known: ${Object.keys(HOTELBEDS_CACHED_SELECTIONS).join(", ")}. ` +
        "Artifacts are selected explicitly, never discovered by globbing .data/.",
    );
  }

  const provisional = await buildManifest(selection, REPO_ROOT);
  const target = path.resolve(REPO_ROOT, manifestPath(provisional));

  if (existsSync(target) && !args.refreshManifest) {
    const frozen = JSON.parse(readFileSync(target, "utf8")) as IngestionManifest;
    // Re-hash against the FROZEN manifest: if an artifact changed since it was
    // written, this throws rather than ingesting new bytes under an old identity.
    await verifyManifest(frozen, REPO_ROOT);
    return frozen;
  }

  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(provisional, null, 2)}\n`, "utf8");
  return provisional;
}

export async function resolveDestinationId(client: Client, slug: string): Promise<string> {
  const res = await client.query<{ id: string; name: string }>(
    "select id, name from public.destinations where slug = $1",
    [slug],
  );
  const row = res.rows[0];
  if (!row) {
    throw new Error(
      `Canonical destination '${slug}' does not exist in public.destinations. ` +
        "This block does not create destinations — add it through the destination CLI first.",
    );
  }
  return row.id;
}

function summarize(manifest: IngestionManifest, outcome: AdapterOutcome): void {
  const { evidence } = manifest;
  const obs = outcome.observations;
  const withCoords = obs.filter((o) => o.latitude !== null && o.longitude !== null).length;
  const plausible = obs.filter((o) => o.coordinatesPlausible === true).length;
  const implausible = obs.filter((o) => o.coordinatesPlausible === false).length;
  const missingCoords = obs.length - withCoords;
  const classificationResolved = obs.filter((o) => o.classificationSimpleCode !== null).length;
  const withImages = obs.filter((o) => (o.imageCount ?? 0) > 0).length;
  const totalImages = obs.reduce((n, o) => n + (o.imageCount ?? 0), 0);
  const principal = obs.filter((o) => o.providerDesignatedPrincipalImage === true).length;

  console.info(`  manifest digest       ${manifest.manifestDigest}`);
  console.info(`  source / environment  ${manifest.provider} / ${manifest.sourceEnvironment}`);
  console.info(`  destination           ${manifest.destinationSlug}`);
  console.info(`  provider geography    ${JSON.stringify(manifest.providerGeography)}`);
  console.info(`  observed_at           ${manifest.observedAt}  (${manifest.observedAtBasis})`);
  console.info("");
  console.info(`  raw records           ${evidence.rawRecordCount}`);
  console.info(`  unique source ids     ${outcome.observations.length}`);
  console.info(`  duplicate ids         ${outcome.duplicateSourcePropertyIds.length}`);
  console.info(`  missing source ids    ${outcome.recordsMissingSourcePropertyId}`);
  console.info(`  provider total        ${evidence.providerReportedTotal ?? "(none supplied)"}`);
  console.info(
    `  enumeration           walk_completed=${evidence.paginationWalkCompleted} ` +
      `exhaustion_proven=${evidence.providerEnumerationExhaustionProven} ` +
      `enumeration_risks=${evidence.enumerationRisks.length}`,
  );
  console.info(
    `  coverage risks        ${evidence.coverageRisks.length} (recorded, never emptied)`,
  );
  for (const risk of evidence.coverageRisks) console.info(`     - ${risk.slice(0, 110)}`);
  console.info("");
  console.info(
    `  coordinates           present=${withCoords} plausible=${plausible} implausible=${implausible} missing=${missingCoords}`,
  );
  console.info(
    `  classification join   resolved=${classificationResolved}/${obs.length} (provider evidence only)`,
  );
  console.info(
    `  media summary         with_images=${withImages} total_images=${totalImages} provider_principal=${principal}`,
  );
  console.info("");
  console.info("  canonical writes planned: 0 hotels, 0 hotel_source_identities,");
  console.info("                            0 source_match_candidates, 0 source_property_reviews");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.info(
    "\n[source:ingest] cached provider evaluation replay (offline, no provider calls)\n",
  );

  const manifest = await resolveManifest(args);
  const target = resolveIngestionTarget(process.env);

  console.info(`  mode                  ${args.apply ? "APPLY" : "DRY-RUN (no writes)"}`);
  console.info(`  database              ${target.classification.redactedTarget}`);
  console.info("");

  const client = new Client({ connectionString: target.url });
  await client.connect();
  try {
    const destinationId = await resolveDestinationId(client, manifest.destinationSlug);

    const started = Date.now();
    const outcome = await buildBatch(manifest, destinationId, REPO_ROOT);
    const mapMs = Date.now() - started;

    // PRE-WRITE GATES. Both run before preview as well as before apply: a
    // preview that reported counts the apply would refuse would be worse than
    // useless.
    assertArtifactsConsistent(manifest, outcome, outcome.rawRecordCount);
    assertGeographyConsistent(manifest, outcome);

    summarize(manifest, outcome);
    console.info(`  adapter mapping       ${mapMs} ms`);
    console.info("");

    if (!args.apply) {
      const planned = await previewIngestion(client, outcome);
      console.info("  PLANNED (no writes performed):");
      console.info(
        `    source_runs          new=${planned.runsCreated} existing=${planned.runsExisting}`,
      );
      console.info(
        `    identities           new=${planned.identitiesCreated} existing=${planned.identitiesExisting}`,
      );
      console.info(
        `    observations         new=${planned.observationsCreated} existing=${planned.observationsExisting}`,
      );
      console.info("\n  Re-run with --apply to write.\n");
      return;
    }

    const applyStarted = Date.now();
    const counts = await applyIngestion(client, outcome, { chunkSize: args.chunkSize });
    const applyMs = Date.now() - applyStarted;

    console.info("  APPLIED:");
    console.info(
      `    source_runs          new=${counts.runsCreated} existing=${counts.runsExisting}`,
    );
    console.info(
      `    identities           new=${counts.identitiesCreated} existing=${counts.identitiesExisting}`,
    );
    console.info(
      `    observations         new=${counts.observationsCreated} existing=${counts.observationsExisting}`,
    );
    console.info(`    observation_count++  ${counts.observationCountIncrements}`);
    console.info(`    last_seen advanced   ${counts.lastSeenAdvanced}`);
    console.info(`    duration             ${applyMs} ms (chunk size ${args.chunkSize})`);
    console.info("");
  } finally {
    await client.end();
  }
}

// Only run when invoked directly, so tests can import the helpers above.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((err: unknown) => {
    if (
      err instanceof MissingArtifactError ||
      err instanceof ArtifactDigestMismatchError ||
      err instanceof ManifestIntegrityError ||
      err instanceof ArtifactConsistencyError ||
      err instanceof GeographyContradictionError ||
      err instanceof UnsafeIngestionTargetError
    ) {
      console.error(`\n[source:ingest] STOP\n\n${err.message}\n`);
      process.exit(2);
    }
    console.error(`\n[source:ingest] failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
