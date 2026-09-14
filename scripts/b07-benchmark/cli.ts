#!/usr/bin/env tsx
/**
 * B07 inference benchmark CLI.
 *
 *   tsx scripts/b07-benchmark/cli.ts status
 *   tsx scripts/b07-benchmark/cli.ts preflight [--split holdout|dev|all]
 *   tsx scripts/b07-benchmark/cli.ts baseline
 *   tsx scripts/b07-benchmark/cli.ts screen  [--candidate id]... [--dry-run]
 *   tsx scripts/b07-benchmark/cli.ts final   --candidate id --from-run <stage1-run-id> --finalist-reason "<reason>" [--dry-run]
 *   tsx scripts/b07-benchmark/cli.ts report  --run <run-id>
 *
 *   tsx scripts/b07-benchmark/cli.ts promptv3-diagnostic --candidate <id> --against holdout        --run <id> [--dry-run]
 *   tsx scripts/b07-benchmark/cli.ts promptv3-diagnostic --candidate <id> --against generalization --run <id> [--dry-run]
 *
 * `promptv3-diagnostic` (PR #40 prompt-v3 instruction-quality experiment) is
 * NOT a Stage-1/Stage-2 qualification path — it never touches
 * `evaluateStage2Final`/Stage-1 provenance machinery, writes to its OWN
 * run-id-scoped artifact files (`promptv3-diagnostic-*.jsonl`/`.json`, never
 * `results.jsonl`/`supplemental-results.jsonl`/`scores*.json`), and is
 * clearly labelled `POSTHOC_PROMPT_DIAGNOSTIC` (against holdout) or a genuine
 * blind test (against generalization) in every log line and manifest field.
 * See `run/promptv3-diagnostic-runner.ts`, `scoring/promptv3-comparator.ts`,
 * `scoring/promptv3-generalization-score.ts` and
 * `scoring/promptv3-interpretation.ts` for the tooling this drives.
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
import {
  INFERENCE_POLICY_VERSION,
  effectiveInferenceConfig,
  inferenceConfigDigest,
} from "./config/inference-config";
import { CORPUS_VERSION, corpusStats, taxonomyCoverage } from "./corpus/load";
import type { CorpusCase } from "./corpus/schema";
import { supplementalPackManifest } from "./corpus/supplemental-ambiguity-pack";
import { PROMPT_VERSION } from "./prompt/render";
import { PROMPT_VERSION_V3 } from "./prompt/render-v3";
import {
  PROMPT_V3_DIAGNOSTIC_LABEL,
  runGeneralizationUnderPromptV3,
  runHoldoutUnderPromptV3,
  runSupplementalUnderPromptV3,
} from "./run/promptv3-diagnostic-runner";
import { generalizationPackManifest } from "./corpus/prompt-v3-generalization-challenge";
import { VENDOR_SCREEN, VENDOR_SCREEN_STANDING_CONCLUSION } from "./privacy/vendor-screen";
import { renderReport } from "./report/render";
import { renderReportV2 } from "./report/render-v2";
import { B07_BENCHMARK_SCHEMA_VERSION } from "./schema";
import { scoreCandidate, type CandidateScore } from "./scoring/score";
import { scoreCandidateV2, type CandidateScoreV2 } from "./scoring/score-v2";
import { scoreSupplementalPack, type SupplementalScore } from "./scoring/score-supplemental";
import {
  evaluateStage2Final,
  renderStage2Status,
  type Stage2Evaluation,
} from "./scoring/stage2-final";
import { decide } from "./scoring/targets";
import {
  checkHoldoutCanResolve,
  evaluateCandidateV2,
  holdoutSupportPreflight,
} from "./scoring/targets-v2";
import { SCORING_VERSION_V1, SCORING_VERSION_V2 } from "./scoring/scoring-version";
import {
  readJsonArtifact,
  readManifest,
  readResults,
  readSupplementalResults,
  writeJson,
  writeText,
} from "./run/artifacts";
import { resolveSelection, reconstructSelection } from "./run/selection";
import { MAX_OUTPUT_TOKENS, newRunId, runCandidate } from "./run/runner";
import { runSupplementalPack, SupplementalPackDriftError } from "./run/supplemental-runner";
import { assertStage1Provenance, checkStage1Provenance } from "./run/stage1-provenance";
import type {
  CaseResult,
  FinalistProvenance,
  RunManifest,
  Stage1ProvenanceFacts,
  SupplementalCaseResult,
} from "./run/types";
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
  /** `promptv3-diagnostic` only: which frozen evidence source to run prompt v3 against. */
  against: "holdout" | "generalization" | null;
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
    against: null,
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
      case "--against": {
        const value = next();
        if (value !== "holdout" && value !== "generalization") {
          throw new Error(`--against must be "holdout" or "generalization", got "${value}"`);
        }
        args.against = value;
        break;
      }
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

  // FIXED (this round, BLOCKER 2 — "final can spend against the wrong
  // selection"): a REAL Stage-2 `final` run must use EXACTLY the full frozen
  // 120-case holdout. `--split dev`, `--split all`, `--critical-only`, or any
  // other operator override of the semantic selection is refused HERE, before
  // candidates are even resolved, before the preflight support-arithmetic
  // check, before any provider availability call, and before any main or
  // supplemental provider inference. The full-holdout digest is recomputed
  // fresh from the corpus every time (`resolveSelection`) rather than trusted
  // from a constant, so a corpus edit can never silently widen or narrow what
  // "the full holdout" means without also changing this digest.
  const fullHoldoutSelection =
    stage === "final" ? resolveSelection({ split: "holdout", criticalOnly: false }) : null;
  if (fullHoldoutSelection) {
    const wrongSplit = selection.meta.split !== "holdout";
    const wrongCriticalOnly = selection.meta.critical_only !== false;
    const wrongDigest = selection.digest !== fullHoldoutSelection.digest;
    if (wrongSplit || wrongCriticalOnly || wrongDigest) {
      throw new Error(
        `STAGE2_WRONG_SELECTION: a real Stage-2 "final" run must select EXACTLY the full frozen ` +
          `${fullHoldoutSelection.cases.length}-case holdout (split=holdout, critical-only=false, ` +
          `case-set digest ${fullHoldoutSelection.digest}) — got split="${selection.meta.split}", ` +
          `critical-only=${selection.meta.critical_only}, case-set digest ${selection.digest} ` +
          `(${selection.caseIds.length} case(s)). Stage 2 never permits an operator override of which ` +
          `cases are in scope. FAIL BEFORE ANY PROVIDER CALL — no availability check, no main-holdout ` +
          `inference, and no supplemental-pack inference happened.`,
      );
    }
  }

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

  // FIXED (this round, BLOCKER 1 — "Stage-2 finalist provenance is
  // optional"): for EVERY non-local `final` candidate, `--from-run
  // <stage1-run-id>` and `--finalist-reason "<reason>"` are now REQUIRED
  // (never only for a ceiling-role candidate — no candidate is special-cased),
  // and the named Stage-1 run is fully validated — manifest exists, stage is
  // `screen`, corpus/prompt/scoring versions match the current accepted
  // ones, the candidate's own Stage-1 evidence exists and is a genuine
  // Stage-1 finalist (never eliminated/invalidated/no-evidence), and its
  // exact requested model + effective inference-config digest match what
  // Stage 2 is about to run — ALL BEFORE any provider is contacted. A local
  // candidate (the deterministic baseline) never requires provenance: it
  // makes no provider call and was never a Stage-1 screening participant.
  const validatedStage1: Record<string, Stage1ProvenanceFacts> = {};
  if (stage === "final") {
    for (const candidate of candidates) {
      if (candidate.providerId === "local") continue;
      const resolvedModel = resolveModel(candidate);
      const candidateInferenceConfig = effectiveInferenceConfig(
        { providerId: candidate.providerId, model: resolvedModel },
        MAX_OUTPUT_TOKENS,
      );
      const facts = assertStage1Provenance({
        fromRunId: args.fromRun,
        finalistReason: args.finalistReason,
        candidateId: candidate.id,
        requestedModel: resolvedModel,
        inferenceConfigDigest: inferenceConfigDigest(candidateInferenceConfig),
      });
      validatedStage1[candidate.id] = facts;
    }
  }

  // STAGE-2 HOLDOUT-SUPPORT PREFLIGHT (locked contract, this correction
  // round, NOT exercised — no holdout call is made this round) — runs BEFORE
  // the provider loop below and BEFORE any candidate is contacted: label
  // support is calculated ONLY from the frozen holdout gold corpus
  // (`holdoutSupportPreflight` takes `CorpusCase[]` only — there is no
  // model-output parameter for a prediction to travel through, so it
  // performs ZERO provider calls). Gated on at least one selected candidate
  // actually being callable (an API key present) — a `final` invocation with
  // no key for any candidate makes no provider call regardless, exactly like
  // every other stage, so the preflight has nothing to protect there. If
  // `--from-run` names the Stage-1 screening run, its own scoring-v2
  // evaluation is read to find exactly which quality targets it left
  // `insufficient_support`; without `--from-run` this defaults conservatively
  // to checking every support-sensitive target (disposition macro F1, signal
  // micro F1). Any target the holdout cannot resolve stops the run before any
  // provider is contacted — never a silent proceed.
  //
  // PREFLIGHT V2 (Stage-2 statistical closure round): `holdoutSupportPreflight`
  // now inspects the frozen 120-case main holdout PLUS the frozen
  // `b07_disposition_ambiguity_support_v1` supplemental pack (loaded by its
  // own default parameter below — no argument needed here, and no provider
  // call happens either way: this function's only parameters are corpus/pack
  // metadata). Disposition macro F1 is evaluated against the SUPPORT-
  // COMPLETED strict set (main holdout + the 6 supplemental cases); signal
  // micro F1 continues to use the main holdout alone, under the corrected
  // "non-empty strict evaluable set" sufficiency rule (see `targets-v2.ts`).
  if (
    stage === "final" &&
    candidates.some((c) => c.providerId !== "local" && hasApiKey(c.providerId))
  ) {
    const preflight = holdoutSupportPreflight(cases);
    let unresolvedKeys: string[] = ["disposition_macro_f1", "signal_micro_f1"];
    if (args.fromRun) {
      const priorV2 = readJsonArtifact<{ scores: CandidateScoreV2[] }>(
        args.fromRun,
        "scores-v2.json",
      );
      if (priorV2) {
        const keys = new Set<string>();
        for (const s of priorV2.scores) {
          for (const t of evaluateCandidateV2(s).targets) {
            if (t.state === "insufficient_support") keys.add(t.key);
          }
        }
        unresolvedKeys = [...keys];
      }
    }
    const check = checkHoldoutCanResolve(preflight, unresolvedKeys);
    log(
      `preflight v2 (metadata only, zero provider calls): pack=${preflight.supplemental_pack.pack_version} digest=${preflight.supplemental_pack.digest} disposition_support_completed=${JSON.stringify(preflight.disposition_support_completed)} signals_strict_n=${preflight.signals_strict_n} signals_strict_label_decisions=${preflight.signals_strict_label_decisions} resolvable=${JSON.stringify(preflight.resolvable)}`,
    );
    if (!check.canResolve) {
      throw new Error(
        `HOLDOUT_INSUFFICIENT_TO_RESOLVE_TARGET: the frozen holdout corpus (combined with the frozen supplemental_ambiguity_support pack ${preflight.supplemental_pack.pack_version}) lacks sufficient strict gold support to resolve: ${check.blockingTargets.join(", ")} (disposition insufficient classes, support-completed: ${preflight.disposition_insufficient_classes.join(", ") || "none"}; signal strict n=${preflight.signals_strict_n}, strict label decisions=${preflight.signals_strict_label_decisions}; low/zero-strict-support signal labels reported as taxonomy-coverage limitations, not a block: low=${preflight.signals_low_support_labels.join(", ") || "none"}, zero=${preflight.signals_zero_strict_support_labels.join(", ") || "none"}). STOP BEFORE ANY PROVIDER CALL — no candidate was contacted. A NEW, separately-frozen and separately-versioned supplemental pack would be required to resolve this further; do not invent one without explicit product sign-off.`,
      );
    }
  }

  const finalistProvenance: FinalistProvenance | null =
    stage === "final"
      ? {
          screen_run_id: args.fromRun,
          finalist_reason: args.finalistReason,
          candidate_roles: Object.fromEntries(candidates.map((c) => [c.id, c.role])),
          validated_stage1: Object.keys(validatedStage1).length > 0 ? validatedStage1 : null,
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
  const allSupplementalResults: SupplementalCaseResult[] = [];
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

    // STAGE-2 SOURCE B — the fix for the round's blocker: `final` now ALSO
    // sends the SAME finalist/model against the frozen 6-case supplemental
    // ambiguity pack, using the SAME prompt v2 / schema / provider adapter /
    // bounded retry policy as the main holdout above. This is a SEPARATE
    // execution and a SEPARATE artifact stream
    // (`supplemental-results.jsonl`, never `results.jsonl`) — it never adds
    // to `cases.length`, never becomes part of the 120-case main-holdout
    // selection, and runs for EVERY stage (not only "final") only when
    // `stage === "final"`, since baseline/screen never need Stage-2 support
    // closure.
    if (stage === "final") {
      const supplementalOutcome = await runSupplementalPack({
        runId,
        candidate,
        concurrency: args.concurrency,
        maxSchemaRetries: args.maxSchemaRetries,
        dryRun: args.dryRun,
        resume: args.resume,
        log,
      });
      allSupplementalResults.push(...supplementalOutcome.results);
      log(
        `  ${candidate.id.padEnd(28)} [supplemental pack ${supplementalOutcome.packVersion}] availability=${supplementalOutcome.availability} results=${supplementalOutcome.results.length}/6 reused=${supplementalOutcome.reusedFromResume}`,
      );
    }
  }

  if (stage === "final") {
    writeJson(runId, "supplemental-manifest.json", supplementalPackManifest());
  }

  manifest.finished_at = new Date().toISOString();
  writeJson(runId, "manifest.json", manifest);

  // The full frozen main holdout's OWN size, independent of what selection
  // this particular invocation actually ran — Stage-2 completeness must be
  // judged against the whole 120-case holdout, never against whatever subset
  // a `final` invocation happened to select. (Reuses `fullHoldoutSelection`,
  // already computed above by the BLOCKER 2 selection-lock check, which by
  // construction is now always exactly what `selection` itself is for a
  // `final` run — recomputing it again here would be redundant, not a
  // different check.)
  const mainHoldoutFullSize = fullHoldoutSelection ? fullHoldoutSelection.cases.length : null;

  emitReport(
    runId,
    stage,
    cases,
    allResults,
    finalistProvenance,
    stage === "final" ? allSupplementalResults : [],
    mainHoldoutFullSize,
    { split: manifest.selection.split, case_set_digest: manifest.case_set_digest },
  );
}

