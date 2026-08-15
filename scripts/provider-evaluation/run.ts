/**
 * Property-source evaluation CLI.
 *
 *   npm run eval:sources:status
 *   npx tsx scripts/provider-evaluation/run.ts --provider booking --destination bali
 *
 * `--status` always works and reports readiness: credential presence
 * (AVAILABLE / NOT AVAILABLE only) and descriptor runnability.
 *
 * A real run executes the full pipeline in `execute.ts`. It can still refuse
 * today, but only for the two legitimate reasons — the descriptor's facts are
 * not yet established, or credentials are absent. It never refuses because the
 * extraction was left unimplemented.
 *
 * This script never writes to Supabase, never touches `hotels`, and is not
 * imported by the application.
 */
import { checkCredentials, requireCredential } from "./credentials";
import { ADAPTERS, assertRunnable, checkRunnable, getAdapter } from "./adapters/registry";
import { writeArtifact } from "./artifacts";
import { loadLocalEnv } from "./env";
import { executeEvaluation, type ProviderTransport } from "./execute";
import { createSafeLogger, collectSecretValues } from "./redact";
import type { AdapterDescriptor, EvaluationDestination } from "./types";

const DESTINATIONS: readonly EvaluationDestination[] = ["bali", "dubai"];

function parseArgs(argv: readonly string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out.set(key, next);
      i += 1;
    } else {
      out.set(key, true);
    }
  }
  return out;
}

/**
 * Build the provider transport.
 *
 * Reads credentials at call time (never storing or logging them) and issues the
 * documented static-content request. Each adapter's request/auth shape is filled
 * in as part of verifying its descriptor; until then a verified descriptor
 * without a transport is a loud error rather than a silent empty result.
 */
function createTransport(descriptor: AdapterDescriptor): ProviderTransport {
  // Presence is enforced here so a missing credential fails before any request,
  // rather than producing a 401 whose empty body looks like "no hotels here".
  for (const name of descriptor.requiredCredentialEnvVars) requireCredential(name);

  const build = TRANSPORT_BUILDERS[descriptor.provider];
  if (!build) {
    throw new Error(
      `Provider "${descriptor.provider}" has a verified descriptor but no transport implementation.\n` +
        "Implement its authenticated request/page-extraction in TRANSPORT_BUILDERS, using the\n" +
        "endpoint, auth scheme and pagination recorded in the descriptor.",
    );
  }
  return build(descriptor);
}

/**
 * Provider-specific request/auth implementations.
 *
 * Deliberately empty: writing an authenticated request against an unverified
 * endpoint, auth scheme and pagination contract would be the same guessing the
 * runnability gate exists to prevent. Each entry is added together with its
 * descriptor's verification, and the shared pipeline downstream is already
 * complete and tested.
 */
const TRANSPORT_BUILDERS: Record<
  string,
  ((d: AdapterDescriptor) => ProviderTransport) | undefined
> = {};

async function runProvider(
  providerArg: string,
  destinationArg: string,
  log: (...parts: unknown[]) => void,
): Promise<void> {
  if (!DESTINATIONS.includes(destinationArg as EvaluationDestination)) {
    throw new Error(`--destination must be one of: ${DESTINATIONS.join(", ")}`);
  }
  const destination = destinationArg as EvaluationDestination;
  const descriptor = getAdapter(providerArg);

  // Throws with the full list of reasons when facts are still missing.
  assertRunnable(descriptor, destination);

  const transport = createTransport(descriptor);

  // Caller-supplied label keeps runs reproducible; the harness reads no clock.
  const runLabel = String(process.env.EVAL_RUN_LABEL ?? "run");

  const result = await executeEvaluation({
    descriptor,
    destination,
    transport,
    runLabel,
    retainRawPayloads: true,
  });

  log(`${descriptor.displayName} × ${destination} — evaluation complete.`);
  log(`  raw records returned:      ${result.metrics.accounting.rawRecordsReturned}`);
  log(`  normalized records:        ${result.metrics.accounting.normalizedRecords}`);
  log(`  missing provider id:       ${result.metrics.accounting.recordsMissingSourcePropertyId}`);
  log(`  unique provider ids:       ${result.metrics.accounting.uniqueSourcePropertyIds}`);
  log(`  exact 4-star:              ${result.metrics.inventory.apparentExactFourStar}`);
  log(`  exact 5-star:              ${result.metrics.inventory.apparentExactFiveStar}`);
  log(`  classified, not V1 scope:  ${result.metrics.inventory.classifiedNotV1Scope}`);
  log(`  star unresolved:           ${result.metrics.inventory.unresolvedStar}`);
  log(`  exhaustion proven:         ${result.metrics.pagination.exhaustionProven}`);
  for (const risk of result.metrics.pagination.coverageRisks) log(`  COVERAGE RISK: ${risk}`);
  for (const path of result.artifacts) log(`  artifact (gitignored): ${path}`);
  log(`  ${result.coverageDisclaimer}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const envResult = loadLocalEnv();
  const log = createSafeLogger(collectSecretValues());

  if (envResult.error) {
    log(`Warning: ${envResult.path} exists but could not be read (${envResult.error}).`);
  }

  if (args.has("status") || !args.has("provider")) {
    const status = ADAPTERS.map((descriptor) => {
      const credentials = checkCredentials(
        descriptor.provider,
        descriptor.requiredCredentialEnvVars,
      );
      const problem = checkRunnable(descriptor);
      return {
        provider: descriptor.provider,
        displayName: descriptor.displayName,
        documentationStatus: descriptor.documentationStatus,
        credentials: credentials.variables,
        credentialsComplete: credentials.allPresent,
        runnable: problem === null,
        blockingReasons: problem?.reasons ?? [],
      };
    });

    log("Property-source evaluation — readiness\n");
    log(
      envResult.loaded
        ? `Loaded local env file: ${envResult.path}`
        : `No ${envResult.path} found; variables must be exported into the environment.`,
    );
    log("");
    for (const entry of status) {
      log(`${entry.displayName} (${entry.provider})`);
      log(`  documentation: ${entry.documentationStatus}`);
      for (const [name, state] of Object.entries(entry.credentials)) {
        log(`  credential ${name}: ${state}`);
      }
      log(`  runnable: ${entry.runnable ? "yes" : "NO"}`);
      for (const reason of entry.blockingReasons) log(`    - ${reason}`);
      log("");
    }
    const written = writeArtifact("readiness.json", {
      generatedBy: "scripts/provider-evaluation/run.ts --status",
      destinations: DESTINATIONS,
      providers: status,
    });
    log(`Readiness artifact: ${written}`);
    return;
  }

  await runProvider(String(args.get("provider")), String(args.get("destination") ?? ""), log);
}

void main().catch((error: unknown) => {
  const log = createSafeLogger(collectSecretValues());
  log(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
