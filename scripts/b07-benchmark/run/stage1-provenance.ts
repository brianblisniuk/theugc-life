/**
 * Stage-1 -> Stage-2 finalist provenance validation (round: BLOCKER 1).
 *
 * A REAL Stage-2 ("final") run must be permanently attributable to the exact
 * Stage-1 ("screen") evidence that allowed a candidate to advance. This
 * module is the SINGLE place that decides whether a candidate's Stage-1
 * provenance is trustworthy enough to spend a live provider call on — it is
 * called from two places, deliberately sharing one implementation so they can
 * never silently drift apart:
 *
 *  1. `cli.ts`'s `runStage("final", ...)`, BEFORE any preflight availability
 *     call, BEFORE any main-holdout provider call, and BEFORE any
 *     supplemental-pack provider call — a failure here throws, and the
 *     process never contacts a provider.
 *  2. `cli.ts`'s `emitReport` (used by BOTH a live `final` run's own report
 *     and a later standalone `report --run`), which RE-VALIDATES the
 *     persisted provenance against whatever Stage-1 artifacts currently exist
 *     on disk — round requirement: "a later `report --run` must refuse to
 *     render a qualification if ... its candidate/model/config identity no
 *     longer matches". No provider call happens here either; every check
 *     reads only locally persisted benchmark artifacts (`manifest.json`,
 *     `scores-v2.json`) via `run/artifacts.ts`.
 *
 * NO PROVIDER-LAUNDERING: passing `--from-run` is not itself sufficient. The
 * named run must exist, must be an actual Stage-1 "screen" run, must have
 * scored this exact candidate under the accepted scoring-v2 version, that
 * candidate's Stage-1 status must be a genuine Stage-1 finalist (never
 * eliminated/invalidated/no-evidence), and its exact requested model +
 * effective inference-config digest must match what Stage 2 is about to run.
 * Any mismatch fails closed — never a guess, never a silent proceed.
 *
 * PROVIDER PARITY: nothing here branches on a candidate id or a provider
 * name literal — the identical validation pipeline runs for every future
 * finalist.
 */
import { CORPUS_VERSION } from "../corpus/schema";
import { PROMPT_VERSION } from "../prompt/render";
import { inferenceConfigDigest } from "../config/inference-config";
import { SCORING_VERSION_V2 } from "../scoring/scoring-version";
import type { CandidateScoreV2 } from "../scoring/score-v2";
import { evaluateCandidateV2 } from "../scoring/targets-v2";
import { readJsonArtifact, readManifest } from "./artifacts";
import type { Stage1ProvenanceFacts } from "./types";

export interface Stage1ProvenanceCheckInput {
  /** Raw `--from-run` value, or `null` when the flag was not supplied. */
  fromRunId: string | null;
  /** Raw `--finalist-reason` value, or `null` when the flag was not supplied. */
  finalistReason: string | null;
  candidateId: string;
  /** The EXACT model Stage 2 is about to (or already did) request. */
  requestedModel: string;
  /** `inferenceConfigDigest` of the EXACT effective inference config Stage 2 is about to (or already did) use. */
  inferenceConfigDigest: string;
}

export type Stage1ProvenanceCheckResult =
  { ok: true; facts: Stage1ProvenanceFacts } | { ok: false; reason: string };

interface ScoresV2Artifact {
  scoring_version: string;
  scores: CandidateScoreV2[];
}

/**
 * Validates one candidate's Stage-1 -> Stage-2 provenance against locally
 * persisted benchmark artifacts only. Never calls a provider. Never throws —
 * every failure mode is returned as `{ ok: false, reason }` so BOTH callers
 * (a pre-call gate that throws, and a post-hoc report re-check that degrades
 * a status instead of throwing) can react in their own appropriate way from
 * one shared decision.
 */
