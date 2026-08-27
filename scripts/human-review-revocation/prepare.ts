/**
 * READ-ONLY revocation-pack CLI.
 *
 *   npm run source:review:revoke:prepare -- \
 *     --source hotelbeds --environment evaluation \
 *     [--identity <uuid>] --out .data/human-review/revocation.json
 *
 * Lists the approvals that currently authorize D062 and emits a manifest whose
 * human fields are EMPTY. There is no --apply here; this command withdraws
 * nothing.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import { resolveReviewWriteTarget } from "../human-review/target";
import { buildRevocationPack } from "./pack";

export interface RevokePrepareArgs {
  source: string;
  environment: "evaluation" | "production";
  identityId: string | null;
  out: string | null;
}

export function parseRevokePrepareArgs(argv: readonly string[]): RevokePrepareArgs {
  const get = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
  };
  const environment = get("environment");
  if (environment !== "evaluation" && environment !== "production")
    throw new Error("--environment must be explicit: evaluation or production.");
  const source = get("source");
  if (!source) throw new Error("--source <provider> is required and has no implicit default.");
  return { source, environment, identityId: get("identity"), out: get("out") };
}

async function main(): Promise<void> {
  const args = parseRevokePrepareArgs(process.argv.slice(2));
  // Prepare never writes, but it still refuses an unclassifiable target: a
  // revocation pack built from a database nobody can identify is not evidence.
  const target = resolveReviewWriteTarget(process.env, {
    environment: args.environment,
    apply: false,
  });

  const client = new Client({ connectionString: target.url });
  await client.connect();
  try {
    const pack = await buildRevocationPack(client, args);
    const json = JSON.stringify(pack, null, 2);
    if (args.out) {
      mkdirSync(path.dirname(args.out), { recursive: true });
      writeFileSync(args.out, json + "\n");
    } else {
      console.info(json);
    }
    console.info(
      `\n[review:revoke:prepare] ${pack.preparedFrom.activeApprovals} active approve_create review(s)\n` +
        `  revocable (receipt-pinned)   ${pack.preparedFrom.revocable}\n` +
        `  skipped (no receipt to pin)  ${pack.preparedFrom.withoutReceipt}\n` +
        `  skipped (INCOHERENT pointer) ${pack.preparedFrom.incoherentProjections}\n` +
        `  skipped (ALREADY revoked)    ${pack.preparedFrom.revocationStateIncoherent}\n` +
        (args.out ? `  written to ${args.out}\n` : "") +
        "  reviewerLabel and revocationNote are EMPTY. This command withdraws nothing.\n",
    );
    // Loud, not footnotes. Both counts should be structurally impossible — 0033
    // refuses to store either state — so a non-zero value means the invariant
    // was bypassed some other way, and an operator needs to know that BEFORE
    // they withdraw anything.
    if (pack.preparedFrom.revocationStateIncoherent > 0)
      console.warn(
        `  !! ${pack.preparedFrom.revocationStateIncoherent} active approval(s) name a receipt that ALREADY carries an\n` +
          "     immutable revocation. History says withdrawn; the projection says active. The database\n" +
          "     refuses to store that, so something wrote it another way. Investigate before revoking:\n" +
          pack.preparedFrom.revocationStateIncoherentIdentityIds
            .map((id) => `       ${id}`)
            .join("\n") +
          "\n",
      );
    // A different diagnosis: here the pointer itself does not represent the
    // projection, so nobody can say which approval authorizes D062 at all.
    if (pack.preparedFrom.incoherentProjections > 0)
      console.warn(
        `  !! ${pack.preparedFrom.incoherentProjections} active approval(s) have a current_receipt_id that does not\n` +
          "     semantically represent the projection, and were EXCLUDED rather than aimed at the\n" +
          "     wrong receipt. Investigate before revoking:\n" +
          pack.preparedFrom.incoherentIdentityIds.map((id) => `       ${id}`).join("\n") +
          "\n",
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
      `\n[review:revoke:prepare] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
