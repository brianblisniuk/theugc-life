/**
 * destination:upsert — create or update a canonical destination node with
 * validation (slug uniqueness, parent existence, no cycles, country
 * compatibility, taxonomy, coordinate range). Admin/server only.
 *
 *   npm run destination:upsert -- --slug bali --name Bali --type island --country ID
 *   npm run destination:upsert -- --slug ubud --name Ubud --type area --country ID --parent bali
 */
import { upsertDestination } from "../../../src/lib/import/destination";
import { fail, getClient, parseArgs, requireString } from "../_shared";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = await getClient();
  try {
    const result = await upsertDestination(client, {
      slug: requireString(args, "slug"),
      name: requireString(args, "name"),
      type: requireString(args, "type"),
      countryCode: typeof args.country === "string" ? args.country : null,
      countryName: typeof args["country-name"] === "string" ? args["country-name"] : null,
      parentSlug: typeof args.parent === "string" ? args.parent : null,
      latitude: typeof args.lat === "string" ? Number(args.lat) : null,
      longitude: typeof args.lng === "string" ? Number(args.lng) : null,
      isSellable: args.sellable === true ? true : undefined,
      isFeatured: args.featured === true ? true : undefined,
    });
    console.info(
      `\n[destination:upsert] ${result.created ? "created" : "updated"} ${requireString(args, "slug")} (${result.id})\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