export function checkStage1Provenance(
  input: Stage1ProvenanceCheckInput,
): Stage1ProvenanceCheckResult {
  const fromRunId = input.fromRunId?.trim() || null;
  const finalistReason = input.finalistReason?.trim() || null;

  if (!fromRunId) {
    return {
      ok: false,
      reason:
        `--from-run <stage1-run-id> is REQUIRED for a real (non-local) Stage-2 "final" run — ` +
        `candidate "${input.candidateId}" has no stated originating Stage-1 screening run. A real ` +
        `Stage-2 run must be permanently attributable to the Stage-1 evidence that allowed this ` +
        `candidate to advance; --from-run is never optional.`,
    };
  }
  if (!finalistReason) {
    return {
      ok: false,
      reason:
        `--finalist-reason "<reason>" is REQUIRED for EVERY Stage-2 finalist, not only ceiling-role ` +
        `candidates — candidate "${input.candidateId}" has no stated finalist reason.`,
    };
  }

  const manifest = readManifest(fromRunId);
  if (!manifest) {
    return {
      ok: false,
      reason:
        `--from-run "${fromRunId}" does not resolve to any persisted run manifest — refusing to ` +
        `advance candidate "${input.candidateId}" to Stage 2 on unverifiable provenance (no provenance ` +
        `laundering: a bare run-id string is never accepted as evidence on its own).`,
    };
  }
  if (manifest.stage !== "screen") {
    return {
      ok: false,
      reason:
        `--from-run "${fromRunId}" is a "${manifest.stage}" run, not a Stage-1 "screen" run — Stage-2 ` +
        `finalist provenance must trace to an actual Stage-1 screening run, never to a baseline run, a ` +
        `prior "final" run, or any other stage.`,
    };
  }
  if (manifest.corpus_version !== CORPUS_VERSION) {
    return {
      ok: false,
      reason:
        `Stage-1 run "${fromRunId}" was scored under corpus_version "${manifest.corpus_version}", not ` +
        `the current frozen "${CORPUS_VERSION}" — refusing to advance candidate "${input.candidateId}" ` +
        `on a stale/mismatched corpus.`,
    };
  }
  if (manifest.prompt_version !== PROMPT_VERSION) {
    return {
      ok: false,
      reason:
        `Stage-1 run "${fromRunId}" was scored under prompt_version "${manifest.prompt_version}", not ` +
        `the current frozen "${PROMPT_VERSION}" — Stage-2 requires Stage-1 prompt v2 evidence.`,
    };
  }

  const priorV2 = readJsonArtifact<ScoresV2Artifact>(fromRunId, "scores-v2.json");
  if (!priorV2) {
    return {
      ok: false,
      reason:
        `Stage-1 run "${fromRunId}" has no persisted scores-v2.json evidence — refusing to advance ` +
        `candidate "${input.candidateId}" without verifiable Stage-1 scoring-v2 evidence.`,
    };
  }
  if (priorV2.scoring_version !== SCORING_VERSION_V2) {
    return {
      ok: false,
      reason:
        `Stage-1 run "${fromRunId}" scores are stamped scoring_version "${priorV2.scoring_version}", ` +
        `not the accepted "${SCORING_VERSION_V2}" — refusing to advance candidate ` +
        `"${input.candidateId}" on an unaccepted scoring methodology.`,
    };
  }

  const candidateScore = priorV2.scores.find((s) => s.candidate_id === input.candidateId);
  if (!candidateScore) {
    return {
      ok: false,
      reason:
        `Stage-1 run "${fromRunId}" contains no scoring-v2 evidence for candidate ` +
        `"${input.candidateId}" — it was never evaluated in that run.`,
    };
  }
  if (candidateScore.requested_model !== input.requestedModel) {
    return {
      ok: false,
      reason:
        `Stage-1 requested_model ("${candidateScore.requested_model}") does not match the Stage-2 ` +
        `requested_model ("${input.requestedModel}") for candidate "${input.candidateId}" — Stage 2 ` +
        `must advance the EXACT model Stage 1 evaluated.`,
    };
  }

  const stage1Digest = candidateScore.inference_config
    ? inferenceConfigDigest(candidateScore.inference_config)
    : null;
  if (stage1Digest !== input.inferenceConfigDigest) {
    return {
      ok: false,
      reason:
        `Stage-1 inference-config digest ("${stage1Digest ?? "none"}") does not match the Stage-2 ` +
        `effective inference-config digest ("${input.inferenceConfigDigest}") for candidate ` +
        `"${input.candidateId}" — Stage 2 must use the IDENTICAL inference configuration Stage 1 ` +
        `evaluated.`,
    };
  }

  const stage1Eval = evaluateCandidateV2(candidateScore);
  if (!stage1Eval.isStage1Finalist) {
    return {
      ok: false,
      reason:
        `Stage-1 candidate "${input.candidateId}" status is "${stage1Eval.status}" in run ` +
        `"${fromRunId}", not a Stage-1 finalist ("stage1_finalist" or ` +
        `"stage1_finalist_with_unresolved_quality_target") — refusing to advance an eliminated, ` +
        `invalidated, or no-evidence candidate to Stage 2. Reasons: ` +
        `${stage1Eval.eliminationReasons.join("; ") || "n/a"}`,
    };
  }

  const advancementReasons =
    stage1Eval.status === "stage1_finalist_with_unresolved_quality_target"
      ? [
          `Stage-1 finalist with unresolved (insufficient-support, never a failed) quality target(s): ${
            stage1Eval.targets
              .filter((t) => t.state === "insufficient_support")
              .map((t) => t.label)
              .join(", ") || "none named"
          }`,
        ]
      : [
          "Stage-1 finalist: zero critical invariant violations, every statistically evaluable quality target passed",
        ];

  return {
    ok: true,
    facts: {
      stage1_run_id: fromRunId,
      stage1_candidate_id: input.candidateId,
      stage1_scoring_version: candidateScore.scoring_version,
      stage1_status: stage1Eval.status,
      stage1_advancement_reasons: advancementReasons,
      requested_model: candidateScore.requested_model,
      inference_config_digest: stage1Digest,
      corpus_version: manifest.corpus_version,
      prompt_version: manifest.prompt_version,
    },
  };
}

export class Stage1ProvenanceError extends Error {}

/** Pre-call gate: throws (never returns) on a failed check — used by `runStage`. */
export function assertStage1Provenance(input: Stage1ProvenanceCheckInput): Stage1ProvenanceFacts {
  const result = checkStage1Provenance(input);
  if (!result.ok) {
    throw new Stage1ProvenanceError(`STAGE2_PROVENANCE_REJECTED: ${result.reason}`);
  }
  return result.facts;
}
