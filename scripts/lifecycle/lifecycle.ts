/**
 * source:lifecycle — pre-publication lifecycle / closure evidence.
 *
 *   npm run source:lifecycle -- --provider hotelbeds --as-of 2026-08-17
 *   npm run source:lifecycle -- --provider hotelbeds --as-of 2026-08-17 --extract --apply
 *
 * TWO SEPARATE THINGS, AND ONLY ONE OF THEM WRITES
 * -----------------------------------------------
 * EXTRACTION persists provider issue evidence, and like every other writer in
 * this repository it is DRY-RUN unless `--apply` is given, and refuses any
 * target that is not a disposable local database.
 *
 * EVALUATION is READ-ONLY, always. It answers "is there a current property-level
 * closure window as of this date?" and stores nothing — because the answer is
 * not a durable fact. A closure window changes its current meaning when the
 * calendar moves and nobody said anything new, so a stored `active` boolean
 * would be false the next morning, and refreshing it would mean re-deriving
 * 4,110 rows a day to record a statement no provider made.
 *
 * `--as-of` IS REQUIRED. There is no default and no clock read: an evaluation
 * without a date is not a question, and a future D062 receipt has to be able to
 * say which date it used.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import {
  resolveIngestionTarget,
  UnsafeIngestionTargetError,
} from "../provider-ingestion/db-target";
import { extractDestinationIssues } from "./extract";
import {
  evaluateLifecycle,
  isValidIsoDate,
  OUTCOME_MEANINGS,
  type LifecycleEvaluation,
  type LifecycleOutcome,
} from "./policy";
import {
  loadEvaluableProperties,
  loadLifecyclePolicy,
  persistIssueEvidence,
  type EvaluableProperty,
} from "./store";

const EVALUATION = "evaluation" as const;
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

export interface LifecycleArgs {
  provider: string;
  asOf: string;
  destinations: string[];
  extract: boolean;
  apply: boolean;
  limit: number;
}

export function parseArgs(argv: readonly string[]): LifecycleArgs {
  const get = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
  };
  const environment = get("environment");
  if (environment && environment !== EVALUATION) {
    throw new Error(
      `--environment ${environment} is not available. Lifecycle evidence is locked to ` +
        "`evaluation` in this block: production ingestion does not exist yet.",
    );
  }
  const asOf = get("as-of");
  if (asOf === null) {
    throw new Error(
      "--as-of YYYY-MM-DD is REQUIRED. A closure window's current meaning depends on the date, " +
        "so this command will not guess one from the system clock.",
    );
  }
  if (!isValidIsoDate(asOf)) {
    throw new Error(`--as-of must be a real YYYY-MM-DD date; received ${JSON.stringify(asOf)}.`);
  }
  const destinations = (get("destinations") ?? "bali,dubai")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  return {
    provider: get("provider") ?? "hotelbeds",
    asOf,
    destinations,
    extract: argv.includes("--extract"),
    apply: argv.includes("--apply"),
    limit: Number(get("limit") ?? 25),
  };
}

export interface LifecycleReport {
  identities: number;
  withCompleteSnapshot: number;
  withoutCompleteSnapshot: number;
  issueRows: number;
  issuesByType: Record<string, number>;
  /** Keyed `type\u0000code`. Never a type on its own. */
  byCodeAndType: Record<string, number>;
  outcomes: Record<LifecycleOutcome, number>;
  knownClosed: { property: EvaluableProperty; evaluation: LifecycleEvaluation }[];
  unresolved: { property: EvaluableProperty; evaluation: LifecycleEvaluation }[];
}

