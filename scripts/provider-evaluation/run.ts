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
import { RequestBudget } from "./hotelbeds/budget";
import { HotelbedsClient } from "./hotelbeds/client";
import { createHotelbedsTransport, probeCredentials } from "./hotelbeds/transport";
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
 * Evaluation request budget.
 *
 * The Hotelbeds evaluation account allows 50 requests per DAY. The default
 * ceiling here is 40, leaving at least 10 in reserve for diagnostics and
 * recovery — spending the last request on a paginated page leaves no way to
 * investigate what went wrong until the quota resets.
 */
const DEFAULT_MAX_REQUESTS = 40;
/** ~1.5 req/s, comfortably inside the dashboard's 8-per-4-seconds allowance. */
const DEFAULT_MIN_INTERVAL_MS = 700;

function createBudget(args: Map<string, string | true>): RequestBudget {
  const raw = args.get("max-requests");
  const maxRequests = typeof raw === "string" ? Number(raw) : DEFAULT_MAX_REQUESTS;
  if (!Number.isFinite(maxRequests) || maxRequests <= 0) {
    throw new Error("--max-requests must be a positive number");
  }
  return new RequestBudget({
    maxRequests,
    minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
  });
}

function createHotelbedsClient(
  descriptor: AdapterDescriptor,
  budget: RequestBudget,
  log: (message: string) => void,
  useCache: boolean,
): HotelbedsClient {
  // Read at call time; never stored on the descriptor, never logged.
  const apiKey = requireCredential("HOTELBEDS_API_KEY");
  const secret = requireCredential("HOTELBEDS_SECRET");
  return new HotelbedsClient({
    baseUrl: descriptor.baseUrl ?? "",
    credentials: { apiKey, secret },
    budget,
    useCache,
    log,
  });
}

/**
 * Build the provider transport.
 *
 * Credential presence is enforced before any request, so a missing credential
 * fails loudly rather than producing a 401 whose empty body looks like "this
 * destination has no hotels".
 */
function createTransport(
  descriptor: AdapterDescriptor,
  args: Map<string, string | true>,
  log: (message: string) => void,
): ProviderTransport {
  for (const name of descriptor.requiredCredentialEnvVars) requireCredential(name);

  if (descriptor.provider === "hotelbeds") {
    const budget = createBudget(args);
    return createHotelbedsTransport(
      createHotelbedsClient(descriptor, budget, log, !args.has("no-cache")),
    );
  }

  throw new Error(
    `Provider "${descriptor.provider}" has no transport implementation.\n` +
      "Booking and Expedia are preserved as future strategic sources with direct access\n" +
      "unavailable; implementing their transports is deliberately out of scope for now.",
  );
}

async function runProvider(
  providerArg: string,
  destinationArg: string,
  args: Map<string, string | true>,
  log: (...parts: unknown[]) => void,
): Promise<void> {
  if (!DESTINATIONS.includes(destinationArg as EvaluationDestination)) {
    throw new Error(`--destination must be one of: ${DESTINATIONS.join(", ")}`);
  }
  const destination = destinationArg as EvaluationDestination;
  const descriptor = getAdapter(providerArg);

  // Throws with the full list of reasons when facts are still missing.
  assertRunnable(descriptor, destination);

  const transport = createTransport(descriptor, args, (m) => log(m));

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

  // Probe first: `--probe` takes no --provider, so the status fallback below
  // would otherwise swallow it.
  if (args.has("probe")) {
    await runProbe(args, log);
    return;
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

  await runProvider(String(args.get("provider")), String(args.get("destination") ?? ""), args, log);
}

/**
 * Minimal authenticated diagnostic against Hotelbeds.
 *
 * Answers only two questions — credentials valid, API reachable — for the
 * smallest possible quota cost. Never touches availability or booking.
 */
async function runProbe(
  args: Map<string, string | true>,
  log: (...parts: unknown[]) => void,
): Promise<void> {
  const descriptor = getAdapter("hotelbeds");
  for (const name of descriptor.requiredCredentialEnvVars) requireCredential(name);

  const budget = createBudget(args);
  const client = createHotelbedsClient(descriptor, budget, (m) => log(m), !args.has("no-cache"));

  const result = await probeCredentials(client);

  log("Hotelbeds credential probe");
  log(`  CREDENTIALS:        ${result.credentials.toUpperCase()}`);
  log(`  EGRESS:             ${result.reachable ? "reachable" : "BLOCKED"}`);
  log(`  detail:             ${result.detail}`);
  log(`  local attempts:     ${budget.state.attempted} (cache hits ${budget.state.cacheHits})`);
  log(`  reached provider:   ${budget.state.providerReached}  <- what consumes the 50/day quota`);
  log(`  local budget left:  ${budget.remaining}`);

  writeArtifact("hotelbeds-probe.json", {
    credentials: result.credentials,
    reachable: result.reachable,
    status: result.status,
    detail: result.detail,
    budget: budget.state,
  });
}

void main().catch((error: unknown) => {
  const log = createSafeLogger(collectSecretValues());
  log(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
