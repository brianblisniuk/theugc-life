#!/usr/bin/env tsx
/**
 * B07 inference benchmark CLI.
 *
 *   tsx scripts/b07-benchmark/cli.ts status
 *   tsx scripts/b07-benchmark/cli.ts baseline
 *   tsx scripts/b07-benchmark/cli.ts screen  [--candidate id]... [--dry-run]
 *   tsx scripts/b07-benchmark/cli.ts final   [--candidate id]... [--dry-run]
 *   tsx scripts/b07-benchmark/cli.ts report  --run <run-id>
 *
 * This harness is an EVALUATION tool. It reads a synthetic fixture corpus. It
 * performs no Gmail API call, opens no database connection and imports nothing
 * from `src/`.
 */
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { loadLocalEnv } from "../provider-evaluation/env";
import { collectSecretValues, createSafeLogger } from "../provider-evaluation/redact";
import {
  ALL_CANDIDATES,
  BASELINE_CANDIDATE,
  MODEL_CANDIDATES,
  PROVIDER_KEY_ENV,
  candidateById,
  hasApiKey,
  modelOverrideEnvVar,
  resolveModel,
  type Candidate,
} from "./config/candidates";
import { priceBookFor } from "./config/pricing";
import { INFERENCE_POLICY_VERSION } from "./config/inference-config";
import { CORPUS_VERSION, corpusStats, taxonomyCoverage } from "./corpus/load";
import type { CorpusCase } from "./corpus/schema";
import { PROMPT_VERSION } from "./prompt/render";
import { VENDOR_SCREEN, VENDOR_SCREEN_STANDING_CONCLUSION } from "./privacy/vendor-screen";
import { renderReport } from "./report/render";
import { B07_BENCHMARK_SCHEMA_VERSION } from "./schema";
import { scoreCandidate, type CandidateScore } from "./scoring/score";
import { decide } from "./scoring/targets";
import { readManifest, readResults, writeJson, writeText } from "./run/artifacts";
import { resolveSelection, reconstructSelection } from "./run/selection";
import { newRunId, runCandidate } from "./run/runner";
import type { CaseResult, FinalistProvenance, RunManifest } from "./run/types";
import type { CorpusSplit } from "./taxonomy";

loadLocalEnv();
const log = createSafeLogger(collectSecretValues());

export interface Args {
  command: string;
  candidates: string[];
  dryRun: boolean;
  resume: boolean;
  concurrency: number;
  maxSchemaRetries: number;
  runId: string | null;
  split: CorpusSplit | null;
  criticalOnly: boolean;
  /** Stage-2 auditability: which Stage-1 screening run these finalists were drawn from. */
  fromRun: string | null;
  /** Stage-2 auditability: REQUIRED when any selected candidate has role "ceiling". */
  finalistReason: string | null;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    command: argv[0] ?? "status",
    candidates: [],
    dryRun: false,
    resume: false,
    concurrency: 4,
    maxSchemaRetries: 1,
    runId: null,
    split: null,
    criticalOnly: false,
    fromRun: null,
    finalistReason: null,
  };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--candidate":
        args.candidates.push(next());
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--resume":
        args.resume = true;
        break;
      case "--concurrency":
        args.concurrency = Number.parseInt(next(), 10);
        break;
      case "--max-schema-retries":
        args.maxSchemaRetries = Number.parseInt(next(), 10);
        break;
      case "--run":
        args.runId = next();
        break;
      case "--split":
        args.split = next() as CorpusSplit;
        break;
      case "--critical-only":
        args.criticalOnly = true;
        break;
      case "--from-run":
        args.fromRun = next();
        break;
      case "--finalist-reason":
        args.finalistReason = next();
        break;
      default:
        throw new Error(`unknown flag: ${arg}`);
    }
  }
  if (!Number.isFinite(args.concurrency) || args.concurrency < 1) {
    throw new Error("--concurrency must be >= 1");
  }
  if (!Number.isFinite(args.maxSchemaRetries) || args.maxSchemaRetries < 0) {
    throw new Error("--max-schema-retries must be >= 0");
  }
  if (args.maxSchemaRetries > 1) {
    // The round caps this at one bounded retry so a weak candidate cannot be
    // made to look reliable by retrying until it happens to comply.
    throw new Error("--max-schema-retries is capped at 1 for benchmark fairness");
  }
  return args;
}

