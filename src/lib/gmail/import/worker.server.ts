import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { getFreshGmailAccessToken, type AccessTokenOutcome } from "@/lib/gmail/connection.server";
import {
  B03_MAX_PROVIDER_ATTEMPTS,
  B03_QUOTA_UNITS_PER_MINUTE_PER_MAILBOX,
  MESSAGES_LIST_QUOTA_UNITS,
  THREADS_GET_QUOTA_UNITS,
} from "@/lib/gmail/import/contract";
import { backoffDelayMs, GmailReadError } from "@/lib/gmail/import/errors";
import {
  gmailHistoricalReadAdapter,
  type GmailHistoricalReadAdapter,
} from "@/lib/gmail/import/read-adapter.server";
import { sanitizeThread, toCommitRow } from "@/lib/gmail/import/sanitizer";

/**
 * THE B03 WORKER: one durable step at a time.
 *
 * There is no background runtime in this repository, and pretending otherwise —
 * a fire-and-forget promise, a request that never returns, an in-memory queue —
 * would produce a pipeline whose progress lives in a process that can die. So
 * the database holds the queue, the cursor and the lease, and this module is
 * only the thing that discharges one claimed unit of work.
 *
 * Every step is: claim → get a fresh access token through B02 → pace → REVALIDATE
 * THE CLAIM → make exactly one Gmail call → commit. If the process dies at any
 * point, the lease expires and the next worker claims the same work; the
 * database's idempotence rules make the replay safe.
 *
 * The revalidation is the boundary of B03's cancellation guarantee, and it is
 * worth stating exactly:
 *
 *   BEFORE it returns ok   a Disconnect, a withdrawn consent or a reclaimed
 *                          lease prevents the READ from happening at all
 *   AFTER  it returns ok   the operation is in flight. PostgreSQL cannot cancel
 *                          a request already on the wire, and no lock would help
 *                          — so the guarantee narrows to the one that is true:
 *                          the RESULT may not be persisted.
 */

export interface ImportDeps {
  db: ReturnType<typeof createAdminClient>;
  gmail: GmailHistoricalReadAdapter;
  /** Injected so tests assert the retry policy instead of waiting for it. */
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random: () => number;
  /**
   * B02's may-we-read chokepoint. Injected so tests can drive every provider
   * lifecycle answer, and narrowed to the one call B03 is allowed to make: B03
   * never refreshes a token itself and never reads the credential table.
   */
  accessToken: (input: { mailAccountId: string }) => Promise<AccessTokenOutcome>;
}

export function defaultImportDeps(): ImportDeps {
  return {
    db: createAdminClient(),
    gmail: gmailHistoricalReadAdapter,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    random: Math.random,
    accessToken: (input) => getFreshGmailAccessToken(input),
  };
}

export type StepOutcome =
  | { result: "progressed"; step: string }
  | { result: "waiting"; nextAttemptAt: string | null }
  | { result: "finished"; status: string }
  | { result: "paused"; reason: "reauth" | "consent" }
  | { result: "cancelled"; connectionState: string }
  | { result: "leased" }
  | { result: "not_found" }
  | { result: "not_runnable"; status: string }
  | { result: "retry_scheduled"; reason: string }
  | { result: "failed"; reason: string };

interface ClaimedStep {
  result: string;
  step?: string;
  lease_token?: string;
  mail_account_id?: string;
  authorization_revision?: number | string;
  window_start_at?: string;
  window_end_at?: string;
  page_token?: string | null;
  provider_thread_id?: string;
  attempt_count?: number;
  status?: string;
  reason?: string;
  connection_state?: string;
  next_attempt_at?: string | null;
}

const msOf = (iso: string): number => new Date(iso).getTime();

/**
 * The database's refusal vocabulary, mapped onto the run lifecycle.
 *
 * `authorization_changed` is deliberately NOT a lifecycle event: the revision
 * moved, so this response is stale and nothing of it is kept, but the mailbox
 * itself may be perfectly healthy. The next claim will read the current state
 * and decide from there.
 */
function commitRefusalToLifecycle(result: string | undefined): string {
  if (result === "consent_scope_changed" || result === "consent_missing") return "consent_missing";
  if (result === "not_connected" || result === "not_found") return "not_connected";
  return result ?? "";
}

