/**
 * Persistent daily-quota ledger and cross-process evaluation lock.
 *
 * The in-process `RequestBudget` cannot protect a DAILY provider allowance,
 * because a new process starts with a fresh counter:
 *
 *   run A reaches the provider 30 times → process exits
 *   run B starts fresh → allows another 40
 *   = 70 requests against a 50/day account
 *
 * So provider-reaching requests are recorded on disk, under the gitignored
 * artifact root, and every run reads that history before it starts.
 *
 * ## What counts against the allowance
 *
 * | Outcome | Counts? | Why |
 * |---|---|---|
 * | Cache hit | no | never left the process |
 * | Explicit local egress denial (`x-deny-reason`) | no | demonstrably never reached Hotelbeds |
 * | Provider response (any status) | **yes** | the provider served it |
 * | Provider-reaching retry | **yes** | the provider served that too |
 * | Ambiguous network failure after the request left | **conservatively yes** | see below |
 *
 * An ambiguous failure is one where the request may well have arrived and been
 * counted before the connection died — a reset mid-response, a timeout. We
 * cannot prove the provider did not charge it, and under a 50/day allowance the
 * cost of guessing wrong in the optimistic direction is spending request 51.
 * Such entries are recorded as `provider_reach_unknown` so the report can be
 * honest ("possibly consumed") while the guard stays conservative.
 *
 * Reset semantics: the account documents a 50-request quota resetting every
 * 86 400 s but exposes no authoritative reset timestamp. A **conservative
 * 24-hour rolling window** is used instead — it can only ever under-spend.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { artifactPath } from "../artifacts";

export const LEDGER_FILE = "hotelbeds/quota-ledger.json";
export const LOCK_FILE = "hotelbeds/evaluation.lock";

/** Documented daily allowance for the evaluation account. */
export const DAILY_QUOTA = 50;
/** Conservative rolling window, in milliseconds. */
export const QUOTA_WINDOW_MS = 86_400_000;
/** A lock older than this is presumed abandoned by a crashed process. */
export const LOCK_STALE_MS = 15 * 60_000;

/**
 * Did the request reach the provider?
 *
 * `provider_reach_unknown` exists so an ambiguous failure can protect the
 * allowance without the report claiming a certainty nobody has.
 */
export type ReachStatus = "provider_reached_confirmed" | "provider_reach_unknown";

export interface LedgerEntry {
  /** Epoch ms of the attempt. */
  at: number;
  /** Non-secret credential fingerprint the request was made with. */
  accountFingerprint: string;
  /** HTTP status, or null when no response arrived. */
  status: number | null;
  /** Whether this was a retry of an earlier attempt. */
  retry: boolean;
  reach: ReachStatus;
}

export interface LedgerFile {
  entries: LedgerEntry[];
}

function ledgerPath(root?: string): string {
  return root ? join(root, LEDGER_FILE) : artifactPath(LEDGER_FILE);
}

export function readLedger(root?: string): LedgerFile {
  const path = ledgerPath(root);
  if (!existsSync(path)) return { entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LedgerFile;
    if (!Array.isArray(parsed.entries)) throw new Error("malformed");
    return { entries: parsed.entries };
  } catch {
    // A corrupt ledger must NOT be read as "nothing spent" — that would silently
    // restore the full allowance. Fail closed.
    throw new Error(
      `Quota ledger at ${path} is unreadable. Refusing to proceed: treating a corrupt ledger ` +
        "as an empty one would silently restore the daily allowance. Inspect or delete it deliberately.",
    );
  }
}

