/**
 * import:inspect — parse a source file and print its structure. No DB, no
 * normalization, no promotion. Safe first look at any file.
 *
 *   npm run import:inspect -- --file <path>
 */
import { inspectSource } from "../../src/lib/import/parse";
import { fail, parseArgs, requireString } from "./_shared";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = requireString(args, "file");

  const inspection = await inspectSource(file);
  console.info(`\nFile: ${inspection.fileName} (${inspection.ext})`);
  for (const sheet of inspection.sheets) {
    console.info(`\n  Sheet: ${sheet.name}  [kind: ${sheet.kind}]  rows: ${sheet.rowCount}`);
    console.info(`  Columns: ${sheet.columns.join(", ") || "(none)"}`);
  }
  console.info("");
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
