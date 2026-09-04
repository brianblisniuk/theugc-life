import type { createAdminClient } from "@/lib/supabase/admin";
import { GMAIL_NORMALIZER_VERSION, type NormalizeCandidate } from "@/lib/gmail/normalize/contract";
import { computeNormalization } from "@/lib/gmail/normalize/normalizer";
import { NormalizationStructuralError } from "@/lib/gmail/normalize/errors";

/**
 * B04's OPERATIONAL LOGIC — deliberately WITHOUT `server-only`.
 *
 * `createAdminClient` (and therefore `server-only`) is imported here as a
 * TYPE ONLY (`import type`), which TypeScript erases entirely at compile
 * time: this module never actually loads `@/lib/supabase/admin` at runtime,
 * so it carries no secret-construction code and no bundling restriction.
 * `service.server.ts` is the thin file that actually constructs a real
 * admin client and re-exports everything here for application code; the
 * operator CLI (`scripts/gmail-normalize/cli.ts`) imports straight from
 * THIS module instead, because it builds its own `pg`-backed RPC client and
 * has no reason to load a Supabase admin client at all — see External Audit
 * Amendment #1, Finding 1's report for why that split exists: a plain
 * `import "server-only"` module cannot be run from `tsx`/plain Node at all
 * (the `react-server` export condition `server-only` relies on is set by
 * Next.js's bundler, never by a standalone CLI process), so a CLI that
 * transitively imported one could never actually execute.
 *
 * Purely local otherwise: every candidate already lives in
 * `private.gmail_raw_messages`, written by B03. This module makes ZERO
 * Google calls, ZERO OAuth changes and consumes ZERO Gmail quota — there is
 * no lease, no authorization-revision fence and no quota pacer here, because
 * there is no network gap for one to close. The only race this layer has to
 * close is two LOCAL processes computing a projection for the same raw row,
 * or one computing while another commits a new raw snapshot underneath it —
 * and that is closed entirely inside `gmail_normalize_commit_message`'s own
 * short row lock (see 0038 §9b).
 */

export interface NormalizeDeps {
  db: ReturnType<typeof createAdminClient>;
}

/**
 * Reject, do not clamp. Both `batchSize` (this module) and `--limit` (the
 * CLI) previously reached PostgreSQL's `greatest(coalesce(p_limit, 1), 1)`,
 * which silently turned 0, a negative number, `NaN` or a fraction into a
 * request the database could not distinguish from a deliberate `limit 1` —
 * bad input and legitimate input produced the identical query. The true
 * entry point is here, before any RPC call is made.
 */
export function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
  return value;
}

export type NormalizeMessageOutcome =
  | { result: "ok"; normalizedMessageId: string; normalizedThreadId: string }
  | { result: "already_current"; normalizedMessageId: string }
  | { result: "stale_source"; currentPayloadSha256: string }
  | { result: "source_not_found" }
  | { result: "account_deleted" }
  | { result: "not_found" }
  | { result: "structural_error"; message: string };

interface CommitResponse {
  result: string;
  normalized_message_id?: string;
  normalized_thread_id?: string;
  current_payload_sha256?: string;
}

/** Normalize and commit exactly ONE candidate row. */
export async function normalizeOneCandidate(
  deps: NormalizeDeps,
  userId: string,
  candidate: NormalizeCandidate,
): Promise<NormalizeMessageOutcome> {
  let computed;
  try {
    computed = computeNormalization(candidate.sanitized_payload);
  } catch (error) {
    if (error instanceof NormalizationStructuralError) {
      return { result: "structural_error", message: error.message };
    }
    throw error;
  }

  const { data: rawData, error } = await deps.db.rpc("gmail_normalize_commit_message", {
    p_user_id: userId,
    p_mail_account_id: candidate.mail_account_id,
    p_provider_message_id: candidate.provider_message_id,
    p_expected_source_payload_sha256: candidate.payload_sha256,
    p_normalizer_version: GMAIL_NORMALIZER_VERSION,
    p_headers: computed.headers,
    p_participants: computed.participants,
    p_reference_tokens: computed.referenceTokens,
    p_text_parts: computed.textParts,
  });

  if (error || !rawData) {
    throw new Error(`gmail_normalize_commit_message failed: ${error?.message ?? "no data"}`);
  }

  const data = rawData as CommitResponse;

  switch (data.result) {
    case "ok":
      return {
        result: "ok",
        normalizedMessageId: data.normalized_message_id!,
        normalizedThreadId: data.normalized_thread_id!,
      };
    case "already_current":
      return { result: "already_current", normalizedMessageId: data.normalized_message_id! };
    case "stale_source":
      return { result: "stale_source", currentPayloadSha256: data.current_payload_sha256! };
    case "source_not_found":
      return { result: "source_not_found" };
    case "account_deleted":
      return { result: "account_deleted" };
    case "not_found":
      return { result: "not_found" };
    default:
      throw new Error(`gmail_normalize_commit_message returned unknown result: ${data.result}`);
  }
}

