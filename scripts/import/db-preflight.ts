/**
 * import:db-preflight — read-only persistent-target preflight
 * (SPRINT_1C_PERSISTENT_PREFLIGHT.md). Classifies DATABASE_URL WITHOUT exposing
 * any secret, verifies Sprint 0–1C schema readiness, reports aggregate baseline
 * counts (no PII), and checks UAE/Dubai destination readiness.
 *
 * It reads ONLY `DATABASE_URL` — it never falls back to `TEST_DATABASE_URL`.
 * Performs NO writes.
 *
 *   DATABASE_URL=... npm run import:db-preflight
 */
import { Client } from "pg";

import {
  assertPersistentApplyTarget,
  classifyDatabaseUrl,
  PersistentTargetError,
  runPreflight,
} from "../../src/lib/import/preflight";

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

  // Enforce the same guard the real apply uses (explicit + remote-only).
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

  const client = new Client({ connectionString: raw });
  await client.connect();
  try {
    const result = await runPreflight(client);

    console.info(`\n  schema readiness: ${result.schemaReady ? "ready" : "NOT-ready"}`);
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

    const ready = result.schemaReady && result.destinations.uaeOk && result.destinations.dubaiOk;
    if (ready) {
      console.info("\n  decision: READY_FOR_REMOTE_RESTAGE\n");
    } else if (!result.schemaReady) {
      console.info("\n  decision: BLOCKED_SCHEMA_NOT_READY\n");
      process.exitCode = 2;
    } else {
      console.info("\n  decision: BLOCKED_DESTINATIONS_NOT_READY\n");
      process.exitCode = 2;
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // Never surface secrets; print only the message.
  console.error(
    `\n[import:db-preflight] ERROR: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
