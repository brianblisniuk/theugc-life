/**
 * destination:alias — add an editorial alias mapping a research term to a
 * canonical destination. Admin/server only.
 *
 *   npm run destination:alias -- --slug florianopolis --alias Floripa --country BR
 */
import { addAlias } from "../../../src/lib/import/destination";
import { fail, getClient, parseArgs, requireString } from "../_shared";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = await getClient();
  try {
    const result = await addAlias(client, {
      destinationSlug: requireString(args, "slug"),
      alias: requireString(args, "alias"),
      countryCode: typeof args.country === "string" ? args.country : null,
      source: typeof args.source === "string" ? args.source : undefined,
    });
    console.info(
      `\n[destination:alias] added alias "${requireString(args, "alias")}" → ${requireString(args, "slug")} (${result.id})\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  if (err instanceof Error && /duplicate key/.test(err.message)) {
    fail("that active alias already exists for this destination");
  }
  fail(err instanceof Error ? err.message : String(err));
});
