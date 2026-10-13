/**
 * Hotelbeds provisional import (D106).
 *
 *   tsx scripts/import-hotelbeds/cli.ts --raw-dir <dir>
 *   tsx scripts/import-hotelbeds/cli.ts --raw-dir <dir> --apply --matches-out <file>
 *
 * Dry run is the default. `--apply` writes a local database only.
 * The raw directory is JSON pages already saved from the Content API.
 * This process does not call Hotelbeds and does not read API credentials.
 */
import path from "node:path";

import { fail, getClient, parseArgs, requireString } from "../import/_shared";

import { assertHotelbedsApplyIsLocal, runHotelbedsImport } from "./run";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rawDir = path.resolve(requireString(args, "raw-dir"));
  const apply = args.apply === true;
  const matchesOut =
    typeof args["matches-out"] === "string"
      ? path.resolve(args["matches-out"])
      : path.join(rawDir, "hotelbeds-review-matches.csv");

  if (apply) {
    assertHotelbedsApplyIsLocal(process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL);
  }

  const client = await getClient();
  try {
    const report = await runHotelbedsImport({ client, rawDir, apply, matchesOut });
    console.info(
      `[hotelbeds] ${report.apply ? "apply" : "dry-run"} records=${report.records} ` +
        `inserts=${report.inserts} upserts=${report.upserts} reviews=${report.reviews} ` +
        `skips=${report.skips} matches=${report.matches}`,
    );
    console.info(`[hotelbeds] matches csv ${report.matchesOut}`);
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  fail(message);
});