function commandStatus(): void {
  const stats = corpusStats();
  log("B07 inference benchmark — status");
  log("");
  log(`corpus version : ${CORPUS_VERSION}`);
  log(`prompt version : ${PROMPT_VERSION}`);
  log(`schema version : ${B07_BENCHMARK_SCHEMA_VERSION}`);
  log("");
  log(`cases          : ${stats.total}`);
  log(`  by split     : ${JSON.stringify(stats.by_split)}`);
  log(`  by task      : ${JSON.stringify(stats.by_task)}`);
  log(`  by language  : ${JSON.stringify(stats.by_language)}`);
  log(
    `  critical     : ${stats.critical_suite_total} ${JSON.stringify(stats.critical_suite_by_split)}`,
  );
  log("");
  log("taxonomy coverage:");
  for (const [group, counts] of Object.entries(taxonomyCoverage())) {
    log(`  ${group}: ${JSON.stringify(counts)}`);
  }
  log("");
  log("candidates:");
  for (const candidate of ALL_CANDIDATES) {
    const key =
      candidate.providerId === "local"
        ? "n/a"
        : hasApiKey(candidate.providerId)
          ? "key present"
          : `MISSING ${PROVIDER_KEY_ENV[candidate.providerId]}`;
    log(
      `  ${candidate.id.padEnd(28)} ${candidate.role.padEnd(10)} model=${resolveModel(candidate).padEnd(24)} ${key} (${candidate.idVerification})`,
    );
    log(`      override env: ${modelOverrideEnvVar(candidate.id)}`);
  }
  log("");
  log("privacy / vendor screen:");
  for (const note of VENDOR_SCREEN_STANDING_CONCLUSION) log(`  ! ${note}`);
  for (const entry of VENDOR_SCREEN) {
    log(
      `  ${entry.provider_id.padEnd(10)} synthetic=${entry.synthetic_suitability} gmail=${entry.private_gmail_candidacy} verification=${entry.verification}`,
    );
  }
}