/**
 * A conservative per-mailbox pace, AND EXACTLY WHAT IT GUARANTEES.
 *
 * Google publishes a per-user ceiling; B03 plans against a lower number, because
 * a published limit is shared with every other client of that user and can
 * change. Correctness and provider safety matter more here than throughput: a
 * historical import is a burst against one mailbox, which is exactly the shape
 * that trips a rate limit.
 *
 * IT IS PROCESS-LOCAL, and calling it a per-mailbox rate limiter would overstate
 * it. One `gmail:import:work` process paces ITSELF to the budget. Two
 * independently started worker processes do not share a bucket, and nothing here
 * is durable across restarts.
 *
 * That is acceptable for the pilot because the durable retry budget and the
 * provider's own rate responses — not this pacer — are what actually stop a run
 * that is asking for too much: a 429 is recorded, backed off with jitter, and
 * bounded at five attempts, all in the database. B03 is not being widened into
 * distributed infrastructure to make this class instead; it is being described
 * accurately.
 */
export class QuotaPacer {
  private windowStartMs: number;
  private unitsInWindow = 0;

  constructor(
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly budgetPerMinute = B03_QUOTA_UNITS_PER_MINUTE_PER_MAILBOX,
  ) {
    this.windowStartMs = now();
  }

  async reserve(units: number): Promise<void> {
    const elapsed = this.now() - this.windowStartMs;
    if (elapsed >= 60_000) {
      this.windowStartMs = this.now();
      this.unitsInWindow = 0;
    }
    if (this.unitsInWindow + units > this.budgetPerMinute) {
      await this.sleep(Math.max(60_000 - elapsed, 0));
      this.windowStartMs = this.now();
      this.unitsInWindow = 0;
    }
    this.unitsInWindow += units;
  }
}

/**
 * Translate B02's answer about the mailbox into a run lifecycle decision.
 *
 * B03 never reconnects Gmail and never re-grants consent. It records what B02
 * said and stops; resuming is an explicit human/operator act, because the thing
 * that stopped the import was a human decision.
 */
async function applyAuthorizationOutcome(
  deps: ImportDeps,
  userId: string,
  runId: string,
  outcome: { result: string; connectionState?: string },
): Promise<StepOutcome | null> {
  if (outcome.result === "ok") return null;

  if (outcome.result === "reauth_required") {
    await deps.db.rpc("gmail_historical_import_pause", {
      p_user_id: userId,
      p_run_id: runId,
      p_reason: "reauth",
    });
    return { result: "paused", reason: "reauth" };
  }

  if (outcome.result === "consent_missing") {
    await deps.db.rpc("gmail_historical_import_pause", {
      p_user_id: userId,
      p_run_id: runId,
      p_reason: "consent",
    });
    return { result: "paused", reason: "consent" };
  }

  if (outcome.result === "not_connected") {
    const state = outcome.connectionState ?? "unknown";

    // WHICH KIND OF "NOT CONNECTED" DECIDES WHETHER THIS IS PAUSE OR STOP.
    //
    // B01's consent dominance means a withdrawn consent does not leave the
    // mailbox `connected` — it moves to `consent_required`, credential intact.
    // So the state name IS the reason, and treating every non-connected state
    // as a Disconnect would cancel a run the human could simply resume by
    // answering the permission question again.
    if (state === "consent_required") {
      await deps.db.rpc("gmail_historical_import_pause", {
        p_user_id: userId,
        p_run_id: runId,
        p_reason: "consent",
      });
      return { result: "paused", reason: "consent" };
    }

    if (state === "reauth_required" || state === "pending_authorization") {
      await deps.db.rpc("gmail_historical_import_pause", {
        p_user_id: userId,
        p_run_id: runId,
        p_reason: "reauth",
      });
      return { result: "paused", reason: "reauth" };
    }

    // `disconnecting`, `disconnected`, `deletion_pending`, `deleted`. The human
    // stopped this connection or a deletion now owns the mailbox. Either way the
    // import stops, and it does NOT resume by itself if they reconnect later —
    // starting again is a decision.
    await deps.db.rpc("gmail_historical_import_cancel_connection_stopped", {
      p_user_id: userId,
      p_run_id: runId,
      p_connection_state: state,
    });
    return { result: "cancelled", connectionState: state };
  }

  // `state_changed` and `provider_unavailable` are transient by B02's own
  // taxonomy: nothing is concluded about the human's intent, so the step is
  // simply not performed and the worker tries again later.
  return { result: "retry_scheduled", reason: outcome.result };
}

