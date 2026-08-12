/**
 * import:report — regenerate JSON/Markdown reports for an already-staged batch.
 *
 *   npm run import:report -- --batch <uuid>
 */
import { reportBatch } from "../../src/lib/import/pipeline";
import { fail, getClient, parseArgs, requireString } from "./_shared";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const batchId = requireString(args, "batch");

  const client = await getClient();
  try {
    const result = await reportBatch(client, batchId);
    console.info(`\n[import:report] batch ${batchId}`);
    console.info(`  reports:\n    ${result.paths.json}\n    ${result.paths.md}\n`);
  } finally {
    await client.end();
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
