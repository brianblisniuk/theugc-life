/**
 * Best-effort intelligence refresh policy (Sprint 2E, PRD §12, D008).
 *
 * Raw creator events are authoritative and must be more durable than anything
 * derived from them. So the refresh is deliberately NOT a database trigger on
 * `outreach_events`: recording what a creator actually did must never depend on
 * an aggregate succeeding.
 *
 * The rules encoded here:
 *
 *   - refresh only AFTER a workflow mutation has already committed;
 *   - refresh on retries too, since recomputation is idempotent and a retry is
 *     a free chance to heal a stale aggregate;
 *   - never let a refresh failure change the workflow's answer. "Your pitch was
 *     recorded" does not become "error" because a derived number is stale.
 *
 * Framework-free so the policy is unit-testable without a database.
 */

/** The shape every workflow/deal result shares. */
export interface WorkflowOutcomeLike {
  result: string;
}

/**
 * Whether a committed workflow outcome should trigger a refresh.
 *
 * `applied` changed the ledger. `already_applied` did not, but it means the
 * caller believes this state is current, and recomputing is cheap, deterministic
 * and self-healing — so a retry after an earlier failed refresh repairs it.
 * Every failure outcome is excluded: nothing was written, so nothing derived
 * can have changed.
 */
export function shouldRefreshIntelligence(
  outcome: WorkflowOutcomeLike | null | undefined,
): boolean {
  if (!outcome) return false;
  return outcome.result === "applied" || outcome.result === "already_applied";
}

/**
 * A refresh outcome is never a product outcome. This exists to make the
 * asymmetry explicit at the call site: the workflow result passes through
 * untouched whatever the refresh did.
 */
export function workflowResultAfterRefresh<T>(result: T, _refreshed: boolean): T {
  return result;
}