interface DbRefusal {
  result?: string;
  connection_state?: string;
  run_status?: string;
}

/**
 * ONE PLACE THAT TURNS A DATABASE REFUSAL INTO A TRUTHFUL OUTCOME.
 *
 * Every commit path can be refused, and the refusal has to be reported as what
 * it is. Two rules matter here:
 *
 * FIRST, the run's own status wins when the database says the run is no longer
 * runnable. A mailbox lifecycle change now stops runs durably in the same
 * transaction that moved the mailbox, so by the time a stale response arrives
 * the run is ALREADY cancelled or paused — and the honest report is "cancelled",
 * not "we will try again later".
 *
 * SECOND, nothing is ever reported as progress. A refusal means the mutation did
 * not happen; saying otherwise would let a caller believe a work item moved when
 * it did not.
 */
async function refusalOutcome(
  deps: ImportDeps,
  input: { userId: string; runId: string },
  outcome: DbRefusal,
): Promise<StepOutcome> {
  if (outcome.run_status === "cancelled_connection_stopped") {
    return { result: "cancelled", connectionState: outcome.connection_state ?? "unknown" };
  }
  if (outcome.run_status === "paused_consent") return { result: "paused", reason: "consent" };
  if (outcome.run_status === "paused_reauth") return { result: "paused", reason: "reauth" };
  if (outcome.run_status === "failed" || outcome.run_status === "completed") {
    return { result: "not_runnable", status: outcome.run_status };
  }

  return (
    (await applyAuthorizationOutcome(deps, input.userId, input.runId, {
      result: commitRefusalToLifecycle(outcome.result),
      connectionState: outcome.connection_state,
    })) ?? { result: "retry_scheduled", reason: outcome.result ?? "unknown" }
  );
}

/**
 * THE LAST THING BEFORE WE TOUCH GOOGLE.
 *
 * The commit fence protects the database. This protects the MAILBOX.
 *
 * Between claiming a step and making the request, a worker asks B02 for an
 * access token and may wait out the quota pacer. A human can Disconnect in that
 * gap. The lifecycle trigger cancels the run and clears the lease — but this
 * process is still holding the claim in memory, and if the person later
 * reconnects, B02 hands it a perfectly valid token for a mailbox that is once
 * again connected. It would then read Gmail under an import intention that was
 * cancelled. Nothing would be persisted, and a read would still have happened.
 *
 * "A cancelled run does not resume" is a promise about READING somebody's mail,
 * not only about writing rows, so it is enforced where the reading starts.
 *
 * Returns true only if the claim is still exactly the claim we were given.
 */
async function claimStillValid(
  deps: ImportDeps,
  input: { userId: string; runId: string },
  claim: {
    leaseToken: string;
    revision: number;
    step: string;
    providerThreadId: string | null;
  },
): Promise<{ ok: true } | { ok: false; outcome: StepOutcome }> {
  const { data, error } = await deps.db.rpc("gmail_historical_import_validate_claim", {
    p_user_id: input.userId,
    p_run_id: input.runId,
    p_lease_token: claim.leaseToken,
    p_expected_authorization_revision: claim.revision,
    p_expected_step: claim.step,
    p_expected_provider_thread_id: claim.providerThreadId,
  });

  // A TRANSPORT FAILURE IS NOT PERMISSION. If we cannot prove the claim is still
  // live, we do not read.
  if (error)
    return { ok: false, outcome: { result: "retry_scheduled", reason: "validate_failed" } };

  const outcome = (data ?? {}) as DbRefusal;
  if (outcome.result === "ok") return { ok: true };
  return { ok: false, outcome: await refusalOutcome(deps, input, outcome) };
}

/**
 * PERFORM AT MOST ONE DURABLE STEP.
 *
 * Everything that matters is committed by the database, under a lease token and
 * an authorization-revision fence. This function holds nothing that would be
 * missed if the process disappeared between two lines.
 */
