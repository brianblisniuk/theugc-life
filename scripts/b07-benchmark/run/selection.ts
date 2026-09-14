/**
 * Case-selection identity — the fix for "run manifest cannot reconstruct
 * exact selection" (external audit finding 3).
 *
 * A run manifest used to record only `split`, so a `--critical-only` run's
 * manifest was indistinguishable from a full-split run of the same split; a
 * later `report --run` reconstructed cases from `split` alone and would
 * silently score the run as though it had selected the full split. This
 * module makes the persisted selection the SOURCE OF TRUTH for a later
 * report: the exact case ids actually selected, plus a tamper-evident digest,
 * are what `report --run` replays — never a recomputation from `split` +
 * flags that the manifest might not have recorded.
 */
import { getCase, selectCases } from "../corpus/load";
import type { CorpusCase } from "../corpus/schema";
import type { BenchmarkTask, CorpusSplit } from "../taxonomy";
import { caseSetDigest } from "./digest";
import type { RunManifest, RunSelectionMeta } from "./types";

export interface SelectionRequest {
  split: CorpusSplit | "all";
  criticalOnly: boolean;
  task?: BenchmarkTask;
}

export interface ResolvedSelection {
  meta: RunSelectionMeta;
  cases: CorpusCase[];
  caseIds: string[];
  digest: string;
}

/** Compute a selection NOW, from the corpus, and its identity. */
export function resolveSelection(request: SelectionRequest): ResolvedSelection {
  const cases = selectCases({
    split: request.split === "all" ? undefined : request.split,
    criticalOnly: request.criticalOnly,
    task: request.task,
  });
  const caseIds = cases.map((c) => c.case_id);
  return {
    meta: {
      split: request.split,
      task: request.task ?? null,
      critical_only: request.criticalOnly,
      include_few_shot: false,
    },
    cases,
    caseIds,
    digest: caseSetDigest(caseIds),
  };
}

export class SelectionMismatchError extends Error {}

/**
 * Reconstruct the EXACT scored case set of a persisted run, from the
 * manifest's own recorded case ids — never by recomputing from `split` +
 * flags, which is precisely the defect this module fixes. Refuses (rather
 * than silently substituting a different set) when the corpus can no longer
 * produce one of the recorded ids, or when the manifest's own digest does not
 * match its own recorded ids (tamper/corruption evidence).
 */
export function reconstructSelection(manifest: RunManifest): CorpusCase[] {
  const recomputedDigest = caseSetDigest(manifest.selected_case_ids);
  if (recomputedDigest !== manifest.case_set_digest) {
    throw new SelectionMismatchError(
      `run ${manifest.run_id}: selected_case_ids does not match its own case_set_digest (recorded ${manifest.case_set_digest}, recomputed ${recomputedDigest}); refusing to reinterpret this run under a different selection`,
    );
  }
  const cases: CorpusCase[] = [];
  const missing: string[] = [];
  for (const id of manifest.selected_case_ids) {
    const found = getCase(id);
    if (!found) missing.push(id);
    else cases.push(found);
  }
  if (missing.length > 0) {
    throw new SelectionMismatchError(
      `run ${manifest.run_id}: ${missing.length} selected case id(s) no longer exist in corpus ${manifest.corpus_version}: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""}`,
    );
  }
  return cases;
}
