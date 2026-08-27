/**
 * A05 PUBLICATION PREPARE CLI — read-only.
 *
 *   npm run source:publication:prepare -- \
 *     --source hotelbeds --environment production --as-of YYYY-MM-DD \
 *     [--limit N] --out .data/source-publication/pack.json
 *
 * Emits only PRODUCTION identities whose real, recomputed D062 result is PASS on
 * all eleven conditions and whose human approval is current and still
 * authorized. Every human publication-authorization field is left EMPTY: an
 * unedited pack is refused by the apply path, because `--apply` is a flag and
 * not a person.
 *
 * This command writes nothing to the database.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import { isValidIsoDate } from "../lifecycle/policy";
import { buildPublicationPack } from "./pack";
import { resolvePublicationTarget } from "./target";

export interface PrepareArgs {
  source: string;
  environment: "production";
  asOf: string;
  limit: number | null;
  out: string | null;
}

export function parsePrepareArgs(argv: readonly string[]): PrepareArgs {
  const get = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
  };
  const asOf = get("as-of");
  if (!asOf || !isValidIsoDate(asOf))
    throw new Error("--as-of YYYY-MM-DD is required and must be a real date.");
  const environment = get("environment");
  // Deliberately not "defaults to production": the environment must be typed
  // out, so nobody prepares a publication pack while thinking about evaluation.
  if (environment !== "production")
    throw new Error(
      "--environment must be explicit and must be `production`. A05 publishes canonical inventory, and evaluation provider data is never canonical evidence.",
    );
  const source = get("source");
  if (!source) throw new Error("--source <provider> is required and has no implicit default.");
  const limitRaw = get("limit");
  return {
    source,
    environment,
    asOf,
    limit: limitRaw === null ? null : Number(limitRaw),
    out: get("out"),
  };
}

async function main(): Promise<void> {
  const args = parsePrepareArgs(process.argv.slice(2));
  const target = resolvePublicationTarget(process.env, { apply: false });
  const client = new Client({ connectionString: target.url });
  await client.connect();
  try {
    const pack = await buildPublicationPack(client, {
      source: args.source,
      environment: args.environment,
      asOf: args.asOf,
      limit: args.limit,
    });
    console.info("\n[source-publication:prepare] A05 publication candidates (read-only)\n");
    console.info(`  database      ${target.classification.redactedTarget}`);
    console.info(`  source        ${args.source} / ${args.environment}`);
    console.info(`  as-of         ${args.asOf}  (explicit; never the system clock)`);
    console.info(`  evaluated     ${pack.preparedFrom.identitiesEvaluated} identities`);
    console.info(`  D062 11/11    ${pack.preparedFrom.d062Pass}`);
    console.info(`  already publ. ${pack.preparedFrom.alreadyPublished}`);
    console.info(
      `  skipped       ${pack.preparedFrom.skippedNotAuthorizedByHuman} not currently human-approved`,
    );
    console.info(`  emitted       ${pack.preparedFrom.emitted}\n`);
    if (args.out) {
      writeFileSync(args.out, `${JSON.stringify(pack, null, 2)}\n`);
      console.info(`  written to    ${args.out}\n`);
    } else {
      console.info(JSON.stringify(pack, null, 2));
    }
    console.info(
      "  Every item is UNAUTHORIZED. A human must set publicationAuthorized, authorizedByLabel\n" +
        "  and authorizationNote before apply will do anything. A D062 PASS is necessary and is\n" +
        "  not authorization.\n",
    );
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly)
  main().catch((error: unknown) => {
    console.error(
      `\n[source-publication:prepare] failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