export async function runOneImportStep(
  input: { userId: string; runId: string; leaseSeconds?: number },
  deps: ImportDeps = defaultImportDeps(),
  pacer?: QuotaPacer,
): Promise<StepOutcome> {
  const { data: claimedRaw, error: claimError } = await deps.db.rpc(
    "gmail_historical_import_claim_step",
    {
      p_user_id: input.userId,
      p_run_id: input.runId,
      p_lease_seconds: input.leaseSeconds ?? 300,
    },
  );
  if (claimError) return { result: "failed", reason: "claim_failed" };

  const claimed = (claimedRaw ?? { result: "not_found" }) as ClaimedStep;

  if (claimed.result === "not_found") return { result: "not_found" };
  if (claimed.result === "leased") return { result: "leased" };
  if (claimed.result === "waiting") {
    return { result: "waiting", nextAttemptAt: claimed.next_attempt_at ?? null };
  }
  if (claimed.result === "not_runnable") {
    return { result: "not_runnable", status: claimed.status ?? "unknown" };
  }
  if (claimed.result === "authorization_unavailable") {
    // The claim refused before issuing a lease, so there is nothing to release.
    const mapped =
      claimed.reason === "consent_missing" || claimed.reason === "consent_scope_changed"
        ? "consent_missing"
        : claimed.reason === "not_connected" || claimed.reason === "not_found"
          ? "not_connected"
          : "state_changed";
    return (
      (await applyAuthorizationOutcome(deps, input.userId, input.runId, {
        result: mapped,
        connectionState: claimed.connection_state,
      })) ?? { result: "retry_scheduled", reason: "authorization_unavailable" }
    );
  }
  if (claimed.result !== "ok") return { result: "failed", reason: "claim_refused" };

  const leaseToken = claimed.lease_token!;
  const mailAccountId = claimed.mail_account_id!;
  const revision = Number(claimed.authorization_revision);

  if (claimed.step === "complete_run") {
    const { data } = await deps.db.rpc("gmail_historical_import_commit_completion", {
      p_user_id: input.userId,
      p_run_id: input.runId,
      p_lease_token: leaseToken,
      // NO GMAIL CALL HAPPENS FOR THIS STEP, AND IT IS STILL FENCED. The window
      // between claiming `complete_run` and committing it is small and not
      // zero, and what can change inside it is a HUMAN DECISION.
      p_expected_authorization_revision: revision,
    });
    const outcome = (data ?? {}) as {
      result?: string;
      status?: string;
      connection_state?: string;
      run_status?: string;
    };
    if (outcome.result !== "ok") return refusalOutcome(deps, input, outcome);
    return { result: "finished", status: outcome.status ?? "completed" };
  }

  // B02 IS THE ONLY MAY-WE-READ CHOKEPOINT. No refresh logic here, no credential
  // table read, and the token is never persisted or logged — it exists inside
  // this function and falls out of scope with it.
  const token = await deps.accessToken({ mailAccountId });
  const authOutcome = await applyAuthorizationOutcome(deps, input.userId, input.runId, {
    result: token.result,
    connectionState: "connectionState" in token ? (token.connectionState ?? undefined) : undefined,
  });
  if (authOutcome) {
    // The lease is left to expire rather than being force-cleared under a
    // failure we did not cause; pause/cancel already cleared it where it matters.
    return authOutcome;
  }
  const accessToken = (token as { accessToken: string }).accessToken;

  const quota = pacer ?? new QuotaPacer(deps.now, deps.sleep);

  if (claimed.step === "enumerate_page") {
    await quota.reserve(MESSAGES_LIST_QUOTA_UNITS);

    // AFTER the token, AFTER any pacing sleep, and IMMEDIATELY before the
    // request. Anything earlier would leave exactly the gap this closes.
    const live = await claimStillValid(deps, input, {
      leaseToken,
      revision,
      step: "enumerate_page",
      providerThreadId: null,
    });
    if (!live.ok) return live.outcome;

    try {
      const page = await deps.gmail.listSentMessages({
        accessToken,
        // EXACT MILLISECONDS. The adapter rounds outward to Gmail's
        // second-resolution search; rounding here would round twice and could
        // only ever narrow the request.
        windowStartMs: msOf(claimed.window_start_at!),
        windowEndMs: msOf(claimed.window_end_at!),
        pageToken: claimed.page_token ?? null,
      });

      // DEDUPE HERE, and let the unique constraint be the final authority: one
      // thread may hold many sent messages, and it is one unit of work.
      const threadIds = [...new Set(page.candidates.map((c) => c.threadId))];

      const { data } = await deps.db.rpc("gmail_historical_import_commit_page", {
        p_user_id: input.userId,
        p_run_id: input.runId,
        p_lease_token: leaseToken,
        p_expected_authorization_revision: revision,
        p_page_token_used: claimed.page_token ?? null,
        p_next_page_token: page.nextPageToken,
        p_thread_ids: threadIds,
        p_sent_messages_seen: page.candidates.length,
        p_quota_units: page.quotaUnits,
      });
      const outcome = (data ?? {}) as DbRefusal;
      if (outcome.result === "ok" || outcome.result === "already_applied") {
        return { result: "progressed", step: "enumerate_page" };
      }
      return refusalOutcome(deps, input, outcome);
    } catch (error) {
      return recordProviderFailure(
        deps,
        input,
        leaseToken,
        revision,
        null,
        error,
        // ENUMERATION'S OWN DURABLE BUDGET, carried on the run. A page has no
        // work item to count against, so the claim hands the count over.
        claimed.attempt_count ?? 0,
      );
    }
  }

  // fetch_thread
  const providerThreadId = claimed.provider_thread_id!;
  await quota.reserve(THREADS_GET_QUOTA_UNITS);

  const live = await claimStillValid(deps, input, {
    leaseToken,
    revision,
    step: "fetch_thread",
    providerThreadId,
  });
  if (!live.ok) return live.outcome;

  try {
    const fetched = await deps.gmail.getThread({ accessToken, threadId: providerThreadId });

    // THE RESPONSE MUST BE ABOUT THE THREAD WE ASKED FOR. A provider that
    // answers with a different conversation is not something to normalize away.
    if ((fetched.thread.id ?? "").trim() !== providerThreadId) {
      throw new GmailReadError({
        operation: "threads_get",
        status: null,
        reason: "malformed_response",
        retryable: false,
      });
    }

    const sanitized = sanitizeThread(fetched.thread, {
      startMs: new Date(claimed.window_start_at!).getTime(),
      endMs: new Date(claimed.window_end_at!).getTime(),
    });

    const { data } = await deps.db.rpc("gmail_historical_import_commit_thread", {
      p_user_id: input.userId,
      p_run_id: input.runId,
      p_lease_token: leaseToken,
      p_expected_authorization_revision: revision,
      p_provider_thread_id: providerThreadId,
      p_messages: sanitized.messages.map(toCommitRow),
      p_quota_units: fetched.quotaUnits,
      p_text_parts_omitted_external: sanitized.counters.textPartsOmittedExternal,
      p_attachment_or_nontext_parts_omitted: sanitized.counters.attachmentOrNonTextPartsOmitted,
    });
    const outcome = (data ?? {}) as DbRefusal;
    if (outcome.result === "ok" || outcome.result === "already_applied") {
      return { result: "progressed", step: "fetch_thread" };
    }
    // NOT A REFUSAL AND NOT AN IMPORT. The database proved from the fetched
    // thread that it holds no SENT message inside the exact window, so nothing
    // was stored and the work item is terminal. Provider discovery is a
    // deliberate superset; this is what the excess looks like when it arrives.
    if (outcome.result === "filtered_out") {
      return { result: "progressed", step: "thread_filtered_out" };
    }
    return refusalOutcome(deps, input, outcome);
  } catch (error) {
    return recordProviderFailure(
      deps,
      input,
      leaseToken,
      revision,
      providerThreadId,
      error,
      claimed.attempt_count ?? 0,
    );
  }
}

