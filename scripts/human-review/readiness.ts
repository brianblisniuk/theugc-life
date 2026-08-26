/**
 * A04.5 HUMAN-REVIEW-READY — the one canonical readiness predicate.
 *
 * An identity is ready for human pre-publication review when every condition
 * D062 can settle WITHOUT a human already passes, and none of them fails.
 *
 * Conditions 1, 2 and 5 are deliberately not inputs. 1 and 2 are the
 * human-review-dependent conditions this whole block exists to satisfy, and 5
 * derives from 1/2/3/4/6/7/11 — so requiring 5 to pass before review would be
 * requiring the answer before the question.
 *
 * THE PREDICATE READS REAL A04 RESULTS. It is never re-derived in SQL. A
 * SQL-only derivation reproduced condition 11's persisted-candidate half but not
 * its live anomaly half, and called 1,141 identities ready where the evaluator
 * says 867 — 274 of which A04 is actively holding on entity-resolution grounds.
 */
import type { Client } from "pg";

import {
  composeAllPreviewResultsInCallerTransaction,
  inPreviewSnapshot,
} from "../prepublication-preview/preview";
import type {
  ConditionResult,
  PreviewResult,
  PreviewStatus,
} from "../prepublication-preview/evaluate";

/** Everything D062 can settle from provider evidence plus machine resolution. */
export const NON_REVIEW_CONDITIONS = [3, 4, 6, 7, 8, 9, 10, 11] as const;

/** The ones only a human can settle (1, 2) and the one derived from them (5). */
export const REVIEW_DEPENDENT_CONDITIONS = [1, 2, 5] as const;

export interface ReadinessVerdict {
  ready: boolean;
  /** Non-review conditions that are not PASS, in ascending order. */
  blocking: Array<{ number: number; name: string; status: PreviewStatus; reason: string }>;
}

const byNumber = (result: PreviewResult, n: number): ConditionResult | undefined =>
  result.conditions.find((c) => c.number === n);

/**
 * Pure. Takes a real A04 result and answers only "could a human review decide
 * this today?" — never "should this be published".
 */
export function readinessOf(result: PreviewResult): ReadinessVerdict {
  const blocking: ReadinessVerdict["blocking"] = [];
  for (const n of NON_REVIEW_CONDITIONS) {
    const c = byNumber(result, n);
    if (!c) {
      blocking.push({
        number: n,
        name: `condition_${n}`,
        status: "UNRESOLVED",
        reason: "condition_absent_from_preview",
      });
      continue;
    }
    if (c.status !== "PASS") {
      blocking.push({ number: c.number, name: c.name, status: c.status, reason: c.reason });
    }
  }
  // Stated separately from the loop above on purpose. The two clauses are
  // equivalent today — the non-review conditions ARE every condition outside
  // {1,2,5} — but the contract states both, and a future condition added to the
  // preview must not become ready-by-omission.
  const failedOutsideReview = result.conditions.some(
    (c) =>
      c.status === "FAIL" &&
      !REVIEW_DEPENDENT_CONDITIONS.includes(
        c.number as (typeof REVIEW_DEPENDENT_CONDITIONS)[number],
      ),
  );
  return { ready: blocking.length === 0 && !failedOutsideReview, blocking };
}

export function isHumanReviewReady(result: PreviewResult): boolean {
  return readinessOf(result).ready;
}

export interface ReadyPopulation {
  evaluated: number;
  ready: PreviewResult[];
  notReady: Array<{ result: PreviewResult; verdict: ReadinessVerdict }>;
}

/**
 * Evaluate a whole source/environment through the real A04 path and partition it
 * by readiness. One read-only REPEATABLE READ snapshot for the entire pass, so
 * the population cannot shift underneath the answer.
 */
export async function loadReadyPopulation(
  client: Client,
  args: { source: string; environment: "evaluation" | "production"; asOf: string },
): Promise<ReadyPopulation> {
  return inPreviewSnapshot(client, async () => {
    const results = await composeAllPreviewResultsInCallerTransaction(client, args);
    return partitionByReadiness(results);
  });
}

/** Same partition, for a caller that already holds the snapshot. */
export function partitionByReadiness(results: readonly PreviewResult[]): ReadyPopulation {
  const ready: PreviewResult[] = [];
  const notReady: ReadyPopulation["notReady"] = [];
  for (const result of results) {
    const verdict = readinessOf(result);
    if (verdict.ready) ready.push(result);
    else notReady.push({ result, verdict });
  }
  return { evaluated: results.length, ready, notReady };
}

/**
 * The population A04 would pass 11/11 for if a `source_property_reviews` row
 * were the ONLY thing missing.
 *
 * Reported separately from readiness because the two are routinely confused and
 * the difference is the point of this block: readiness means "a human could
 * decide this", while this means "the decision and its supporting entity
 * evidence already exist". Before any human review it is expected to be empty —
 * condition 1 additionally requires an accepted `new_property` finding, and no
 * machine ever produces one.
 */
export function reviewRowOnlyEligible(results: readonly PreviewResult[]): PreviewResult[] {
  return results.filter((r) => {
    const nonReviewAllPass = NON_REVIEW_CONDITIONS.every((n) => byNumber(r, n)?.status === "PASS");
    if (!nonReviewAllPass) return false;
    const c1 = byNumber(r, 1);
    if (!c1 || c1.status === "PASS") return false; // already reviewed; not "one row away"

    // Read the evaluator's OWN evidence rather than re-deriving it. Adding only a
    // review row makes condition 1 pass when the two things a review row cannot
    // supply are already present: exactly one ACCEPTED distinct-property finding,
    // and a durable receipt bound to the CURRENT observation.
    const accepted = Array.isArray(c1.evidence.acceptedCandidates)
      ? (c1.evidence.acceptedCandidates as Array<{ kind?: unknown }>)
      : [];
    const acceptedNewProperty = accepted.filter((c) => c.kind === "new_property").length;
    const receiptIsCurrent = c1.evidence.receiptIsCurrent === true;
    return acceptedNewProperty === 1 && receiptIsCurrent;
  });
}