interface CandidatesResponse {
  result: string;
  candidates: NormalizeCandidate[];
}

/** One candidate's outcome, kept alongside its identity for forward-progress bookkeeping. */
export interface NormalizeOutcomeRecord {
  providerMessageId: string;
  result: NormalizeMessageOutcome["result"];
}

export interface NormalizeBatchSummary {
  candidatesFound: number;
  committed: number;
  alreadyCurrent: number;
  staleSource: number;
  structuralErrors: number;
  other: number;
  /**
   * Per-candidate outcomes, in the order the candidate list returned them.
   * Consumed by `normalizeMailboxUntilIdle`'s retry/exclusion bookkeeping —
   * never printed by the CLI, which reports counts only (0038's own status
   * philosophy: never a provider id).
   */
  outcomes: NormalizeOutcomeRecord[];
}

function emptyBatchSummary(): NormalizeBatchSummary {
  return {
    candidatesFound: 0,
    committed: 0,
    alreadyCurrent: 0,
    staleSource: 0,
    structuralErrors: 0,
    other: 0,
    outcomes: [],
  };
}

/**
 * Normalize a BOUNDED BATCH of candidates for one mailbox. A candidate is a
 * raw message whose projection is absent, out of date (a different digest) or
 * stale by version — see 0038's `gmail_normalize_list_candidates`.
 */
export async function normalizeBatch(
  deps: NormalizeDeps,
  input: {
    userId: string;
    mailAccountId: string;
    limit: number;
    providerMessageId?: string;
    /** Candidates to skip THIS call — see `gmail_normalize_list_candidates`'s own doc comment. */
    excludeProviderMessageIds?: readonly string[];
  },
): Promise<NormalizeBatchSummary> {
  const limit = requirePositiveInteger(input.limit, "limit");

  const { data: rawData, error } = await deps.db.rpc("gmail_normalize_list_candidates", {
    p_user_id: input.userId,
    p_mail_account_id: input.mailAccountId,
    p_normalizer_version: GMAIL_NORMALIZER_VERSION,
    p_limit: limit,
    p_provider_message_id: input.providerMessageId ?? null,
    p_exclude_provider_message_ids: input.excludeProviderMessageIds ?? [],
  });

  if (error || !rawData) {
    throw new Error(`gmail_normalize_list_candidates failed: ${error?.message ?? "no data"}`);
  }

  const data = rawData as CandidatesResponse;
  const summary = emptyBatchSummary();
  summary.candidatesFound = data.candidates.length;

  for (const candidate of data.candidates) {
    const outcome = await normalizeOneCandidate(deps, input.userId, candidate);
    summary.outcomes.push({
      providerMessageId: candidate.provider_message_id,
      result: outcome.result,
    });
    switch (outcome.result) {
      case "ok":
        summary.committed += 1;
        break;
      case "already_current":
        summary.alreadyCurrent += 1;
        break;
      case "stale_source":
        summary.staleSource += 1;
        break;
      case "structural_error":
        summary.structuralErrors += 1;
        break;
      default:
        summary.other += 1;
    }
  }

  return summary;
}

