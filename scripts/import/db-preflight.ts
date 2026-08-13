/**
 * import:db-preflight — read-only persistent-target preflight
 * (SPRINT_1C_PERSISTENT_PREFLIGHT.md + review fixes). Classifies DATABASE_URL
 * WITHOUT exposing any secret, proves the reviewed Sprint 0–1C migration state
 * (Supabase migration ledger through 0017 + structural objects), reports
 * aggregate baseline counts (no PII), and checks UAE/Dubai destination
 * readiness.
 *
 * It reads ONLY `DATABASE_URL` — it never falls back to `TEST_DATABASE_URL`.
 * Performs NO writes. All failures are reported as categorical codes: no
 * hostname, IP, port, URL, username, password, token, or driver message is ever
 * printed (review fix PF1).
 *
 *   DATABASE_URL=... npm run import:db-preflight
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import {
  assertPersistentApplyTarget,
  classifyDatabaseUrl,
  formatPreflightFailure,
  PersistentTargetError,
  readRepoMigrationVersions,
  runPreflight,
} from "../../src/lib/import/preflight";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(SCRIPT_DIR, "..", "..", "supabase", "migrations");

async function main() {
  const raw = process.env.DATABASE_URL?.trim();
  const classification = classifyDatabaseUrl(raw);

  console.info("\n[import:db-preflight] persistent-target preflight (read-only)\n");
  console.info(`  DATABASE_URL: ${classification.present ? "present" : "absent"}`);

  if (!classification.present) {
    console.info(`  target: ${classification.redactedTarget}`);
    console.info("\n  decision: PERSISTENT_DATABASE_NOT_CONFIGURED");
    console.info(
      "  missing: an explicit remote DATABASE_URL (this workflow will NOT use TEST_DATABASE_URL).\n",
    );
    process.exitCode = 2;
    return;
  }

  console.info(
    `  classification: ${classification.isRemote ? "remote" : "local/non-persistent"} ` +
      `(${classification.redactedTarget})`,
  );

  // Enforce the same guard the real apply uses (explicit + remote-only). Its
  // message contains only redactedTarget (class/db/ssl) — never a secret.
  try {
    assertPersistentApplyTarget(process.env);
  } catch (err) {
    if (err instanceof PersistentTargetError) {
      console.info(`\n  decision: BLOCKED_NON_PERSISTENT_TARGET`);
      console.info(`  reason: ${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  const expectedVersions = await readRepoMigrationVersions(MIGRATIONS_DIR);
  const head = expectedVersions[expectedVersions.length - 1] ?? "(none)";

  const client = new Client({ connectionString: raw });
  await client.connect();
  try {
    const result = await runPreflight(client, expectedVersions);

    // Migration ledger (versioned proof) — identifiers/counts only, no details.
    const m = result.migration;
    console.info(`\n  migration ledger: ${m.ledgerPresent ? "present" : "absent"}`);
    console.info(
      `    expected repo versions: ${expectedVersions.length} (head ${head})` +
        `  ledger versions: ${m.ledgerVersions.length}`,
    );
    console.info(`    status: ${m.status}`);
    if (m.missing.length > 0) console.info(`    missing required: ${m.missing.join(", ")}`);
    if (m.ahead.length > 0) console.info(`    ahead/unknown: ${m.ahead.join(", ")}`);

    // Structural objects (second line of defense).
    console.info(`\n  structural schema: ${result.schemaReady ? "ready" : "NOT-ready"}`);
    if (!result.schemaReady) {
      console.info(`  missing objects: ${result.missing.join(", ")}`);
    }

    if (result.schemaReady) {
      console.info("\n  baseline aggregate counts (no PII):");
      for (const [table, n] of Object.entries(result.baselineCounts)) {
        console.info(`    ${table} = ${n}`);
      }
    }

    console.info("\n  destination readiness:");
    console.info(`    united-arab-emirates ok: ${result.destinations.uaeOk}`);
    console.info(`    dubai ok: ${result.destinations.dubaiOk}`);
    console.info(`    detail: ${result.destinations.detail}`);

    // Decision: structural + versioned migration proof + destinations all pass.
    let decision: string;
    if (!result.schemaReady) {
      decision = "BLOCKED_SCHEMA_NOT_READY";
    } else if (m.status === "ahead-unknown") {
      decision = "BLOCKED_MIGRATION_STATE_AHEAD";
    } else if (!m.verified) {
      // ledger-absent / ledger-shape-unknown / missing-required (incl. 0017).
      decision = "BLOCKED_MIGRATION_STATE_UNVERIFIED";
    } else if (!result.destinations.uaeOk || !result.destinations.dubaiOk) {
      decision = "BLOCKED_DESTINATIONS_NOT_READY";
    } else {
      decision = "READY_FOR_REMOTE_RESTAGE";
    }

    console.info(`\n  decision: ${decision}\n`);
    if (decision !== "READY_FOR_REMOTE_RESTAGE") process.exitCode = 2;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // PF1: never surface secrets or driver detail — emit only a categorical code.
  console.error(`\n[import:db-preflight] decision: ${formatPreflightFailure(err)}\n`);
  process.exit(1);
});