/** Evaluate every property, and tally. Pure over what it is handed. */
export function buildReport(
  properties: readonly EvaluableProperty[],
  policy: Parameters<typeof evaluateLifecycle>[0]["policy"],
  asOf: string,
): LifecycleReport {
  const report: LifecycleReport = {
    identities: properties.length,
    withCompleteSnapshot: 0,
    withoutCompleteSnapshot: 0,
    issueRows: 0,
    issuesByType: {},
    byCodeAndType: {},
    outcomes: { known_closed: 0, no_known_closure: 0, unresolved: 0 },
    knownClosed: [],
    unresolved: [],
  };

  for (const property of properties) {
    if (property.snapshot === null) report.withoutCompleteSnapshot += 1;
    else {
      report.withCompleteSnapshot += 1;
      for (const issue of property.snapshot.issues) {
        report.issueRows += 1;
        report.issuesByType[issue.issueType] = (report.issuesByType[issue.issueType] ?? 0) + 1;
        // Tallied by the PAIR, never by the type alone. The report groups
        // `code + type` and the display picks a group out by name, so there is
        // no place in this file — not even a counter — where a bare
        // `issueType` decides anything about a code it was never paired with.
        const pair = `${issue.issueType}\u0000${issue.issueCode}`;
        report.byCodeAndType[pair] = (report.byCodeAndType[pair] ?? 0) + 1;
      }
    }

    const evaluation = evaluateLifecycle({
      snapshot: property.snapshot,
      policy,
      asOf,
      latestObservationId: property.currentObservationId,
      hasCurrentObservation: property.currentObservationId !== null,
    });
    report.outcomes[evaluation.outcome] += 1;
    if (evaluation.outcome === "known_closed") report.knownClosed.push({ property, evaluation });
    if (evaluation.outcome === "unresolved") report.unresolved.push({ property, evaluation });
  }
  return report;
}

/** The codes recorded under one issue type, from the pair tally. */
export function codesFor(report: LifecycleReport, issueType: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, n] of Object.entries(report.byCodeAndType)) {
    const [type, code] = key.split("\u0000") as [string, string];
    if (type === issueType) out[code] = n;
  }
  return out;
}