async function recordProviderFailure(
  deps: ImportDeps,
  input: { userId: string; runId: string },
  leaseToken: string,
  authorizationRevision: number,
  providerThreadId: string | null,
  error: unknown,
  attemptCount: number,
): Promise<StepOutcome> {
  const read =
    error instanceof GmailReadError
      ? error
      : new GmailReadError({
          operation: providerThreadId ? "threads_get" : "messages_list",
          status: null,
          reason: "unknown",
          retryable: false,
        });

  // A VANISHED THREAD IS A TERMINAL WORK RESULT, NOT A RUN FAILURE, and it
  // certainly does not license fabricating a message row. It is still a
  // provider result obtained under one authorization, so it is fenced like one.
  if (read.reason === "thread_not_found" && providerThreadId) {
    const { data } = await deps.db.rpc("gmail_historical_import_record_thread_gone", {
      p_user_id: input.userId,
      p_run_id: input.runId,
      p_lease_token: leaseToken,
      p_expected_authorization_revision: authorizationRevision,
      p_provider_thread_id: providerThreadId,
      p_quota_units: THREADS_GET_QUOTA_UNITS,
    });
    const outcome = (data ?? {}) as DbRefusal;
    // THE SEMANTIC RESULT DECIDES WHAT HAPPENED. A refusal means the work item
    // was NOT marked gone, and reporting `progressed` would tell the caller a
    // mutation occurred that did not.
    if (outcome.result === "ok" || outcome.result === "already_applied") {
      return { result: "progressed", step: "thread_gone" };
    }
    return refusalOutcome(deps, input, outcome);
  }

  const delayMs = read.retryable ? backoffDelayMs(attemptCount + 1, deps.random) : 0;

  const { data } = await deps.db.rpc("gmail_historical_import_record_retry", {
    p_user_id: input.userId,
    p_run_id: input.runId,
    p_lease_token: leaseToken,
    p_expected_authorization_revision: authorizationRevision,
    p_provider_thread_id: providerThreadId,
    p_error_code: read.reason,
    p_retry_after_seconds: Math.ceil(delayMs / 1000),
    p_quota_units: providerThreadId ? THREADS_GET_QUOTA_UNITS : MESSAGES_LIST_QUOTA_UNITS,
    // A non-retryable error exhausts the work item immediately rather than
    // being attempted four more times to reach the same answer.
    p_max_attempts: read.retryable ? B03_MAX_PROVIDER_ATTEMPTS : 1,
  });
  const outcome = (data ?? {}) as DbRefusal & { thread_failed?: boolean; run_failed?: boolean };

  // NOTHING WAS RECORDED IF THE FENCE REFUSED. The attempt did not count, the
  // work item did not move, and the caller must not be told it did.
  if (outcome.result !== "ok") return refusalOutcome(deps, input, outcome);

  if (read.retryable && delayMs > 0) await deps.sleep(delayMs);

  // A RUN WHOSE ENUMERATION EXHAUSTED ITS BUDGET IS FINISHED, and the loop must
  // stop rather than claim a step that will never be handed out again.
  if (outcome.run_failed) return { result: "failed", reason: read.reason };
  if (outcome.thread_failed) return { result: "failed", reason: read.reason };
  return { result: "retry_scheduled", reason: read.reason };
}

/**
 * Drive steps until the run reaches a state that is not "more work right now".
 *
 * The loop is a convenience for an operator. The DURABLE state is the truth: if
 * this process dies mid-loop, running the command again resumes from whatever
 * the database says, with no in-memory context to reconstruct.
 */
export async function runImportUntilIdle(
  input: { userId: string; runId: string; maxSteps?: number; leaseSeconds?: number },
  deps: ImportDeps = defaultImportDeps(),
): Promise<StepOutcome> {
  const pacer = new QuotaPacer(deps.now, deps.sleep);
  const maxSteps = input.maxSteps ?? 10_000;
  let last: StepOutcome = { result: "waiting", nextAttemptAt: null };

  for (let i = 0; i < maxSteps; i += 1) {
    last = await runOneImportStep(input, deps, pacer);
    if (
      last.result === "finished" ||
      last.result === "paused" ||
      last.result === "cancelled" ||
      last.result === "waiting" ||
      last.result === "leased" ||
      last.result === "not_found" ||
      last.result === "not_runnable" ||
      last.result === "failed"
    ) {
      return last;
    }
  }
  return last;
}