export async function runStage(stage: "baseline" | "screen" | "final", args: Args): Promise<void> {
  // FIXED (external audit finding 4): Stage 2 ("final") must never
  // accidentally spend money across every configured model or an implicit
  // ceiling. Fail BEFORE any case selection, corpus load or provider call.
  if (stage === "final" && args.candidates.length === 0) {
    throw new Error(
      '`final` requires explicit --candidate <id> finalist(s) — Stage 2 never auto-runs every configured model or an implicit quality ceiling. Pass each finalist explicitly, e.g. --candidate anthropic-sonnet-5 --candidate openai-gpt-5-6-luna. A ceiling-role candidate additionally requires --finalist-reason "<why>".',
    );
  }

  const split: CorpusSplit | "all" =
    args.split ?? (stage === "final" ? "holdout" : stage === "screen" ? "dev" : "all");

  const selection = resolveSelection({ split, criticalOnly: args.criticalOnly });
  const cases = selection.cases;
  if (cases.length === 0) throw new Error("selection produced zero cases");

  let candidates: Candidate[];
  if (args.candidates.length > 0) {
    candidates = args.candidates.map((id) => {
      const found = candidateById(id);
      if (!found) throw new Error(`unknown candidate: ${id}`);
      return found;
    });
  } else if (stage === "baseline") {
    candidates = [BASELINE_CANDIDATE];
  } else {
    // stage === "screen" (the only remaining implicit-default stage; "final"
    // was refused above when no --candidate was given).
    candidates = [BASELINE_CANDIDATE, ...MODEL_CANDIDATES.filter((c) => c.role === "screening")];
  }

  // FIXED (external audit finding 4/14): a ceiling candidate is NEVER
  // implicit, and every finalist selection must be auditable — a ceiling
  // inclusion must state why.
  const ceilingSelected = candidates.filter((c) => c.role === "ceiling");
  if (ceilingSelected.length > 0 && !args.finalistReason) {
    throw new Error(
      `ceiling candidate(s) ${ceilingSelected.map((c) => c.id).join(", ")} require --finalist-reason "<why this ceiling is materially useful here>" — a quality ceiling is opt-in only and must be explained, never silently included.`,
    );
  }

  const finalistProvenance: FinalistProvenance | null =
    stage === "final"
      ? {
          screen_run_id: args.fromRun,
          finalist_reason: args.finalistReason,
          candidate_roles: Object.fromEntries(candidates.map((c) => [c.id, c.role])),
        }
      : null;

  const runId = args.runId ?? newRunId(stage);
  const manifest: RunManifest = {
    run_id: runId,
    stage,
    split,
    corpus_version: CORPUS_VERSION,
    prompt_version: PROMPT_VERSION,
    schema_version: B07_BENCHMARK_SCHEMA_VERSION,
    inference_policy_version: INFERENCE_POLICY_VERSION,
    candidate_ids: candidates.map((c) => c.id),
    started_at: new Date().toISOString(),
    finished_at: null,
    concurrency: args.concurrency,
    max_schema_retries: args.maxSchemaRetries,
    dry_run: args.dryRun,
    selection: selection.meta,
    selected_case_ids: selection.caseIds,
    case_set_digest: selection.digest,
    finalist_provenance: finalistProvenance,
  };

  if (args.resume) {
    const prior = readManifest(runId);
    if (
      prior &&
      (prior.prompt_version !== manifest.prompt_version ||
        prior.schema_version !== manifest.schema_version ||
        prior.corpus_version !== manifest.corpus_version)
    ) {
      // Refusing is the point: mixing results computed under different
      // prompt/schema/corpus versions into one report is a silent lie.
      throw new Error(
        `refusing to resume run ${runId}: version mismatch (stored ${prior.prompt_version}/${prior.schema_version}/${prior.corpus_version})`,
      );
    }
    if (prior && prior.case_set_digest !== manifest.case_set_digest) {
      // FIXED (external audit finding 3): a resume that changed the
      // selection (e.g. added --critical-only, or a different --split) must
      // never be silently accepted under the same run id.
      throw new Error(
        `refusing to resume run ${runId}: selection changed (stored case_set_digest ${prior.case_set_digest}, requested ${manifest.case_set_digest}); use a new --run id for a different selection`,
      );
    }
  }
  writeJson(runId, "manifest.json", manifest);

  log(`run id      : ${runId}`);
  log(`stage       : ${stage}`);
  log(`split       : ${split}`);
  log(`critical only : ${args.criticalOnly}`);
  log(`cases       : ${cases.length}`);
  log(`case set digest : ${selection.digest}`);
  log(`candidates  : ${candidates.map((c) => c.id).join(", ")}`);
  log(`inference policy : ${INFERENCE_POLICY_VERSION}`);
  log(`dry run     : ${args.dryRun}`);
  log("");

  const allResults: CaseResult[] = [];
  for (const candidate of candidates) {
    const outcome = await runCandidate({
      runId,
      candidate,
      cases,
      concurrency: args.concurrency,
      maxSchemaRetries: args.maxSchemaRetries,
      dryRun: args.dryRun,
      resume: args.resume,
      log,
    });
    allResults.push(...outcome.results);
    log(
      `  ${candidate.id.padEnd(28)} availability=${outcome.availability} results=${outcome.results.length} reused=${outcome.reusedFromResume}`,
    );
  }

  manifest.finished_at = new Date().toISOString();
  writeJson(runId, "manifest.json", manifest);

  emitReport(runId, stage, cases, allResults, finalistProvenance);
}

