import { backoffDelayMs, GmailReadError } from "@/lib/gmail/import/errors";
import type { AccessTokenOutcome } from "@/lib/gmail/connection.server";
import type { ImportDeps } from "@/lib/gmail/import/worker.server";
import { sanitizeThread, toCommitRow } from "@/lib/gmail/import/sanitizer";
import { B08_DEFAULT_LEASE_SECONDS, B08_DEFAULT_MAX_STEPS } from "@/lib/gmail/sync/contract";
import type { GmailIncrementalReadAdapter } from "@/lib/gmail/sync/read-adapter";
import { runStoredGmailPipeline } from "@/lib/gmail/sync/pipeline";

/**
 * One mailbox, one claimed step at a time. The database holds the cursor,
 * the lease and the due time. This module only discharges the step it was
 * given, then asks again.
 */

export interface SyncDeps {
  db: ImportDeps["db"];
  gmail: GmailIncrementalReadAdapter;
  accessToken: (input: { mailAccountId: string }) => Promise<AccessTokenOutcome>;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  maxSteps: number;
  leaseSeconds: number;
  runPipeline: (input: {
    userId: string;
    mailAccountId: string;
  }) => Promise<void | { completed: boolean }>;
}

export interface SyncOutcome {
  result: string;
  step?: string;
  mode?: string;
  gmailCalls?: number;
}

interface ClaimBody {
  result: string;
  step?: string;
  run_id?: string;
  lease_token?: string;
  mail_account_id?: string;
  authorization_revision?: number | string;
  window_start_at?: string;
  window_end_at?: string;
  page_token?: string | null;
  history_id_start?: string | null;
  provider_thread_id?: string | null;
  mode?: string;
  connection_state?: string;
  next_sync_at?: string;
  status?: string;
}

const STOP = new Set([
  "not_due",
  "not_connected",
  "not_found",
  "no_historical_horizon",
  "historical_import_active",
  "paused",
  "waiting",
  "leased",
  "empty_window",
  "consent_missing",
  "consent_scope_changed",
  "reauth_required",
  "not_configured",
  "configuration_error",
  "failed",
  "not_complete",
  "step_budget_exhausted",
]);

function asClaim(data: unknown): ClaimBody {
  return (data ?? {}) as ClaimBody;
}

async function rpc(
  deps: SyncDeps,
  name: string,
  args: Record<string, unknown>,
): Promise<ClaimBody> {
  const { data, error } = await deps.db.rpc(name, args);
  if (error) {
    const failure = new Error(`${name} failed`);
    failure.name = "SyncRpcError";
    throw failure;
  }
  return asClaim(data);
}