function writeLedger(file: LedgerFile, root?: string): void {
  const path = ledgerPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

export interface QuotaSummary {
  quota: number;
  /** Requests we know reached the provider. */
  confirmedInWindow: number;
  /** Requests that may have reached it; counted against the allowance anyway. */
  possiblyConsumedInWindow: number;
  /** confirmed + possibly, i.e. what the guard actually enforces. */
  spentInWindow: number;
  /** Conservative remaining allowance. */
  remainingInWindow: number;
  windowMs: number;
  windowIsConservativeRolling: true;
}

export class QuotaLedger {
  constructor(
    private readonly accountFingerprint: string,
    private readonly options: {
      root?: string;
      quota?: number;
      windowMs?: number;
      now?: () => number;
    } = {},
  ) {}

  private nowMs(): number {
    return (this.options.now ?? Date.now)();
  }

  /** The configured allowance. Exposed so callers never reconstruct it. */
  get quota(): number {
    return this.options.quota ?? DAILY_QUOTA;
  }

  private get windowMs(): number {
    return this.options.windowMs ?? QUOTA_WINDOW_MS;
  }

  entriesInWindow(): LedgerEntry[] {
    const threshold = this.nowMs() - this.windowMs;
    return readLedger(this.options.root).entries.filter(
      (e) => e.accountFingerprint === this.accountFingerprint && e.at >= threshold,
    );
  }

  /**
   * Requests spent in the window.
   *
   * Includes ambiguous attempts: the guard must be conservative even though the
   * report distinguishes them.
   */
  spent(): number {
    return this.entriesInWindow().length;
  }

  confirmed(): number {
    return this.entriesInWindow().filter((e) => e.reach === "provider_reached_confirmed").length;
  }

  possiblyConsumed(): number {
    return this.entriesInWindow().filter((e) => e.reach === "provider_reach_unknown").length;
  }

  remaining(): number {
    return Math.max(0, this.quota - this.spent());
  }

  windowStartsExpiringAt(): number | null {
    const entries = this.entriesInWindow().sort((a, b) => a.at - b.at);
    return entries[0] ? entries[0].at + this.windowMs : null;
  }

  /** Record an attempt that reached, or may have reached, the provider. */
  record(
    status: number | null,
    retry = false,
    reach: ReachStatus = "provider_reached_confirmed",
  ): void {
    const file = readLedger(this.options.root);
    file.entries.push({
      at: this.nowMs(),
      accountFingerprint: this.accountFingerprint,
      status,
      retry,
      reach,
    });
    // Prune entries far outside the window so the file cannot grow forever.
    const threshold = this.nowMs() - this.windowMs * 7;
    file.entries = file.entries.filter((e) => e.at >= threshold);
    writeLedger(file, this.options.root);
  }

  summary(): QuotaSummary {
    return {
      quota: this.quota,
      confirmedInWindow: this.confirmed(),
      possiblyConsumedInWindow: this.possiblyConsumed(),
      spentInWindow: this.spent(),
      remainingInWindow: this.remaining(),
      windowMs: this.windowMs,
      windowIsConservativeRolling: true,
    };
  }
}

export class DailyQuotaExhaustedError extends Error {
  constructor(
    readonly spent: number,
    readonly quota: number,
  ) {
    super(
      `Daily provider quota exhausted: ${spent}/${quota} requests spent against Hotelbeds inside ` +
        `the conservative 24h rolling window. Refusing to make request ${spent + 1}. ` +
        "Cached responses are preserved; resume after the window rolls forward.",
    );
    this.name = "DailyQuotaExhaustedError";
  }
}

export class EvaluationLockedError extends Error {
  constructor(readonly heldBy: LockFile) {
    super(
      `Another Hotelbeds evaluation owns the lock (pid ${heldBy.pid}, acquired at ` +
        `${new Date(heldBy.acquiredAt).toISOString()}). Refusing to run concurrently: two ` +
        "processes both reading 49/50 would both issue request 50. Wait for it to finish, or " +
        "release the lock deliberately if that process is known to be gone.",
    );
    this.name = "EvaluationLockedError";
  }
}

export interface LockFile {
  pid: number;
  acquiredAt: number;
  accountFingerprint: string;
}

function lockPath(root?: string): string {
  return root ? join(root, LOCK_FILE) : artifactPath(LOCK_FILE);
}

/**
 * Cross-process lock for live Hotelbeds evaluation.
 *
 * Deliberately simple: one lock file per artifact root, written with `wx` so
 * creation is atomic. This is not distributed locking — it only has to stop two
 * evaluator processes on one machine from racing the quota check.
 *
 * Stale recovery is explicit rather than automatic-and-silent: a lock older than
 * `LOCK_STALE_MS` is reported as stale and reclaimed, with the age logged, so an
 * abandoned lock never wedges the evaluation forever but a *live* one is never
 * stolen from a working process.
 */
export class EvaluationLock {
  private held = false;

  constructor(
    private readonly accountFingerprint: string,
    private readonly options: { root?: string; now?: () => number; staleMs?: number } = {},
  ) {}

  private nowMs(): number {
    return (this.options.now ?? Date.now)();
  }

  private get staleMs(): number {
    return this.options.staleMs ?? LOCK_STALE_MS;
  }

  read(): LockFile | null {
    const path = lockPath(this.options.root);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as LockFile;
    } catch {
      // An unparseable lock is treated as stale: it cannot identify an owner.
      return null;
    }
  }

  /** Acquire, or throw. Returns a note when a stale lock was reclaimed. */
  acquire(pid = process.pid): { reclaimedStaleLock: boolean } {
    const path = lockPath(this.options.root);
    mkdirSync(dirname(path), { recursive: true });

    const existing = this.read();
    let reclaimedStaleLock = false;

    if (existing) {
      const age = this.nowMs() - existing.acquiredAt;
      if (age < this.staleMs) throw new EvaluationLockedError(existing);
      // Older than the stale threshold: presume the owner crashed.
      reclaimedStaleLock = true;
      rmSync(path, { force: true });
    }

    const payload: LockFile = {
      pid,
      acquiredAt: this.nowMs(),
      accountFingerprint: this.accountFingerprint,
    };
    try {
      // `wx` fails if another process created the file in the meantime.
      writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch {
      const winner = this.read();
      if (winner) throw new EvaluationLockedError(winner);
      throw new Error(`Could not acquire the Hotelbeds evaluation lock at ${path}.`);
    }

    this.held = true;
    return { reclaimedStaleLock };
  }

  release(): void {
    if (!this.held) return;
    rmSync(lockPath(this.options.root), { force: true });
    this.held = false;
  }
}
