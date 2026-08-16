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
import { existsSync, readFileSync } from "node:fs";
import { sep } from "node:path";

import { checkCredentials, requireCredential } from "./credentials";
import {
  analyseDestination,
  GeographyMappingContradictionError,
} from "./hotelbeds/destination-report";
import { comparePilotAgainstProvider, type PilotEntryLike } from "./hotelbeds/pilot-comparison";
import { RequestBudget } from "./hotelbeds/budget";
import { HotelbedsClient } from "./hotelbeds/client";
import { EvaluationLock, QuotaLedger } from "./hotelbeds/quota-ledger";
import { accountFingerprint } from "./hotelbeds/signature";
import {
  createHotelbedsTransport,
  fetchAccommodationTypeMaster,
  fetchDestinations,
  fetchHotelbedsCategoryMaster,
  probeCredentials,
} from "./hotelbeds/transport";
import type { ReferenceData, RuntimeObservation } from "./types";
import { ADAPTERS, getAdapter } from "./adapters/registry";
import { assessAllCapabilities, assertRunnableForAnyCapability } from "./capabilities";
import { artifactPath, writeArtifact } from "./artifacts";
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
): { client: HotelbedsClient; ledger: QuotaLedger; lock: EvaluationLock } {
  // Read at call time; never stored on the descriptor, never logged.
  const apiKey = requireCredential("HOTELBEDS_API_KEY");
  const secret = requireCredential("HOTELBEDS_SECRET");
  // Scoped to a non-secret fingerprint so a different account gets its own
  // allowance instead of inheriting this one's spend.
  const fingerprint = accountFingerprint(apiKey);
  const ledger = new QuotaLedger(fingerprint);
  // One live Hotelbeds evaluation at a time: two processes both reading 49/50
  // would both issue request 50.
  const lock = new EvaluationLock(fingerprint);
  const { reclaimedStaleLock } = lock.acquire();
  if (reclaimedStaleLock) {
    log("Reclaimed a stale Hotelbeds evaluation lock (older than the staleness threshold).");
  }
  return {
    lock,
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
 * One prepared provider run: transport, the reference data it needs to make
 * sense of the codes it will receive, and the lock that must be released.
 */
interface ProviderSession {
  transport: ProviderTransport;
  reference: ReferenceData;
  runtime: RuntimeObservation;
  /** Notes worth printing about how the session was prepared. */
  notes: string[];
  release: () => void;
}

/**
 * Build the provider transport AND the reference data it depends on.
 *
 * Credential presence is enforced before any request, so a missing credential
 * fails loudly rather than producing a 401 whose empty body looks like "this
 * destination has no hotels".
 *
 * The master fetch is not optional plumbing. Hotelbeds' hotels operation returns
 * category CODES; without the master every one of them normalizes to
 * `unresolved_no_master_entry`, and the run would report that a provider
 * supplying perfectly good classification evidence supplied none. It shares this
 * run's budget, ledger and lock, and the on-disk cache makes it free after the
 * first fetch.
 */
async function createProviderSession(
  descriptor: AdapterDescriptor,
  args: Map<string, string | true>,
  log: (message: string) => void,
): Promise<ProviderSession> {
  for (const name of descriptor.requiredCredentialEnvVars) requireCredential(name);

  if (descriptor.provider !== "hotelbeds") {
    throw new Error(
      `Provider "${descriptor.provider}" has no transport implementation.\n` +
        "Booking and Expedia are preserved as future strategic sources with direct access\n" +
        "unavailable; implementing their transports is deliberately out of scope for now.",
    );
  }

  const budget = createBudget(args);
  const { client, lock } = createHotelbedsClient(descriptor, budget, log, !args.has("no-cache"));
  const notes: string[] = [];

  try {
    const master = await fetchHotelbedsCategoryMaster(client);
    notes.push(
      `category master: ${master.uniqueCodes} unique codes from ${master.rawCount} records, exhaustion proven: ${master.evidence.exhaustionProven}`,
    );
    if (master.duplicateCodes.length > 0) {
      notes.push(`category master DUPLICATE codes: ${master.duplicateCodes.join(", ")}`);
    }
    if (!master.evidence.exhaustionProven) {
      // An incomplete master turns real classifications into "unresolved", which
      // reads as a provider weakness. Say so instead of letting it look like one.
      notes.push(
        "COVERAGE RISK: the category master was NOT proven exhaustive, so some " +
          "`unresolved_no_master_entry` results may be OUR gap, not the provider's.",
      );
    }

    // The master fetch is the evidence — but only if it actually went out. A run
    // served entirely from cache proves nothing about the network or the
    // credential TODAY, so it stays `unknown` rather than claiming reachability
    // from a stored response.
    const reachedProvider = budget.state.providerReached > 0;
    const runtime: RuntimeObservation = reachedProvider
      ? {
          egress: "reachable",
          credentials: "valid",
          detail: "Observed while fetching the category master for this run.",
        }
      : {
          egress: "unknown",
          credentials: "untested",
          detail: "Category master served from cache; no request left this process.",
        };

    return {
      transport: createHotelbedsTransport(client),
      reference: { classifications: master.classifications },
      runtime,
      notes,
      release: () => lock.release(),
    };
  } catch (error) {
    // Nothing downstream can run, so do not hold the single-run lock while the
    // caller unwinds.
    lock.release();
    throw error;
  }
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

  const session = await createProviderSession(descriptor, args, (m) => log(m));
  for (const note of session.notes) log(`  ${note}`);

  // Caller-supplied label keeps runs reproducible; the harness reads no clock.
  const runLabel = String(process.env.EVAL_RUN_LABEL ?? "run");

  let result;
  try {
    result = await executeEvaluation({
      descriptor,
      destination,
      transport: session.transport,
      runLabel,
      retainRawPayloads: true,
      reference: session.reference,
      runtime: session.runtime,
    });
  } finally {
    session.release();
  }

  log(`${descriptor.displayName} × ${destination} — evaluation complete.`);
  log(`  raw records returned:      ${result.metrics.accounting.rawRecordsReturned}`);
  log(`  normalized records:        ${result.metrics.accounting.normalizedRecords}`);
  log(`  missing provider id:       ${result.metrics.accounting.recordsMissingSourcePropertyId}`);
  log(`  unique provider ids:       ${result.metrics.accounting.uniqueSourcePropertyIds}`);
  log(`  exhaustion proven:         ${result.metrics.pagination.exhaustionProven}`);
  for (const risk of result.metrics.pagination.coverageRisks) log(`  COVERAGE RISK: ${risk}`);
  for (const path of result.artifacts) log(`  artifact (gitignored): ${path}`);
  log(`  ${result.coverageDisclaimer}`);

  // D060 counts are deliberately NOT printed here. Hotelbeds category data is
  // provider classification evidence, not canonical star provenance, so the
  // per-destination analysis below reports PROVIDER-APPARENT distributions and
  // nothing that could be read as an exact-four/exact-five inventory count.
  const rawArtifact = result.artifacts.find((p) => p.includes(`${sep}raw${sep}`));
  if (!rawArtifact) {
    log("  No raw artifact retained; skipping the per-destination source analysis.");
    return;
  }

  const rawPayloads = JSON.parse(readFileSync(rawArtifact, "utf8")) as unknown[];
  const geography = descriptor.geography.find((g) => g.destination === destination);
  const analysis = analyseDestination(
    destination,
    geography?.providerEntityIds ?? [],
    rawPayloads,
    descriptor,
    session.reference.classifications,
    {
      requests: result.metrics.pagination.requests,
      pages: result.metrics.pagination.pages,
      providerReportedTotal: result.metrics.pagination.reportedTotal,
      exhaustionProven: result.metrics.pagination.exhaustionProven,
    },
  );

  const written = writeArtifact(`hotelbeds-destination-${destination}.json`, analysis);
  log(`  source analysis (gitignored): ${written}`);

  const inv = analysis.inventory;
  const cls = analysis.providerClassification;
  const loc = analysis.location;
  const med = analysis.media;
  log(
    `  inventory: ${inv.rawRecords} raw / ${inv.uniqueProviderIds} unique ids / ${inv.duplicateProviderIds} duplicate / provider total ${inv.providerReportedTotal ?? "?"}`,
  );
  log(
    `  geography: ${Object.keys(analysis.geography.destinationCodesReturned).join(",")} · ${analysis.geography.uniqueZoneCodes} zones · ${analysis.geography.contradictions} contradictions`,
  );
  log(
    `  PROVIDER classification (NOT D060): master join ${cls.masterJoinResolvedPct}% · STAR ${cls.starLabelled} · KEY ${cls.keyLabelled} · other ${cls.otherLabelled} · unjoined ${cls.unjoined}`,
  );
  log(
    `  location: coords valid ${loc.coordinatesValid}/${inv.rawRecords} · address ${loc.addressPresent} · postal ${loc.postalCodePresent}`,
  );
  log(
    `  media: ≥1 image ${med.propertiesWithAnyImage} · principal selectable ${med.propertiesWithDeterministicPrincipal} · documented visualOrder=0 ${med.propertiesWithDocumentedVisualOrderZero} · avg ${med.averageImages} · median ${med.medianImages}`,
  );

  for (const finding of analysis.fieldFindings) {
    if (finding.verdict === "field_map_mismatch") {
      log(`  FIELD_MAP_MISMATCH: ${finding.field} -> ${finding.path} (key absent from payload)`);
    } else if (finding.verdict === "field_not_populated") {
      log(`  FIELD_NOT_POPULATED: ${finding.field} -> ${finding.path} (key present, never filled)`);
    }
  }

  // The approved mapping is a claim about what these records MEAN. If the
  // provider returns records outside it, the counts above describe a different
  // population than the report says they do — so stop rather than reconcile.
  if (analysis.geography.contradictions > 0) {
    throw new GeographyMappingContradictionError(
      destination,
      geography?.providerEntityIds ?? [],
      analysis.geography.destinationCodesReturned,
    );
  }
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

  if (args.has("category-master")) {
    await runCategoryMaster(args, log);
    return;
  }

  if (args.has("accommodation-types")) {
    await runAccommodationTypes(args, log);
    return;
  }

  if (args.has("pilot-compare")) {
    runPilotComparison(log);
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
 * Fetch the accommodation-types master.
 *
 * `accommodationTypeCode` is populated on every hotel record but was EMPTY in
 * the category master, so this is the only place its meaning can come from.
 */
async function runAccommodationTypes(
  args: Map<string, string | true>,
  log: (...parts: unknown[]) => void,
): Promise<void> {
  const descriptor = getAdapter("hotelbeds");
  for (const name of descriptor.requiredCredentialEnvVars) requireCredential(name);

  const budget = createBudget(args);
  const { client, ledger, lock } = createHotelbedsClient(
    descriptor,
    budget,
    (m) => log(m),
    !args.has("no-cache"),
  );

  let master;
  try {
    master = await fetchAccommodationTypeMaster(client);
  } finally {
    lock.release();
  }

  log("Hotelbeds accommodation-types master");
  log(`  records:           ${master.rawCount}`);
  log(`  exhaustion proven: ${master.evidence.exhaustionProven}`);
  for (const [code, description] of master.types) log(`    ${code} = ${description}`);
  const q = ledger.summary();
  log(
    `  daily quota: ${q.confirmedInWindow} confirmed + ${q.possiblyConsumedInWindow} ambiguous, ${q.remainingInWindow}/${q.quota} safe remaining`,
  );

  const written = writeArtifact("hotelbeds-accommodation-types.json", {
    rawCount: master.rawCount,
    exhaustionProven: master.evidence.exhaustionProven,
    types: [...master.types].map(([code, description]) => ({ code, description })),
  });
  log(`  artifact (gitignored): ${written}`);
}

/**
 * Compare the gitignored Dubai 30-property pilot against the live DXB extract.
 *
 * Costs ZERO provider requests: both sides already exist as local artifacts.
 * Resolves nothing — see `pilot-comparison.ts` for why no threshold is invented.
 */
function runPilotComparison(log: (...parts: unknown[]) => void): void {
  const pilotPath = artifactPath("dubai-pilot-probe-input.json");
  const extractPath = artifactPath(`normalized${sep}hotelbeds-dubai-run.json`);

  if (!existsSync(pilotPath) || !existsSync(extractPath)) {
    log("DUBAI PILOT COMPARISON = BLOCKED — an input artifact is missing.");
    log(`  pilot input:   ${existsSync(pilotPath) ? "present" : `MISSING (${pilotPath})`}`);
    log(`  DXB extract:   ${existsSync(extractPath) ? "present" : `MISSING (${extractPath})`}`);
    log("Run `npm run eval:sources:pilot-probe` and the Dubai extraction first.");
    return;
  }

  const pilot = JSON.parse(readFileSync(pilotPath, "utf8")) as {
    entries: PilotEntryLike[];
  };
  const extract = JSON.parse(readFileSync(extractPath, "utf8")) as {
    sourcePropertyId: string;
    name: string | null;
    address: string | null;
    websiteUrl: string | null;
    phone: string | null;
    chain: string | null;
    latitude: number | null;
    longitude: number | null;
  }[];

  const comparison = comparePilotAgainstProvider(
    pilot.entries,
    extract.map((r) => ({ ...r, id: r.sourcePropertyId })),
  );

  log("Dubai pilot (30) × live Hotelbeds DXB population");
  log(`  pilot entries:            ${comparison.pilotEntries}`);
  log(`  provider records:         ${comparison.providerRecords}`);
  log(`  pilot with coordinates:   ${comparison.pilotEntriesWithCoordinates}`);
  for (const [outcome, n] of Object.entries(comparison.outcomes)) log(`  ${outcome}: ${n}`);
  log(`  COORDINATE ENRICHMENT AVAILABLE: ${comparison.coordinateEnrichmentAvailable}`);
  for (const d of comparison.disclaimers) log(`  NOTE: ${d}`);

  const written = writeArtifact("dubai-pilot-hotelbeds-comparison.json", comparison);
  log(`  artifact (gitignored): ${written}`);
}

/**
 * Fetch and cache the Hotelbeds categories master.
 *
 * Without this, every hotel category code normalizes to
 * `unresolved_no_master_entry` and a provider supplying perfectly good
 * classification evidence looks like it supplied none.
 */
async function runCategoryMaster(
  args: Map<string, string | true>,
  log: (...parts: unknown[]) => void,
): Promise<void> {
  const descriptor = getAdapter("hotelbeds");
  for (const name of descriptor.requiredCredentialEnvVars) requireCredential(name);

  const budget = createBudget(args);
  const { client, ledger, lock } = createHotelbedsClient(
    descriptor,
    budget,
    (m) => log(m),
    !args.has("no-cache"),
  );

  let master;
  try {
    master = await fetchHotelbedsCategoryMaster(client);
  } finally {
    lock.release();
  }

  log("Hotelbeds categories master");
  log(`  raw records:    ${master.rawCount}`);
  log(`  unique codes:   ${master.uniqueCodes}`);
  log(`  duplicate codes:${master.duplicateCodes.length}`);
  log(`  exhaustion proven: ${master.evidence.exhaustionProven}`);
  for (const risk of master.evidence.coverageRisks) log(`  COVERAGE RISK: ${risk}`);

  const q = ledger.summary();
  log(
    `  daily quota: ${q.confirmedInWindow} confirmed + ${q.possiblyConsumedInWindow} ambiguous, ${q.remainingInWindow}/${q.quota} safe remaining`,
  );

  const written = writeArtifact("hotelbeds-category-master.json", {
    rawCount: master.rawCount,
    uniqueCodes: master.uniqueCodes,
    duplicateCodes: master.duplicateCodes,
    exhaustionProven: master.evidence.exhaustionProven,
    coverageRisks: master.evidence.coverageRisks,
    classifications: [...master.classifications.values()],
  });
  log(`  artifact (gitignored): ${written}`);
  log("");
  log("NOTE: a successful join does NOT make these D060 truth. Observation and");
  log("interpretation stay separate; the issuing authority is still unestablished.");
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
  const { client, ledger, lock } = createHotelbedsClient(
    descriptor,
    budget,
    (m) => log(m),
    !args.has("no-cache"),
  );

  let discovery;
  try {
    discovery = await fetchDestinations(client, country);
  } finally {
    lock.release();
  }
  const { destinations, total, evidence, interrupted } = discovery;

  log(`Hotelbeds geography discovery — country ${country}`);
  log(`  destinations returned: ${destinations.length}${total === null ? "" : ` of ${total}`}`);
  log(`  requests/pages: ${evidence.requests}/${evidence.pages}`);
  log(`  exhaustion proven: ${evidence.exhaustionProven}`);
  if (interrupted) {
    log("  GEOGRAPHY DISCOVERY INCOMPLETE — enumeration did not demonstrate exhaustion.");
  }
  for (const risk of evidence.coverageRisks) log(`  COVERAGE RISK: ${risk}`);
  const q = ledger.summary();
  log(
    `  daily quota: ${q.confirmedInWindow} confirmed + ${q.possiblyConsumedInWindow} ambiguous, ${q.remainingInWindow}/${q.quota} safe remaining`,
  );

  const written = writeArtifact(`hotelbeds-geography-${country}.json`, {
    country,
    total,
    returned: destinations.length,
    exhaustionProven: evidence.exhaustionProven,
    incomplete: interrupted,
    coverageRisks: evidence.coverageRisks,
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
  const { client, ledger, lock } = createHotelbedsClient(descriptor, budget, (m) => log(m), false);

  let result;
  try {
    result = await probeCredentials(client);
  } finally {
    lock.release();
  }

  log("Hotelbeds credential probe");
  log(`  CREDENTIALS:        ${result.credentials.toUpperCase()}`);
  log(`  EGRESS:             ${result.reachable ? "reachable" : "BLOCKED"}`);
  log(`  detail:             ${result.detail}`);
  log(`  local attempts:     ${budget.state.attempted} (cache hits ${budget.state.cacheHits})`);
  log(`  reached provider:   ${budget.state.providerReached}  <- what consumes the 50/day quota`);
  log(`  local budget left:  ${budget.remaining}`);
  const quota = ledger.summary();
  log(`  DAILY quota (conservative 24h rolling window):`);
  log(`    confirmed reached provider:   ${quota.confirmedInWindow}`);
  log(`    possibly consumed (ambiguous): ${quota.possiblyConsumedInWindow}`);
  log(`    safe remaining:                ${quota.remainingInWindow} of ${quota.quota}`);

  // Re-assess against what was just OBSERVED. The descriptor did not change; if
  // the verdicts below differ from `--status`, that difference is the runtime.
  const runtime: RuntimeObservation = {
    egress: result.reachable ? "reachable" : "blocked",
    credentials:
      result.credentials === "valid"
        ? "valid"
        : result.credentials === "invalid"
          ? "invalid"
          : "untested",
    detail: result.detail,
  };
  const observed = assessAllCapabilities(descriptor, undefined, runtime);
  log("  capabilities under the OBSERVED runtime:");
  for (const c of observed) {
    log(`    ${c.capability}: ${c.runnable ? "runnable" : "BLOCKED"}`);
    for (const reason of c.reasons) log(`        - ${reason}`);
  }

  writeArtifact("hotelbeds-probe.json", {
    credentials: result.credentials,
    reachable: result.reachable,
    status: result.status,
    detail: result.detail,
    budget: budget.state,
    dailyQuota: ledger.summary(),
    accountFingerprint: client.accountFingerprint,
    runtime,
    capabilities: observed,
  });
}

void main().catch((error: unknown) => {
  const log = createSafeLogger(collectSecretValues());
  log(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