export async function runAccountSync(
  input: { userId: string; mailAccountId: string },
  deps: SyncDeps,
): Promise<SyncOutcome> {
  let gmailCalls = 0;
  for (let stepIndex = 0; stepIndex < deps.maxSteps; stepIndex += 1) {
    const claim = await rpc(deps, "gmail_incremental_sync_claim_step", {
      p_user_id: input.userId,
      p_mail_account_id: input.mailAccountId,
      p_lease_seconds: deps.leaseSeconds,
    });

    if (claim.result === "ok" && claim.step === "run_pipeline") {
      const pipelineLease = claim.lease_token;
      if (!pipelineLease) return { result: "failed", gmailCalls, step: "run_pipeline" };
      const renewEveryMs = Math.min(
        30_000,
        Math.max(250, Math.floor((deps.leaseSeconds * 1000) / 3)),
      );
      const renewTimer = setInterval(() => {
        void rpc(deps, "gmail_incremental_sync_renew_pipeline", {
          p_user_id: input.userId,
          p_mail_account_id: input.mailAccountId,
          p_lease_token: pipelineLease,
          p_lease_seconds: deps.leaseSeconds,
        }).catch(() => undefined);
      }, renewEveryMs);
      renewTimer.unref?.();
      try {
        const piped = await deps.runPipeline({
          userId: input.userId,
          mailAccountId: input.mailAccountId,
        });
        if (piped && piped.completed === false) {
          const released = await rpc(deps, "gmail_incremental_sync_release_pipeline", {
            p_user_id: input.userId,
            p_mail_account_id: input.mailAccountId,
            p_lease_token: pipelineLease,
          });
          if (released.result !== "ok") return { result: released.result, gmailCalls };
          return { result: "pipeline_pending", gmailCalls };
        }
        const marked = await rpc(deps, "gmail_incremental_sync_mark_pipeline_done", {
          p_user_id: input.userId,
          p_mail_account_id: input.mailAccountId,
          p_lease_token: pipelineLease,
        });
        if (marked.result !== "ok") return { result: marked.result, gmailCalls };
      } catch (error) {
        await rpc(deps, "gmail_incremental_sync_release_pipeline", {
          p_user_id: input.userId,
          p_mail_account_id: input.mailAccountId,
          p_lease_token: pipelineLease,
        });
        throw error;
      } finally {
        clearInterval(renewTimer);
      }
      continue;
    }

    if (claim.result !== "ok") {
      return { result: claim.result, gmailCalls, mode: claim.mode };
    }

    const discharged = await dischargeStep(input, claim, deps, () => {
      gmailCalls += 1;
    });
    if (STOP.has(discharged.result)) return { ...discharged, gmailCalls };
  }
  return { result: "step_budget_exhausted", gmailCalls };
}