function emitReport(
  runId: string,
  stage: string,
  cases: readonly CorpusCase[],
  results: readonly CaseResult[],
  finalistProvenance: FinalistProvenance | null = null,
  supplementalResults: readonly SupplementalCaseResult[] = [],
  mainHoldoutFullSize: number | null = null,
  mainSelectionMeta: { split: CorpusSplit | "all"; case_set_digest: string } | null = null,
): void {
  const byCandidate = new Map<string, CaseResult[]>();
  for (const result of results) {
    const bucket = byCandidate.get(result.candidate_id) ?? [];
    bucket.push(result);
    byCandidate.set(result.candidate_id, bucket);
  }
  const supplementalByCandidate = new Map<string, SupplementalCaseResult[]>();
  for (const result of supplementalResults) {
    const bucket = supplementalByCandidate.get(result.candidate_id) ?? [];
    bucket.push(result);
    supplementalByCandidate.set(result.candidate_id, bucket);
  }

  const scores: CandidateScore[] = [];
  const scoresV2: CandidateScoreV2[] = [];
  const supplementalScores: SupplementalScore[] = [];
  const stage2Evaluations: Stage2Evaluation[] = [];
  const absences: { candidate_id: string; model: string; reason: string }[] = [];

  for (const [candidateId, candidateResults] of byCandidate) {
    const candidate = candidateById(candidateId);
    const model = candidateResults[0]?.requested_model ?? candidate?.model ?? "unknown";
    const providerId = candidateResults[0]?.provider_id ?? candidate?.providerId ?? "local";
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
    const scoreInput = {
      candidateId,
      providerId,
      requestedModel: model,
      corpusVersion: CORPUS_VERSION,
      promptVersion: PROMPT_VERSION,
      schemaVersion: B07_BENCHMARK_SCHEMA_VERSION,
      cases,
      results: candidateResults,
      priceBook: priceBookFor(candidateId),
    };
    // Scoring is a downstream interpretation of the SAME raw evidence — v1
    // (preserved, unchanged) and v2 (the correction) are both computed from
    // one identical `scoreInput`, never two different result sets.
    scores.push(scoreCandidate(scoreInput));
    const mainScoreV2 = scoreCandidateV2(scoreInput);
    scoresV2.push(mainScoreV2);

    // STAGE-2 SOURCE B scoring + FINAL DECISION — only for `final`, and only
    // when this candidate actually has supplemental evidence at all (a
    // `final` run of a candidate with no supplemental rows at all is still
    // scored below via `scoreSupplementalPack`'s own empty-report path, so
    // "supplemental never ran" is a computed `incomplete` verdict, never a
    // silently absent one).
    if (stage === "final" && mainHoldoutFullSize !== null) {
      const supplementalScore = scoreSupplementalPack({
        candidateId,
        providerId,
        requestedModel: model,
        results: supplementalByCandidate.get(candidateId) ?? [],
        priceBook: priceBookFor(candidateId),
      });
      supplementalScores.push(supplementalScore);

      let stage2Eval = evaluateStage2Final({
        candidateId,
        mainManifest: {
          split: mainSelectionMeta?.split ?? "holdout",
          case_set_digest: mainSelectionMeta?.case_set_digest ?? "",
          selected_case_count: cases.length,
          expected_full_holdout_count: mainHoldoutFullSize,
        },
        mainScore: mainScoreV2,
        supplementalScore,
        finalistProvenance,
      });

      // FINALIST PROVENANCE IDENTITY (this round) — re-validated EVERY time a
      // Stage-2 verdict is rendered (a fresh `final` run's own report, AND a
      // later standalone `report --run`), against WHATEVER Stage-1 artifacts
      // are currently persisted on disk — never trusted from the cached
      // `finalist_provenance.validated_stage1` snapshot alone. This is what
      // makes `report --run` refuse to render a qualification when the
      // persisted Stage-1 run id is missing, when the originating Stage-1
      // artifact can no longer be found, or when its candidate/model/config
      // identity no longer matches this Stage-2 manifest (e.g. the Stage-1
      // run was deleted, or its scores-v2.json was hand-edited after this
      // Stage-2 run first executed). Reads locally persisted artifacts only —
      // zero provider calls. A local candidate never required provenance and
      // is never re-checked here either.
      if (providerId !== "local") {
        const revalidated = checkStage1Provenance({
          fromRunId: finalistProvenance?.screen_run_id ?? null,
          finalistReason: finalistProvenance?.finalist_reason ?? null,
          candidateId,
          requestedModel: model,
          inferenceConfigDigest: mainScoreV2.inference_config
            ? inferenceConfigDigest(mainScoreV2.inference_config)
            : "",
        });
        if (!revalidated.ok) {
          stage2Eval = {
            ...stage2Eval,
            status: "blocked_identity_invalid",
            isQualified: false,
            reasons: [
              `STAGE2_PROVENANCE_NO_LONGER_VALID (re-checked against currently persisted Stage-1 artifacts): ${revalidated.reason}`,
              ...stage2Eval.reasons,
            ],
          };
        }
      }
      stage2Evaluations.push(stage2Eval);
    }
  }

  scores.sort((a, b) => a.candidate_id.localeCompare(b.candidate_id));
  scoresV2.sort((a, b) => a.candidate_id.localeCompare(b.candidate_id));
  supplementalScores.sort((a, b) => a.candidate_id.localeCompare(b.candidate_id));
  stage2Evaluations.sort((a, b) => a.candidate_id.localeCompare(b.candidate_id));

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
  const markdownV2 = renderReportV2({
    runId,
    stage,
    generatedAt: new Date().toISOString(),
    corpus: corpusStats(),
    scores: scoresV2,
    absences,
  });

  const reportPath = writeText(runId, "report.md", markdown);
  // `scoring_version` is stamped at the wrapper level so a v1 score artifact
  // can never be silently read as v2 evidence — v1's own `CandidateScore`
  // additionally carries the same stamp per-candidate (see `scoring/score.ts`).
  const scoresPath = writeJson(runId, "scores.json", {
    scoring_version: SCORING_VERSION_V1,
    scores,
    absences,
    decision,
  });
  const reportV2Path = writeText(runId, "report-v2.md", markdownV2);
  const scoresV2Path = writeJson(runId, "scores-v2.json", {
    scoring_version: SCORING_VERSION_V2,
    scores: scoresV2,
    absences,
  });

  log("");
  log(markdown);
  log(`report  : ${reportPath}`);
  log(`scores  : ${scoresPath}`);
  log(`report (scoring v2) : ${reportV2Path}`);
  log(`scores (scoring v2) : ${scoresV2Path}`);
  log("");
  log(`DECISION: ${decision.outcome}`);
  for (const reason of decision.reasons) log(`  - ${reason}`);

  if (stage === "final" && mainHoldoutFullSize !== null) {
    const supplementalScoresPath = writeJson(runId, "supplemental-scores.json", {
      supplemental_pack: supplementalPackManifest(),
      scores: supplementalScores,
    });
    const stage2Path = writeJson(runId, "stage2-evaluations.json", stage2Evaluations);
    log("");
    log(`supplemental scores : ${supplementalScoresPath}`);
    log(`stage-2 evaluations : ${stage2Path}`);
    log("");
    log(
      "STAGE-2 STATUS (never a production-vendor winner — see docs/B07_INFERENCE_BENCHMARK_SPEC.md):",
    );
    for (const evaluation of stage2Evaluations) {
      log(`  ${evaluation.candidate_id.padEnd(28)} ${renderStage2Status(evaluation)}`);
      for (const reason of evaluation.reasons) log(`      - ${reason}`);
    }
  }
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

  let supplementalResults: SupplementalCaseResult[] = [];
  let mainHoldoutFullSize: number | null = null;
  if (manifest.stage === "final") {
    supplementalResults = readSupplementalResults(args.runId);
    // PACK DRIFT REFUSAL (round attack case): a stored supplemental row
    // computed against the SAME `pack_version` but a DIFFERENT digest than
    // the pack currently on disk must refuse the report, not silently
    // render a mixed-provenance Stage-2 verdict.
    const currentPack = supplementalPackManifest();
    const drifted = supplementalResults.filter(
      (r) => r.pack_version === currentPack.pack_version && r.pack_digest !== currentPack.digest,
    );
    if (drifted.length > 0) {
      throw new SupplementalPackDriftError(
        `SUPPLEMENTAL_PACK_DRIFT_DETECTED: run ${args.runId} stored ${drifted.length} supplemental result(s) computed against pack "${currentPack.pack_version}" with a digest that does not match the pack currently on disk (${currentPack.digest}). Refusing to report a Stage-2 verdict from this evidence.`,
      );
    }
    mainHoldoutFullSize = resolveSelection({ split: "holdout", criticalOnly: false }).cases.length;
  }

  emitReport(
    args.runId,
    manifest.stage,
    cases,
    readResults(args.runId),
    manifest.finalist_provenance,
    supplementalResults,
    mainHoldoutFullSize,
    { split: manifest.selection.split, case_set_digest: manifest.case_set_digest },
  );
}