function emitReport(
  runId: string,
  stage: string,
  cases: readonly CorpusCase[],
  results: readonly CaseResult[],
  finalistProvenance: FinalistProvenance | null = null,
): void {
  const byCandidate = new Map<string, CaseResult[]>();
  for (const result of results) {
    const bucket = byCandidate.get(result.candidate_id) ?? [];
    bucket.push(result);
    byCandidate.set(result.candidate_id, bucket);
  }

  const scores: CandidateScore[] = [];
  const absences: { candidate_id: string; model: string; reason: string }[] = [];

  for (const [candidateId, candidateResults] of byCandidate) {
    const candidate = candidateById(candidateId);
    const model = candidateResults[0]?.requested_model ?? candidate?.model ?? "unknown";
    const attempted = candidateResults.filter(
      (r) =>
        r.status !== "not_run_missing_key" && r.status !== "unavailable" && r.status !== "dry_run",
    );
    if (attempted.length === 0) {
      const reason = candidateResults.find((r) => r.status === "not_run_missing_key")
        ? "not_run_missing_key"
        : candidateResults.find((r) => r.status === "unavailable")
          ? "unavailable"
          : "dry_run";
      absences.push({ candidate_id: candidateId, model, reason });
      continue;
    }
    scores.push(
      scoreCandidate({
        candidateId,
        providerId: candidateResults[0]?.provider_id ?? candidate?.providerId ?? "local",
        requestedModel: model,
        corpusVersion: CORPUS_VERSION,
        promptVersion: PROMPT_VERSION,
        schemaVersion: B07_BENCHMARK_SCHEMA_VERSION,
        cases,
        results: candidateResults,
        priceBook: priceBookFor(candidateId),
      }),
    );
  }

  scores.sort((a, b) => a.candidate_id.localeCompare(b.candidate_id));

  const decision = decide(scores, BASELINE_CANDIDATE.id);
  const markdown = renderReport({
    runId,
    stage,
    generatedAt: new Date().toISOString(),
    corpus: corpusStats(),
    scores,
    absences,
    finalistProvenance,
  });

  const reportPath = writeText(runId, "report.md", markdown);
  const scoresPath = writeJson(runId, "scores.json", { scores, absences, decision });

  log("");
  log(markdown);
  log(`report  : ${reportPath}`);
  log(`scores  : ${scoresPath}`);
  log("");
  log(`DECISION: ${decision.outcome}`);
  for (const reason of decision.reasons) log(`  - ${reason}`);
}

export function commandReport(args: Args): void {
  if (!args.runId) throw new Error("report requires --run <run-id>");
  const manifest = readManifest(args.runId);
  if (!manifest) throw new Error(`no manifest for run ${args.runId}`);
  if (
    manifest.prompt_version !== PROMPT_VERSION ||
    manifest.schema_version !== B07_BENCHMARK_SCHEMA_VERSION ||
    manifest.corpus_version !== CORPUS_VERSION
  ) {
    throw new Error(
      `run ${args.runId} was produced under ${manifest.prompt_version}/${manifest.schema_version}/${manifest.corpus_version}; refusing to report it under the current ${PROMPT_VERSION}/${B07_BENCHMARK_SCHEMA_VERSION}/${CORPUS_VERSION}`,
    );
  }
  // FIXED (external audit finding 3): reconstruct the EXACT scored case set
  // from the manifest's own recorded selection identity, never by
  // recomputing from `split` alone — that is precisely how a `--critical-
  // only` run used to get reported as though it had scored the full split.
  // `reconstructSelection` throws `SelectionMismatchError` rather than
  // substituting a different case set when the recorded ids and digest
  // disagree, or when the corpus can no longer produce a recorded id.
  const cases = reconstructSelection(manifest);
  emitReport(
    args.runId,
    manifest.stage,
    cases,
    readResults(args.runId),
    manifest.finalist_provenance,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "status":
      commandStatus();
      break;
    case "baseline":
      await runStage("baseline", args);
      break;
    case "screen":
      await runStage("screen", args);
      break;
    case "final":
      await runStage("final", args);
      break;
    case "report":
      commandReport(args);
      break;
    default:
      throw new Error(`unknown command: ${args.command}`);
  }
}

// Only run as a CLI when this file is the process entry point — importing it
// (as the test suite does, to exercise `runStage`/`commandReport`/`parseArgs`
// directly against mocked transports) must never trigger `main()` against
// the host process's real argv.
const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);
if (isMainModule) {
  main().catch((error: unknown) => {
    log(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