async function dischargeStep(
  input: { userId: string; mailAccountId: string },
  claim: ClaimBody,
  deps: SyncDeps,
  countGmail: () => void,
): Promise<SyncOutcome> {
  const runId = claim.run_id!;
  const lease = claim.lease_token!;
  const revision = Number(claim.authorization_revision);
  const step = claim.step!;
  const threadId = claim.provider_thread_id ?? null;

  if (step === "enqueue_known" || step === "complete_run") {
    const name =
      step === "enqueue_known"
        ? "gmail_incremental_sync_commit_enqueue_known"
        : "gmail_incremental_sync_commit_completion";
    const args =
      step === "enqueue_known"
        ? {
            p_user_id: input.userId,
            p_run_id: runId,
            p_lease_token: lease,
            p_expected_authorization_revision: revision,
          }
        : {
            p_user_id: input.userId,
            p_run_id: runId,
            p_lease_token: lease,
            p_expected_authorization_revision: revision,
          };
    const committed = await rpc(deps, name, args);
    return { result: committed.result === "ok" ? "progressed" : committed.result, step };
  }

  const token = await deps.accessToken({ mailAccountId: input.mailAccountId });
  const authStop = await applyTokenOutcome(deps, input.userId, runId, lease, token);
  if (authStop) return authStop;
  const accessToken = (token as { accessToken: string }).accessToken;

  const live = await rpc(deps, "gmail_incremental_sync_validate_claim", {
    p_user_id: input.userId,
    p_run_id: runId,
    p_lease_token: lease,
    p_expected_authorization_revision: revision,
    p_expected_step: step,
    p_expected_provider_thread_id: threadId,
  });
  if (live.result !== "ok") return { result: live.result, step };

  try {
    if (step === "enumerate_history") {
      countGmail();
      const page = await deps.gmail.listHistory({
        accessToken,
        startHistoryId: claim.history_id_start!,
        pageToken: claim.page_token ?? null,
      });
      const committed = await rpc(deps, "gmail_incremental_sync_commit_history_page", {
        p_user_id: input.userId,
        p_run_id: runId,
        p_lease_token: lease,
        p_expected_authorization_revision: revision,
        p_page_token_used: claim.page_token ?? null,
        p_next_page_token: page.nextPageToken,
        p_history_id: page.historyId,
        p_threads: page.threads.map((thread) => ({
          provider_thread_id: thread.providerThreadId,
          messages: thread.messages.map((message) => ({
            provider_message_id: message.providerMessageId,
            label_ids: message.labelIds,
          })),
        })),
        p_quota_units: page.quotaUnits,
      });
      return { result: committed.result === "ok" ? "progressed" : committed.result, step };
    }

    if (step === "enumerate_sent") {
      countGmail();
      const page = await deps.gmail.listSentMessages({
        accessToken,
        windowStartMs: Date.parse(claim.window_start_at!),
        windowEndMs: Date.parse(claim.window_end_at!),
        pageToken: claim.page_token ?? null,
        // The profile snapshot is already taken. A before: bound at
        // window_end_at drops sent mail that exists inside that snapshot
        // when Gmail's second is slightly later.
        omitUpperBound: true,
      });
      const committed = await rpc(deps, "gmail_incremental_sync_commit_sent_page", {
        p_user_id: input.userId,
        p_run_id: runId,
        p_lease_token: lease,
        p_expected_authorization_revision: revision,
        p_page_token_used: claim.page_token ?? null,
        p_next_page_token: page.nextPageToken,
        // The search already named the message. Persist that id before
        // threads.get so a snapshot sent message with no numeric historyId
        // is stored, or withholds the cursor, the same way history.list does.
        p_candidates: page.candidates.map((candidate) => ({
          provider_thread_id: candidate.threadId,
          provider_message_id: candidate.messageId,
        })),
        p_quota_units: page.quotaUnits,
      });
      return { result: committed.result === "ok" ? "progressed" : committed.result, step };
    }

    if (step === "fetch_thread") {
      countGmail();
      const fetched = await deps.gmail.getThread({
        accessToken,
        threadId: threadId!,
      });
      // SQL applies the inclusion window. Bodies still have to arrive here:
      // a snapshot message dated slightly after window_end_at is stored, and
      // a history.list id dated before window_start_at is an exclusion, not
      // a withheld cursor.
      const sanitized = sanitizeThread(fetched.thread, {
        startMs: 0,
        endMs: Number.MAX_SAFE_INTEGER,
      });
      const committed = await rpc(deps, "gmail_incremental_sync_commit_thread", {
        p_user_id: input.userId,
        p_run_id: runId,
        p_lease_token: lease,
        p_expected_authorization_revision: revision,
        p_provider_thread_id: threadId,
        p_messages: sanitized.messages.map(toCommitRow),
        p_quota_units: fetched.quotaUnits,
      });
      return { result: committed.result === "ok" ? "progressed" : committed.result, step };
    }

    if (step === "capture_history") {
      countGmail();
      const profile = await deps.gmail.getProfileHistoryId({ accessToken });
      const committed = await rpc(deps, "gmail_incremental_sync_commit_profile_history", {
        p_user_id: input.userId,
        p_run_id: runId,
        p_lease_token: lease,
        p_expected_authorization_revision: revision,
        p_history_id: profile.historyId,
        p_quota_units: profile.quotaUnits,
      });
      return { result: committed.result === "ok" ? "progressed" : committed.result, step };
    }
  } catch (error) {
    if (error instanceof GmailReadError) {
      return handleProviderError(deps, input.userId, claim, error);
    }
    throw error;
  }

  return { result: "failed", step };
}