/**
 * `preflight` — standalone Stage-2 preflight v2 inspection, zero provider
 * calls (this command takes no `--candidate`, calls no provider transport,
 * and `holdoutSupportPreflight` itself has no parameter through which a
 * provider/model could be invoked). Prints the combined main-holdout +
 * frozen-supplemental-pack support arithmetic so it can be verified by a
 * human, or by CI, without ever running Stage 1 or Stage 2.
 */
function commandPreflight(args: Args): void {
  const split: CorpusSplit | "all" = args.split ?? "holdout";
  const selection = resolveSelection({ split, criticalOnly: args.criticalOnly });
  const preflight = holdoutSupportPreflight(selection.cases);

  log("B07 Stage-2 preflight v2 (metadata only — ZERO provider calls)");
  log("");
  log(`corpus version : ${CORPUS_VERSION}`);
  log(`main holdout   : n_message=${preflight.n_message} n_thread=${preflight.n_thread}`);
  log("");
  log("supplemental_ambiguity_support pack:");
  log(`  pack_version : ${preflight.supplemental_pack.pack_version}`);
  log(`  digest       : ${preflight.supplemental_pack.digest}`);
  log(`  created_at   : ${preflight.supplemental_pack.created_at}`);
  log(`  declaration  : ${preflight.supplemental_pack.declaration}`);
  log(`  case_ids     : ${preflight.supplemental_pack.case_ids.join(", ")}`);
  log(`  languages    : ${JSON.stringify(preflight.supplemental_pack.language_distribution)}`);
  log(`  strict_support (own): ${JSON.stringify(preflight.supplemental_pack.strict_support)}`);
  log("");
  log("disposition — main_holdout strict support:");
  log(`  ${JSON.stringify(preflight.disposition_strict_support)}`);
  log(
    "disposition — SUPPORT-COMPLETED strict support (main_holdout + supplemental_ambiguity_support):",
  );
  log(`  ${JSON.stringify(preflight.disposition_support_completed)}`);
  log(`  insufficient classes: ${preflight.disposition_insufficient_classes.join(", ") || "none"}`);
  log("");
  log("signals — main_holdout ONLY (never touched by the supplemental pack):");
  log(
    `  strict n=${preflight.signals_strict_n} strict label decisions=${preflight.signals_strict_label_decisions}`,
  );
  log(`  strict per-label support: ${JSON.stringify(preflight.signals_strict_support)}`);
  log(
    `  low-support labels (< MIN_RELIABLE_CLASS_SUPPORT, descriptive only): ${preflight.signals_low_support_labels.join(", ") || "none"}`,
  );
  log(
    `  zero-strict-support labels (descriptive only): ${preflight.signals_zero_strict_support_labels.join(", ") || "none"}`,
  );
  log("");
  log(`resolvable: ${JSON.stringify(preflight.resolvable)}`);
  log("");
  const allResolvable = Object.values(preflight.resolvable).every(Boolean);
  log(
    allResolvable
      ? "RESULT: a future Stage-1 finalist CAN enter Stage 2 without an unresolved statistical-support blocker on disposition macro F1 or signal micro F1."
      : "RESULT: BLOCKED — at least one quality target still lacks sufficient strict evidence. Zero provider calls were made.",
  );
}

