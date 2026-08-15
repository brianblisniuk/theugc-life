/**
 * Persistent daily-quota ledger.
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
 * What counts, and what does not:
 *
 *  - **counted**: successful provider calls, provider 4xx/5xx responses, and
 *    provider-reaching retries — the provider charged us for all of them;
 *  - **not counted**: cache hits, and local egress denials that never reached
 *    the provider. Neither consumed provider allowance.
 *
 * Reset semantics: the account documents a 50-request quota resetting every
 * 86 400 s, but exposes no authoritative reset timestamp. A **conservative
 * 24-hour rolling window** is used instead — it can only ever under-spend the
 * allowance, never over-spend it, which is the correct direction to be wrong.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { artifactPath } from "../artifacts";

export const LEDGER_FILE = "hotelbeds/quota-ledger.json";

/** Documented daily allowance for the evaluation account. */
export const DAILY_QUOTA = 50;
/** Conservative rolling window, in milliseconds. */
export const QUOTA_WINDOW_MS = 86_400_000;

export interface LedgerEntry {
  /** Epoch ms when the request reached the provider. */
  at: number;
  /** Non-secret credential fingerprint the request was made with. */
  accountFingerprint: string;
  /** HTTP status, or null when the response never arrived. */
  status: number | null;
  /** Whether this was a retry of an earlier attempt. */
  retry: boolean;
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
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    // A corrupt ledger must NOT be read as "no requests spent" — that would
    // silently restore the full allowance. Fail closed by treating it as full.
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

/**
 * Tracks provider-reaching requests across process boundaries.
 *
 * Scoped by account fingerprint so a different credential gets its own
 * allowance rather than inheriting another account's spend.
 */
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

  /** Current epoch ms, injectable for deterministic tests. */
  private nowMs(): number {
    return (this.options.now ?? Date.now)();
  }

  private get quota(): number {
    return this.options.quota ?? DAILY_QUOTA;
  }

  private get windowMs(): number {
    return this.options.windowMs ?? QUOTA_WINDOW_MS;
  }

  /** Entries for this account inside the active rolling window. */
  entriesInWindow(): LedgerEntry[] {
    const threshold = this.nowMs() - this.windowMs;
    return readLedger(this.options.root).entries.filter(
      (e) => e.accountFingerprint === this.accountFingerprint && e.at >= threshold,
    );
  }

  /** Provider requests already spent in the active window. */
  spent(): number {
    return this.entriesInWindow().length;
  }

  /** Provider requests still available in the active window. */
  remaining(): number {
    return Math.max(0, this.quota - this.spent());
  }

  /** Oldest in-window entry, i.e. when allowance starts returning. */
  windowStartsExpiringAt(): number | null {
    const entries = this.entriesInWindow().sort((a, b) => a.at - b.at);
    return entries[0] ? entries[0].at + this.windowMs : null;
  }

  /** Record a request that actually reached the provider. */
  record(status: number | null, retry = false): void {
    const file = readLedger(this.options.root);
    file.entries.push({
      at: this.nowMs(),
      accountFingerprint: this.accountFingerprint,
      status,
      retry,
    });
    // Prune entries far outside the window so the file cannot grow forever.
    const threshold = this.nowMs() - this.windowMs * 7;
    file.entries = file.entries.filter((e) => e.at >= threshold);
    writeLedger(file, this.options.root);
  }

  summary(): {
    quota: number;
    spentInWindow: number;
    remainingInWindow: number;
    windowMs: number;
    windowIsConservativeRolling: true;
  } {
    return {
      quota: this.quota,
      spentInWindow: this.spent(),
      remainingInWindow: this.remaining(),
      windowMs: this.windowMs,
      // Flagged in the output so nobody mistakes it for the account's real reset.
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
      `Daily provider quota exhausted: ${spent}/${quota} requests already reached Hotelbeds inside ` +
        "the conservative 24h rolling window. Refusing to make request " +
        `${spent + 1}. Cached responses are preserved; resume after the window rolls forward.`,
    );
    this.name = "DailyQuotaExhaustedError";
  }
}
