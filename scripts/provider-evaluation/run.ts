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
import { QuotaLedger } from "./hotelbeds/quota-ledger";
import { accountFingerprint } from "./hotelbeds/signature";
import {
  createHotelbedsTransport,
  fetchDestinations,
  probeCredentials,
} from "./hotelbeds/transport";
import { ADAPTERS, getAdapter } from "./adapters/registry";
import { assessAllCapabilities, assertRunnableForAnyCapability } from "./capabilities";
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
): { client: HotelbedsClient; ledger: QuotaLedger } {
  // Read at call time; never stored on the descriptor, never logged.
  const apiKey = requireCredential("HOTELBEDS_API_KEY");
  const secret = requireCredential("HOTELBEDS_SECRET");
  // Scoped to a non-secret fingerprint so a different account gets its own
  // allowance instead of inheriting this one's spend.
  const ledger = new QuotaLedger(accountFingerprint(apiKey));
  return {
    client: new HotelbedsClient({
      baseUrl: descriptor.baseUrl ?? "",
      credentials: { apiKey, secret },
      budget,
      ledger,
      useCache,
      log,
    }),
    ledger,
  };
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
    const { client } = createHotelbedsClient(descriptor, budget, log, !args.has("no-cache"));
    return createHotelbedsTransport(client);
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

  // Capability-scoped: proceeds when ANY dimension is measurable. An unresolved
  // classification issuer no longer vetoes measuring inventory or coordinates.
  const capabilities = assertRunnableForAnyCapability(descriptor, destination);
  for (const c of capabilities) {
    log(`  capability ${c.capability}: ${c.runnable ? "runnable" : "BLOCKED"}`);
    for (const reason of c.reasons) log(`      - ${reason}`);
  }

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

  if (args.has("discover-geography")) {
    await runGeographyDiscovery(args, log);
    return;
  }

  if (args.has("status") || !args.has("provider")) {
    const status = ADAPTERS.map((descriptor) => {
      const credentials = checkCredentials(
        descriptor.provider,
        descriptor.requiredCredentialEnvVars,
      );
      const capabilities = assessAllCapabilities(descriptor);
      return {
        provider: descriptor.provider,
        displayName: descriptor.displayName,
        documentationStatus: descriptor.documentationStatus,
        accessStatus: descriptor.accessStatus,
        liveValidationStatus: descriptor.liveValidationStatus,
        strategicRole: descriptor.strategicRole,
        credentials: credentials.variables,
        credentialsComplete: credentials.allPresent,
        capabilities,
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
      log(
        `  documentation: ${entry.documentationStatus} | access: ${entry.accessStatus} | live: ${entry.liveValidationStatus}`,
      );
      for (const [name, state] of Object.entries(entry.credentials)) {
        log(`  credential ${name}: ${state}`);
      }
      for (const c of entry.capabilities) {
        log(`  ${c.capability}: ${c.runnable ? "runnable" : "BLOCKED"}`);
        for (const reason of c.reasons) log(`      - ${reason}`);
      }
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
 * Geography discovery.
 *
 * Fetches provider destination master data for a country and caches it, so
 * candidate Bali/Dubai codes can be reviewed and promoted into the descriptor's
 * geography.
 *
 * Deliberately NOT gated on classification or on geography already existing —
 * requiring resolved geography before running the code that discovers geography
 * is circular, and was one reason the previous gate could never be satisfied.
 */
async function runGeographyDiscovery(
  args: Map<string, string | true>,
  log: (...parts: unknown[]) => void,
): Promise<void> {
  const country = String(args.get("country") ?? "");
  if (!country) {
    throw new Error(
      "--country is required, e.g. --discover-geography --country ID (Indonesia) or --country AE (UAE).\n" +
        "Country codes come from provider master data; destination codes are NEVER hardcoded.",
    );
  }

  const descriptor = getAdapter("hotelbeds");
  for (const name of descriptor.requiredCredentialEnvVars) requireCredential(name);

  const budget = createBudget(args);
  const { client, ledger } = createHotelbedsClient(
    descriptor,
    budget,
    (m) => log(m),
    !args.has("no-cache"),
  );

  const { destinations, total } = await fetchDestinations(client, country);

  log(`Hotelbeds geography discovery — country ${country}`);
  log(`  destinations returned: ${destinations.length}${total === null ? "" : ` of ${total}`}`);
  log(`  requests reaching provider: ${budget.state.providerReached}`);
  log(`  daily quota: ${ledger.summary().spentInWindow}/${ledger.summary().quota} spent`);

  const written = writeArtifact(`hotelbeds-geography-${country}.json`, {
    country,
    total,
    destinations,
    note:
      "CANDIDATES ONLY. A canonical destination is resolved by review, not by name matching. " +
      "Bali may require a UNION of several codes; one famous town is not Bali.",
  });
  log(`  artifact (gitignored): ${written}`);
  log("");
  log("Next: review these candidates, then record the chosen codes as the descriptor's");
  log("geography with the resolution method that produced them.");
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
  // The probe always bypasses the response cache (see probeCredentials): a
  // cached 200 from yesterday cannot prove today's credentials still work.
  const { client, ledger } = createHotelbedsClient(descriptor, budget, (m) => log(m), false);

  const result = await probeCredentials(client);

  log("Hotelbeds credential probe");
  log(`  CREDENTIALS:        ${result.credentials.toUpperCase()}`);
  log(`  EGRESS:             ${result.reachable ? "reachable" : "BLOCKED"}`);
  log(`  detail:             ${result.detail}`);
  log(`  local attempts:     ${budget.state.attempted} (cache hits ${budget.state.cacheHits})`);
  log(`  reached provider:   ${budget.state.providerReached}  <- what consumes the 50/day quota`);
  log(`  local budget left:  ${budget.remaining}`);
  const quota = ledger.summary();
  log(
    `  DAILY quota:        ${quota.spentInWindow}/${quota.quota} spent in a conservative 24h rolling window (${quota.remainingInWindow} left)`,
  );

  writeArtifact("hotelbeds-probe.json", {
    credentials: result.credentials,
    reachable: result.reachable,
    status: result.status,
    detail: result.detail,
    budget: budget.state,
    dailyQuota: ledger.summary(),
    accountFingerprint: client.accountFingerprint,
  });
}

void main().catch((error: unknown) => {
  const log = createSafeLogger(collectSecretValues());
  log(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