/**
 * `promptv3-diagnostic` — PR #40 prompt-v3 instruction-quality experiment
 * runner. NEVER a Stage-1/Stage-2 qualification path: it never calls
 * `runStage`, `evaluateStage2Final`, or any `run/stage1-provenance.ts`
 * function, and it writes exclusively to its own `promptv3-diagnostic-*`
 * artifact files (see `run/promptv3-diagnostic-runner.ts`). Phase 1 (this
 * round) never invokes this against a live provider; it exists so Phase 2
 * (a live Anthropic key) can run Experiment 1 (`--against holdout`) and
 * Experiment 2 (`--against generalization`) with a single command each.
 */
async function commandPromptV3Diagnostic(args: Args): Promise<void> {
  if (args.candidates.length !== 1) {
    throw new Error(
      "promptv3-diagnostic requires exactly one --candidate <id> (e.g. --candidate anthropic-sonnet-5). Run it once per candidate rather than combining candidates in one invocation.",
    );
  }
  if (!args.against) {
    throw new Error("promptv3-diagnostic requires --against holdout|generalization");
  }
  const candidate = candidateById(args.candidates[0] ?? "");
  if (!candidate) throw new Error(`unknown candidate: ${args.candidates[0]}`);

  const runId = args.runId ?? newRunId(`promptv3-diagnostic-${args.against}`);
  log(`${PROMPT_V3_DIAGNOSTIC_LABEL} — promptv3-diagnostic`);
  log(`run id      : ${runId}`);
  log(
    `against     : ${args.against}${args.against === "holdout" ? " (POSTHOC — evidence already opened under prompt v2; this is an A/B comparison, NOT a new blind test)" : " (NEW blind evidence — never seen under prompt v2)"}`,
  );
  log(`candidate   : ${candidate.id}`);
  log(
    `prompt      : ${PROMPT_VERSION_V3} (v2 ${PROMPT_VERSION} is UNCHANGED and remains the historical Stage-2 record)`,
  );
  log(`dry run     : ${args.dryRun}`);
  log("");

  const runnerOptions = {
    runId,
    candidate,
    concurrency: args.concurrency,
    maxSchemaRetries: args.maxSchemaRetries,
    dryRun: args.dryRun,
    resume: args.resume,
    log,
  };

  if (args.against === "holdout") {
    const holdoutOutcome = await runHoldoutUnderPromptV3(runnerOptions);
    log(
      `  main holdout (120)     availability=${holdoutOutcome.availability} results=${holdoutOutcome.results.length}/${holdoutOutcome.caseCount} reused=${holdoutOutcome.reusedFromResume}`,
    );
    const supplementalOutcome = await runSupplementalUnderPromptV3(runnerOptions);
    log(
      `  supplemental pack (6)  availability=${supplementalOutcome.availability} results=${supplementalOutcome.results.length}/6 reused=${supplementalOutcome.reusedFromResume}`,
    );
    writeJson(runId, "promptv3-diagnostic-manifest.json", {
      label: PROMPT_V3_DIAGNOSTIC_LABEL,
      against: "holdout",
      run_id: runId,
      candidate_id: candidate.id,
      prompt_version: PROMPT_VERSION_V3,
      corpus_version: CORPUS_VERSION,
      schema_version: B07_BENCHMARK_SCHEMA_VERSION,
      main_holdout_case_count: holdoutOutcome.caseCount,
      main_holdout_availability: holdoutOutcome.availability,
      supplemental_pack_manifest: supplementalPackManifest(),
      supplemental_availability: supplementalOutcome.availability,
      generated_at: new Date().toISOString(),
    });
    log("");
    log(
      `Next: run scoring/promptv3-comparator.ts's comparePromptV2AndV3OnHoldout() with this run's ` +
        `promptv3-diagnostic-results.jsonl / promptv3-diagnostic-supplemental-results.jsonl as the v3 ` +
        `evidence, and the frozen v2 stage2-sonnet5-blind-20260914 results as the v2 evidence.`,
    );
  } else {
    const generalizationOutcome = await runGeneralizationUnderPromptV3(runnerOptions);
    log(
      `  generalization challenge (36) availability=${generalizationOutcome.availability} results=${generalizationOutcome.results.length}/36 reused=${generalizationOutcome.reusedFromResume}`,
    );
    writeJson(runId, "promptv3-diagnostic-manifest.json", {
      label: "BLIND_GENERALIZATION_CHALLENGE_NOT_POSTHOC",
      against: "generalization",
      run_id: runId,
      candidate_id: candidate.id,
      prompt_version: PROMPT_VERSION_V3,
      schema_version: B07_BENCHMARK_SCHEMA_VERSION,
      generalization_pack_manifest: generalizationPackManifest(),
      generalization_availability: generalizationOutcome.availability,
      generated_at: new Date().toISOString(),
    });
    log("");
    log(
      "Next: run scoring/promptv3-generalization-score.ts's scorePromptV3Generalization() with this run's " +
        "promptv3-diagnostic-generalization-results.jsonl.",
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "status":
      commandStatus();
      break;
    case "preflight":
      commandPreflight(args);
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
    case "promptv3-diagnostic":
      await commandPromptV3Diagnostic(args);
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
