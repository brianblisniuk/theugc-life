/**
 * import:review-template — generate a gitignored reviewer manifest for a batch.
 *   npm run import:review-template -- --batch <uuid>
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { REPORTS_DIR } from "../../src/lib/import/pipeline";
import { buildReviewTemplate } from "../../src/lib/import/review";
import { fail, getClient, parseArgs, requireString } from "./_shared";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const batchId = requireString(args, "batch");

  const client = await getClient();
  try {
    const manifest = await buildReviewTemplate(client, batchId);
    await mkdir(REPORTS_DIR, { recursive: true });
    const out = path.join(REPORTS_DIR, `${batchId}.review-template.json`);
    await writeFile(out, JSON.stringify(manifest, null, 2), "utf8");
    console.info(`\n[import:review-template] batch ${batchId}`);
    console.info(`  property bundles: ${manifest.bundles.length}`);
    console.info(`  manifest: ${out}`);
    console.info(`\n  Edit decisions, then run import:review-apply.\n`);
  } finally {
    await client.end();
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
