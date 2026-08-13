/**
 * import:review-apply — validate a reviewer manifest and write ONLY review
 * state (import_property_reviews / import_row_reviews). No canonical mutation.
 *
 *   npm run import:review-apply -- --batch <uuid> --file <review.json> --reviewer "Brian"
 */
import { readFile } from "node:fs/promises";

import { applyReview } from "../../src/lib/import/review";
import { fail, getClient, parseArgs, requireString } from "./_shared";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const batchId = requireString(args, "batch");
  const file = requireString(args, "file");
  const reviewer = requireString(args, "reviewer");

  const manifest = JSON.parse(await readFile(file, "utf8"));
  const client = await getClient();
  try {
    const result = await applyReview(client, batchId, manifest, reviewer);
    console.info(`\n[import:review-apply] batch ${batchId}`);
    console.info(
      `  bundles=${result.bundlesWritten} child-overrides=${result.childOverridesWritten}`,
    );
    console.info(`  batch status → ${result.batchStatus} (review complete: ${result.complete})`);
    console.info(`\n  No canonical data was promoted (review state only).\n`);
  } finally {
    await client.end();
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
