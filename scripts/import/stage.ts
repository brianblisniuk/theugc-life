/**
 * import:stage — parse + normalize + validate a file into import_batches /
 * import_rows (+ match candidates). No canonical promotion.
 *
 *   npm run import:stage -- --file <path> [--contacts <csv>] [--evidence <csv>]
 *   npm run import:stage -- --file <path> --adapter <legacy-key> [--force]
 */
import { stageFile } from "../../src/lib/import/pipeline";
import { fail, getClient, parseArgs, requireString } from "./_shared";
import { getLegacyAdapter, listLegacyAdapters } from "./legacy";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = requireString(args, "file");
  const adapterKey = typeof args.adapter === "string" ? args.adapter : undefined;
  const adapter = adapterKey ? getLegacyAdapter(adapterKey) : undefined;

  const client = await getClient();
  try {
    const result = await stageFile(client, {
      file,
      contacts: typeof args.contacts === "string" ? args.contacts : undefined,
      evidence: typeof args.evidence === "string" ? args.evidence : undefined,
      sourceName: typeof args.source === "string" ? args.source : undefined,
      adapter,
      force: args.force === true,
    });
    console.info(
      `\n[import:stage] batch ${result.batchId} ${result.reused ? "(reused existing)" : "(new)"}`,
    );
    console.info(
      `  rows: total=${result.counters.total} valid=${result.counters.valid} ` +
        `warning=${result.counters.warning} review=${result.counters.review} rejected=${result.counters.rejected}\n`,
    );
    if (adapterKey) console.info(`  adapter: ${adapterKey}\n`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  if (err instanceof Error && err.message.startsWith("Unknown legacy adapter")) {
    console.error(`\nAvailable adapters:`);
    for (const a of listLegacyAdapters()) console.error(`  ${a.key} — ${a.description}`);
  }
  fail(err instanceof Error ? err.message : String(err));
});
