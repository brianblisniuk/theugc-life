/**
 * Property-source evaluation CLI.
 *
 *   npx tsx scripts/provider-evaluation/run.ts --status
 *   npx tsx scripts/provider-evaluation/run.ts --provider booking --destination bali
 *
 * `--status` always works and reports readiness: credential presence
 * (AVAILABLE / NOT AVAILABLE only) and descriptor runnability. An actual run
 * requires a descriptor verified against official documentation; the harness
 * refuses otherwise, by design.
 *
 * This script never writes to Supabase, never touches `hotels`, and is not
 * imported by the application.
 */
import { checkCredentials } from "./credentials";
import { ADAPTERS, assertRunnable, checkRunnable, getAdapter } from "./adapters/registry";
import { writeArtifact } from "./artifacts";
import { collectSecretValues, createSafeLogger } from "./redact";
import type { EvaluationDestination } from "./types";

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

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const log = createSafeLogger(collectSecretValues());

  const status = ADAPTERS.map((descriptor) => {
    const credentials = checkCredentials(descriptor.provider, descriptor.requiredCredentialEnvVars);
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

  if (args.has("status") || !args.has("provider")) {
    log("Property-source evaluation — readiness\n");
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

  const provider = String(args.get("provider"));
  const destinationArg = String(args.get("destination") ?? "");
  if (!DESTINATIONS.includes(destinationArg as EvaluationDestination)) {
    throw new Error(`--destination must be one of: ${DESTINATIONS.join(", ")}`);
  }

  const descriptor = getAdapter(provider);
  // Throws with the full list of reasons when the descriptor is unverified.
  assertRunnable(descriptor);

  // Reaching here requires a verified descriptor. The live extraction wiring
  // (authenticated fetch → paginateAll → normalizeAll → computeMetrics →
  // writeArtifact) is assembled at that point, against the real, documented
  // request/response shapes rather than assumed ones.
  throw new Error(
    `Provider "${provider}" passed the runnability gate, but no live extraction has been wired.\n` +
      "Wire it now against the verified descriptor: authenticate, paginateAll() until\n" +
      "exhaustion, normalizeAll(), computeMetrics(), then writeArtifact() under .data/.",
  );
}

main();
