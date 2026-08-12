/**
 * import:dry-run — stage (if needed) + resolve + write JSON/Markdown reports to
 * data/imports/reports/ (gitignored). NEVER promotes to canonical tables.
 *
 *   npm run import:dry-run -- --file <path> [--contacts <csv>] [--evidence <csv>]
 *   npm run import:dry-run -- --file <path> --adapter <legacy-key> [--force]
 */
import { dryRunFile } from "../../src/lib/import/pipeline";
import { fail, getClient, parseArgs, requireString } from "./_shared";
import { getLegacyAdapter, listLegacyAdapters } from "./legacy";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = requireString(args, "file");
  const adapterKey = typeof args.adapter === "string" ? args.adapter : undefined;
  const adapter = adapterKey ? getLegacyAdapter(adapterKey) : undefined;

  const client = await getClient();
  try {
    const result = await dryRunFile(client, {
      file,
      contacts: typeof args.contacts === "string" ? args.contacts : undefined,
      evidence: typeof args.evidence === "string" ? args.evidence : undefined,
      sourceName: typeof args.source === "string" ? args.source : undefined,
      adapter,
      force: args.force === true,
    });
    const s = result.report.summary;
    console.info(`\n[import:dry-run] batch ${result.batchId}${result.reused ? " (reused)" : ""}`);
    console.info(`  properties=${s.properties} contacts=${s.contacts} evidence=${s.evidence}`);
    console.info(
      `  valid=${s.validRows} warning=${s.warningRows} review=${s.reviewRows} rejected=${s.rejectedRows}`,
    );
    console.info(
      `  safe-matches=${s.deterministicSafeMatches} fuzzy=${s.fuzzyReviewCandidates} ` +
        `unresolved-destinations=${s.unresolvedDestinations} org-candidates=${s.organizationCandidates}`,
    );
    console.info(`  reports:\n    ${result.paths.json}\n    ${result.paths.md}`);
    console.info(`\n  No canonical promotion performed (Sprint 1A stop condition).\n`);
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