function table(title: string, bucket: Record<string, number>): void {
  const entries = Object.entries(bucket).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  console.info(`    ${title.padEnd(22)}${entries.map(([k, v]) => `${k}=${v}`).join("  ") || "—"}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = resolveIngestionTarget(process.env);

  console.info("\n[source:lifecycle] pre-publication lifecycle / closure evidence\n");
  console.info(`  provider      ${args.provider}`);
  console.info(`  environment   ${EVALUATION} (locked)`);
  console.info(`  as-of         ${args.asOf}  (explicit; never the system clock)`);
  console.info(
    `  extraction    ${args.extract ? (args.apply ? "APPLY" : "DRY-RUN (no writes)") : "skipped"}`,
  );
  console.info(`  evaluation    READ-ONLY (always)`);
  console.info(`  database      ${target.classification.redactedTarget}\n`);

  const client = new Client({ connectionString: target.url });
  await client.connect();
  try {
    if (args.extract) {
      const extracted = [];
      const extractionFailures = [];
      for (const destination of args.destinations) {
        const outcome = await extractDestinationIssues(destination, REPO_ROOT);
        extracted.push(...outcome.snapshots);
        extractionFailures.push(...outcome.failures);
      }
      const counts = await persistIssueEvidence(client, extracted, {
        source: args.provider,
        environment: EVALUATION,
        apply: args.apply,
      });
      console.info("  ISSUE EXTRACTION (cached artifacts only — zero provider calls)");
      console.info(
        `    complete snapshots    ${counts.completeSnapshotsExtracted} extracted from the artifacts`,
      );
      console.info(`    snapshots created     ${counts.snapshotsCreated}`);
      console.info(`    snapshots already on  ${counts.snapshotsAlreadyPresent} (left untouched)`);
      console.info(`    issue rows created    ${counts.issuesCreated}`);
      console.info(
        `    INCOMPLETE extraction ${extractionFailures.length}   <- no snapshot; evaluates unresolved`,
      );
      if (extractionFailures.length > 0) {
        const byReason: Record<string, number> = {};
        for (const f of extractionFailures) byReason[f.reason] = (byReason[f.reason] ?? 0) + 1;
        table("reason", byReason);
        for (const f of extractionFailures.slice(0, args.limit)) {
          console.info(
            `      ${f.sourcePropertyId ?? "(no id)"}  ${f.reason}` +
              (f.issueIndex === null ? "" : `  entry #${f.issueIndex}`) +
              (f.providerOrder === null ? "" : `  order=${f.providerOrder}`),
          );
        }
      }
      console.info(
        `    PROVENANCE mismatch   ${counts.provenanceMismatches.length}   <- artifact record not tied to an observation`,
      );
      if (counts.provenanceMismatches.length > 0) {
        const byReason: Record<string, number> = {};
        for (const m of counts.provenanceMismatches) {
          byReason[m.reason] = (byReason[m.reason] ?? 0) + 1;
        }
        table("reason", byReason);
        for (const m of counts.provenanceMismatches.slice(0, args.limit)) {
          console.info(`      ${m.sourcePropertyId}  run=${m.sourceRunId}  ${m.reason}`);
        }
      }
      console.info("");
    }

    const policy = await loadLifecyclePolicy(client, { provider: args.provider });
    if (policy === null) {
      throw new Error(
        `No lifecycle policy exists for ${args.provider}. Nothing may be evaluated without a ` +
          "reviewed policy: the mapping from a provider's vocabulary to a closure is a product " +
          "decision, not a default.",
      );
    }

    const properties = await loadEvaluableProperties(client, {
      source: args.provider,
      environment: EVALUATION,
    });
    const report = buildReport(properties, policy, args.asOf);

    console.info(`  POLICY        ${policy.provider}/${policy.version} (${policy.dateSemantics})`);
    for (const m of policy.mappings) {
      console.info(`    ${m.issueCode} + ${m.issueType}  ->  ${m.outcome}`);
    }
    console.info(
      "    ^ only these PAIRS are property-level. issueType alone means nothing here.\n",
    );

    console.info("  EVIDENCE");
    console.info(`    identities            ${report.identities}`);
    console.info(`    complete snapshot     ${report.withCompleteSnapshot}`);
    console.info(
      `    NO complete snapshot  ${report.withoutCompleteSnapshot}   <- ignorance, not "no issues"`,
    );
    console.info(`    issue rows            ${report.issueRows}`);
    table("by issueType", report.issuesByType);
    table("CLOSED by code", codesFor(report, "CLOSED"));
    console.info("");

    console.info(`  LIFECYCLE AS OF ${args.asOf}`);
    console.info(`    KNOWN_CLOSED          ${report.outcomes.known_closed}`);
    console.info(`    NO_KNOWN_CLOSURE      ${report.outcomes.no_known_closure}`);
    console.info(`    UNRESOLVED            ${report.outcomes.unresolved}`);
    console.info("");
    for (const [outcome, meaning] of Object.entries(OUTCOME_MEANINGS)) {
      console.info(`    ${outcome.padEnd(18)}${meaning}`);
    }
    console.info("");

    if (report.knownClosed.length > 0) {
      console.info("  KNOWN_CLOSED PROPERTIES");
      for (const { property, evaluation } of report.knownClosed.slice(0, args.limit)) {
        console.info(
          `    ${property.sourcePropertyId}  ${property.name ?? "(no name)"}  [${property.destinationSlug ?? "?"}]`,
        );
        for (const w of evaluation.activeClosureWindows) {
          console.info(
            `      ${w.issueCode} + ${w.issueType}   ${w.dateFrom} → ${w.dateTo}   (a DATE RANGE, not permanent closure)`,
          );
        }
      }
      console.info("");
    }

    if (report.unresolved.length > 0) {
      const reasons: Record<string, number> = {};
      for (const u of report.unresolved) {
        for (const r of u.evaluation.unresolvedReasons) reasons[r] = (reasons[r] ?? 0) + 1;
      }
      console.info("  UNRESOLVED, BY REASON");
      table("reason", reasons);
      console.info("");
    }

    console.info("  canonical writes: 0 hotels, 0 links, 0 reviews, 0 canonical lifecycle");
    console.info("  This layer does NOT decide publication. D062 composes it later.\n");
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((err: unknown) => {
    if (err instanceof UnsafeIngestionTargetError) {
      console.error(`\n[source:lifecycle] STOP\n\n${err.message}\n`);
      process.exit(2);
    }
    console.error(`\n[source:lifecycle] failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
