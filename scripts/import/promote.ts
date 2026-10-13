/**
 * import:promote — reviewer-gated canonical promotion.
 *
 *   npm run import:promote -- --batch <uuid>            # PREVIEW (no mutations)
 *   npm run import:promote -- --batch <uuid> --apply    # remote canonical writes
 *   npm run import:promote -- --batch <uuid> --apply --allow-local
 *       # local/dev canonical writes (loopback, localhost, or local Supabase)
 *
 * There is no promote-all bypass. `--apply` requires complete approved review.
 * `--allow-local` does not relax the remote guard the other way: a remote
 * host is refused when the flag is set. Both apply modes require DATABASE_URL
 * and never fall back to TEST_DATABASE_URL.
 */
import { Client } from "pg";

import { promoteBatch } from "../../src/lib/import/promote";
import { assertApplyTarget } from "../../src/lib/import/preflight";
import { fail, getClient, parseArgs, requireString } from "./_shared";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const batchId = requireString(args, "batch");
  const apply = args.apply === true;
  const allowLocal = args["allow-local"] === true;
  if (allowLocal && !apply) {
    throw new Error("--allow-local requires --apply");
  }

  // Real canonical --apply must target an explicit database in DATABASE_URL.
  // Without --allow-local the target must be remote. With --allow-local the
  // target must be loopback, localhost, or local Supabase. PREVIEW keeps the
  // ordinary client (local/test DBs are fine for a zero-mutation preview).
  let client: Client;
  if (apply) {
    const { url, classification } = assertApplyTarget(process.env, { allowLocal });
    console.info(
      `\n[import:promote] --apply${allowLocal ? " --allow-local" : ""} target: ${classification.redactedTarget}`,
    );
    client = new Client({ connectionString: url });
    await client.connect();
  } else {
    client = await getClient();
  }

  try {
    const result = await promoteBatch(client, batchId, { apply });
    console.info(
      `\n[import:promote] batch ${batchId} — ${apply ? "APPLY" : "PREVIEW (no mutations)"}`,
    );
    console.info(
      `  review complete: ${result.reviewComplete}  batch status: ${result.batchStatus}`,
    );
    for (const b of result.bundles) {
      const line = `  • ${b.sourcePropertyKey} [${b.decision}] → ${b.action}`;
      const extra =
        b.action === "skip"
          ? ""
          : ` hotel=${b.hotelId ?? b.hotelSlug ?? "?"}${b.hotelAlreadyPromoted ? " (already)" : ""}` +
            ` contacts:+${b.contactsCreated}/~${b.contactsReused}/-${b.contactsSkipped}` +
            ` evidence:+${b.evidenceCreated}` +
            (b.filledHotelFields.length ? ` filled:${b.filledHotelFields.join(",")}` : "") +
            (b.conflicts.length ? ` conflicts:${b.conflicts.join(",")}` : "");
      console.info(line + extra + (b.error ? `  ERROR: ${b.error}` : ""));
    }
    const t = result.totals;
    console.info(
      `\n  totals: hotels +${t.hotelsCreated} created / ${t.hotelsMatched} matched, ` +
        `contacts +${t.contactsCreated} created / ${t.contactsReused} reused, evidence +${t.evidenceCreated}`,
    );
    if (!apply) console.info(`\n  Preview only — no canonical mutations. Re-run with --apply.\n`);
    else console.info("");
  } finally {
    await client.end();
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