async function handleProviderError(
  deps: SyncDeps,
  userId: string,
  claim: ClaimBody,
  error: GmailReadError,
): Promise<SyncOutcome> {
  const runId = claim.run_id!;
  const lease = claim.lease_token!;
  const revision = Number(claim.authorization_revision);
  const step = claim.step!;
  const threadId = claim.provider_thread_id ?? null;

  if (error.reason === "history_id_expired" && step === "enumerate_history") {
    const switched = await rpc(deps, "gmail_incremental_sync_history_expired", {
      p_user_id: userId,
      p_run_id: runId,
      p_lease_token: lease,
      p_expected_authorization_revision: revision,
    });
    return {
      result: switched.result === "ok" ? "progressed" : switched.result,
      step,
      mode: "bounded_rescan",
    };
  }

  if (error.reason === "thread_not_found" && step === "fetch_thread") {
    const gone = await rpc(deps, "gmail_incremental_sync_record_thread_gone", {
      p_user_id: userId,
      p_run_id: runId,
      p_lease_token: lease,
      p_expected_authorization_revision: revision,
      p_provider_thread_id: threadId,
      p_quota_units: 0,
    });
    return { result: gone.result === "ok" ? "progressed" : gone.result, step };
  }

  if (error.retryable) {
    const delay = Math.ceil(backoffDelayMs(1, deps.random) / 1000);
    await deps.sleep(0);
    const retry = await rpc(deps, "gmail_incremental_sync_record_retry", {
      p_user_id: userId,
      p_run_id: runId,
      p_lease_token: lease,
      p_expected_authorization_revision: revision,
      p_expected_step: step,
      p_provider_thread_id: threadId,
      p_error_code: error.reason,
      p_delay_seconds: delay,
    });
    return { result: retry.result, step };
  }

  const failed = await rpc(deps, "gmail_incremental_sync_fail_run", {
    p_user_id: userId,
    p_run_id: runId,
    p_lease_token: lease,
    p_expected_authorization_revision: revision,
    p_expected_step: step,
    p_provider_thread_id: threadId,
    p_error_code: error.reason,
  });
  return { result: failed.result, step };
}

async function applyTokenOutcome(
  deps: SyncDeps,
  userId: string,
  runId: string,
  lease: string,
  token: AccessTokenOutcome,
): Promise<SyncOutcome | null> {
  if (token.result === "ok") return null;
  if (token.result === "reauth_required") {
    await rpc(deps, "gmail_incremental_sync_pause", {
      p_user_id: userId,
      p_run_id: runId,
      p_reason: "reauth",
    });
    return { result: "paused" };
  }
  if (token.result === "consent_missing") {
    await rpc(deps, "gmail_incremental_sync_pause", {
      p_user_id: userId,
      p_run_id: runId,
      p_reason: "consent",
    });
    return { result: "paused" };
  }
  if (token.result === "not_connected") {
    await rpc(deps, "gmail_incremental_sync_cancel_connection_stopped", {
      p_user_id: userId,
      p_run_id: runId,
    });
    return { result: "not_connected" };
  }
  if (token.result === "not_configured" || token.result === "configuration_error") {
    await rpc(deps, "gmail_incremental_sync_release_claim", {
      p_user_id: userId,
      p_run_id: runId,
      p_lease_token: lease,
    });
    return { result: token.result };
  }
  await rpc(deps, "gmail_incremental_sync_release_claim", {
    p_user_id: userId,
    p_run_id: runId,
    p_lease_token: lease,
  });
  return { result: token.result };
}

export async function runDueSyncs(
  deps: SyncDeps,
  limit: number,
): Promise<{ accounts: number; outcomes: SyncOutcome[] }> {
  const listed = await rpc(deps, "gmail_incremental_sync_list_due", { p_limit: limit });
  const accounts = ((listed as { accounts?: { user_id: string; mail_account_id: string }[] })
    .accounts ?? []) as { user_id: string; mail_account_id: string }[];
  const outcomes: SyncOutcome[] = [];
  for (const account of accounts) {
    outcomes.push(
      await runAccountSync(
        { userId: account.user_id, mailAccountId: account.mail_account_id },
        deps,
      ),
    );
  }
  return { accounts: accounts.length, outcomes };
}

export function syncDeps(
  partial: Pick<SyncDeps, "db" | "gmail" | "accessToken"> & Partial<SyncDeps>,
): SyncDeps {
  return {
    sleep: partial.sleep ?? (async () => undefined),
    random: partial.random ?? (() => 0),
    maxSteps: partial.maxSteps ?? B08_DEFAULT_MAX_STEPS,
    leaseSeconds: partial.leaseSeconds ?? B08_DEFAULT_LEASE_SECONDS,
    runPipeline: partial.runPipeline ?? ((input) => runStoredGmailPipeline(partial.db, input)),
    db: partial.db,
    gmail: partial.gmail,
    accessToken: partial.accessToken,
  };
}