/** Outcomes that represent forward progress: the candidate leaves the pool. */
const PROGRESS_RESULTS = new Set<NormalizeMessageOutcome["result"]>(["ok", "already_current"]);

/**
 * A single candidate is retried up to this many times within ONE
 * `normalizeMailboxUntilIdle` call before it is excluded for the rest of
 * that call and counted as a give-up. This is what keeps the loop below
 * finite: `gmail_normalize_list_candidates` returns candidates in a FIXED
 * deterministic order, so a permanently-failing message at the front of
 * that order would otherwise occupy every batch forever — both starving
 * every candidate behind it (Case B) and, at `batchSize = 1`, looping
 * without end (Case A). Once a candidate is excluded, the list moves past
 * it; the total number of (iteration, non-progressing candidate) pairs is
 * bounded above by `distinct candidates × MAX_ATTEMPTS_PER_CANDIDATE`, so
 * the loop always terminates. This is a bounded RETRY POLICY scoped to one
 * top-level call, not a persistent quarantine/dead-letter subsystem: nothing
 * about a give-up is written to the database, and the very next call to
 * `normalizeMailboxUntilIdle` (a fresh CLI invocation, say) retries it from
 * zero.
 */
const MAX_ATTEMPTS_PER_CANDIDATE = 5;

export interface NormalizeUntilIdleResult extends NormalizeBatchSummary {
  /**
   * True iff the run terminated because zero stale/missing candidates
   * genuinely remain for this mailbox and normalizer version — never because
   * a batch merely came back smaller than requested. `false` means at least
   * one candidate exhausted its retry budget without normalizing; see
   * `gaveUpCount`. Callers (the CLI included) MUST check this before
   * reporting success — a batch smaller than `batchSize` is not, by itself,
   * evidence of completion.
   */
  completed: boolean;
  /** Candidates that exhausted their retry budget this run without normalizing. Never their identities — counts only. */
  gaveUpCount: number;
}

/** Normalize ALL currently stale/missing projections for a mailbox, in controlled, bounded batches. */
export async function normalizeMailboxUntilIdle(
  deps: NormalizeDeps,
  input: { userId: string; mailAccountId: string; batchSize: number },
): Promise<NormalizeUntilIdleResult> {
  const batchSize = requirePositiveInteger(input.batchSize, "batchSize");

  const total = emptyBatchSummary();
  const attempts = new Map<string, number>();
  const excluded = new Set<string>();
  let gaveUpCount = 0;

  for (;;) {
    const batch = await normalizeBatch(deps, {
      userId: input.userId,
      mailAccountId: input.mailAccountId,
      limit: batchSize,
      excludeProviderMessageIds: [...excluded],
    });

    total.candidatesFound += batch.candidatesFound;
    total.committed += batch.committed;
    total.alreadyCurrent += batch.alreadyCurrent;
    total.staleSource += batch.staleSource;
    total.structuralErrors += batch.structuralErrors;
    total.other += batch.other;
    total.outcomes.push(...batch.outcomes);

    // TRUE IDLE, not a small-batch guess: nothing is left to list, even with
    // this run's give-ups excluded. If nothing was ever excluded, that means
    // zero stale/missing candidates remain at all — genuine completion.
    if (batch.candidatesFound === 0) {
      return { ...total, completed: gaveUpCount === 0, gaveUpCount };
    }

    for (const outcome of batch.outcomes) {
      if (PROGRESS_RESULTS.has(outcome.result)) {
        attempts.delete(outcome.providerMessageId);
        continue;
      }
      // structural_error, stale_source, source_not_found, account_deleted,
      // not_found: none of these are forward progress for THIS candidate.
      // stale_source is TRANSIENT (a concurrent B03 update) and recovers on
      // its own by simply being retried, still bounded by the same cap.
      const attemptCount = (attempts.get(outcome.providerMessageId) ?? 0) + 1;
      attempts.set(outcome.providerMessageId, attemptCount);
      if (attemptCount >= MAX_ATTEMPTS_PER_CANDIDATE) {
        excluded.add(outcome.providerMessageId);
        gaveUpCount += 1;
      }
    }
  }
}
