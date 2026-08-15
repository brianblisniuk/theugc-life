/**
 * Hotelbeds request-budget guard and rate pacer.
 *
 * The evaluation account allows **50 requests per day** and 8 requests per 4
 * seconds. That makes request count a first-class correctness concern rather
 * than an optimisation: a careless loop does not merely run slowly, it destroys
 * a day of evaluation capacity and there is no way to buy it back.
 *
 * Design consequences:
 *
 *  - the budget is checked BEFORE a request is attempted, never after;
 *  - every ATTEMPT counts, including retries and failures, because the provider
 *    counts them too;
 *  - an authentication failure stops everything immediately — hammering a
 *    rejected credential burns the day's quota for no information;
 *  - a quota error is terminal and recorded distinctly, so a resumed run knows
 *    it was cut off rather than finished.
 */

export type BudgetStopReason =
  | "budget_exhausted"
  | "authentication_failed"
  | "blocked_by_daily_quota"
  | "egress_blocked"
  | "fatal_error";

export class BudgetExceededError extends Error {
  constructor(
    readonly spent: number,
    readonly limit: number,
  ) {
    super(
      `Request budget exhausted: ${spent}/${limit} requests already attempted. ` +
        "Stopping BEFORE exceeding it. The extraction is INCOMPLETE, not complete.",
    );
    this.name = "BudgetExceededError";
  }
}

/**
 * The request never reached the provider — a local network policy refused it.
 *
 * This MUST NOT be reported as an authentication failure. A proxy denial says
 * nothing whatsoever about whether the credentials are valid, and it consumes no
 * provider quota. Collapsing the two would both slander a working credential and
 * mis-state the remaining daily allowance.
 */
export class EgressBlockedError extends Error {
  constructor(
    readonly host: string,
    readonly denyReason: string,
  ) {
    super(
      `EGRESS_BLOCKED: the local network policy refused a connection to ${host} (${denyReason}). ` +
        "The request never reached the provider, so no provider quota was consumed and the " +
        "credentials remain UNTESTED — this is not an authentication failure.",
    );
    this.name = "EgressBlockedError";
  }
}

export class AuthenticationFailedError extends Error {
  constructor(readonly status: number) {
    super(
      `Authentication failed (HTTP ${status}). Stopping immediately without retry — ` +
        "repeatedly retrying a rejected credential burns the daily quota for no information.",
    );
    this.name = "AuthenticationFailedError";
  }
}

export class DailyQuotaError extends Error {
  constructor(readonly status: number) {
    super(
      `BLOCKED_BY_DAILY_QUOTA (HTTP ${status}). The provider's daily allowance is spent; ` +
        "stopping. Cached responses are preserved so the next run can resume after reset.",
    );
    this.name = "DailyQuotaError";
  }
}

export interface BudgetOptions {
  /** Hard ceiling on ATTEMPTED provider requests in this execution. */
  maxRequests: number;
  /** Minimum milliseconds between request starts. */
  minIntervalMs: number;
  /** Injectable for deterministic tests. Defaults to real time/sleep. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface BudgetState {
  /** Requests this run attempted locally, including those the proxy refused. */
  attempted: number;
  /**
   * Requests that actually reached the provider.
   *
   * This is the number that matters for the 50/day quota. An egress-blocked
   * attempt costs local budget but no provider allowance.
   */
  providerReached: number;
  succeeded: number;
  failed: number;
  retries: number;
  cacheHits: number;
  limit: number;
  stopped: boolean;
  stopReason: BudgetStopReason | null;
}

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tracks and enforces the request budget.
 *
 * Cache hits are counted separately and deliberately do NOT consume budget —
 * that is the whole point of the cache under a 50/day quota.
 */
export class RequestBudget {
  private attempted = 0;
  private providerReached = 0;
  private succeeded = 0;
  private failed = 0;
  private retries = 0;
  private cacheHits = 0;
  private stopped = false;
  private stopReason: BudgetStopReason | null = null;
  private lastRequestStartedAt: number | null = null;

  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: BudgetOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? DEFAULT_SLEEP;
  }

  get state(): BudgetState {
    return {
      attempted: this.attempted,
      providerReached: this.providerReached,
      succeeded: this.succeeded,
      failed: this.failed,
      retries: this.retries,
      cacheHits: this.cacheHits,
      limit: this.options.maxRequests,
      stopped: this.stopped,
      stopReason: this.stopReason,
    };
  }

  get remaining(): number {
    return Math.max(0, this.options.maxRequests - this.attempted);
  }

  recordCacheHit(): void {
    this.cacheHits += 1;
  }

  /** True when another request may be attempted. */
  canAttempt(): boolean {
    return !this.stopped && this.attempted < this.options.maxRequests;
  }

  stop(reason: BudgetStopReason): void {
    this.stopped = true;
    this.stopReason = reason;
  }

  /**
   * Reserve one request slot, pacing if necessary.
   *
   * Throws BEFORE the request happens when the budget is spent, so the ceiling
   * can never be exceeded by one "just this last page".
   */
  async reserve(isRetry = false): Promise<void> {
    if (this.stopped) {
      throw new BudgetExceededError(this.attempted, this.options.maxRequests);
    }
    if (this.attempted >= this.options.maxRequests) {
      this.stop("budget_exhausted");
      throw new BudgetExceededError(this.attempted, this.options.maxRequests);
    }

    // Pace against the provider's documented burst allowance.
    if (this.lastRequestStartedAt !== null) {
      const elapsed = this.now() - this.lastRequestStartedAt;
      const wait = this.options.minIntervalMs - elapsed;
      if (wait > 0) await this.sleep(wait);
    }

    this.lastRequestStartedAt = this.now();
    this.attempted += 1;
    // A retry is an attempt like any other: the provider counted it.
    if (isRetry) this.retries += 1;
  }

  /** Mark that a request actually reached the provider (quota was consumed). */
  recordProviderReached(): void {
    this.providerReached += 1;
  }

  recordSuccess(): void {
    this.succeeded += 1;
  }

  recordFailure(): void {
    this.failed += 1;
  }
}

/** Which HTTP statuses are worth one bounded retry. */
export function isTransientStatus(status: number): boolean {
  // 429 is deliberately NOT retried here: under a 50/day quota, a rate-limit
  // response means back off and stop, not try again immediately.
  return status === 502 || status === 503 || status === 504;
}

/** Statuses that must stop the run immediately, with the reason to record. */
export function terminalReasonFor(status: number): BudgetStopReason | null {
  if (status === 401 || status === 403) return "authentication_failed";
  if (status === 429) return "blocked_by_daily_quota";
  return null;
}
