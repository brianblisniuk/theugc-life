/**
 * destination:list — print the canonical destination catalog (admin/server).
 *   npm run destination:list
 */
import { listDestinations } from "../../../src/lib/import/destination";
import { fail, getClient } from "../_shared";

async function main() {
  const client = await getClient();
  try {
    const rows = await listDestinations(client);
    if (rows.length === 0) {
      console.info("\n(no destinations)\n");
      return;
    }
    console.info("");
    for (const r of rows) {
      const parent = r.parentSlug ? ` ← ${r.parentSlug}` : "";
      const sell = r.isSellable ? " [sellable]" : "";
      console.info(
        `  ${r.slug}  (${r.type}, ${r.countryCode ?? "—"})  "${r.name}"${parent}  aliases:${r.aliasCount}${sell}`,
      );
    }
    console.info(`\n${rows.length} destination(s).\n`);
  } finally {
    await client.end();
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
