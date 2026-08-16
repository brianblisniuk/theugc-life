/**
 * Database target safety for this block.
 *
 * There is no production ingestion mode yet, so there is deliberately no
 * override flag to reach one. Apply is permitted ONLY against a disposable
 * local/test database, and the refusal is not bypassable from the CLI.
 *
 * Host classification is reused from `src/lib/import/preflight.ts` rather than
 * reimplemented — the import pipeline already had to decide what "remote" means,
 * and two answers to that question is one too many.
 */
import { classifyDatabaseUrl, type TargetClassification } from "../../src/lib/import/preflight";

export class UnsafeIngestionTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeIngestionTargetError";
  }
}

export interface IngestionTarget {
  url: string;
  classification: TargetClassification;
}

/**
 * Resolve the apply target, or refuse.
 *
 * Reads `TEST_DATABASE_URL` first — the disposable database the rest of the
 * repo's DB tests already use — and falls back to `DATABASE_URL` only to
 * CLASSIFY it, so that pointing this command at a hosted database produces an
 * explicit refusal rather than a confusing "not configured".
 */
export function resolveIngestionTarget(env: Record<string, string | undefined>): IngestionTarget {
  const testUrl = env.TEST_DATABASE_URL?.trim();
  const dbUrl = env.DATABASE_URL?.trim();
  const url = testUrl || dbUrl;

  if (!url) {
    throw new UnsafeIngestionTargetError(
      "No database configured. Set TEST_DATABASE_URL to a disposable local Postgres. " +
        "This block does not write to any persistent or hosted database.",
    );
  }

  const classification = classifyDatabaseUrl(url);

  if (classification.isRemote) {
    throw new UnsafeIngestionTargetError(
      `Refusing to ingest into a remote target (${classification.redactedTarget}). ` +
        "Provider ingestion is evaluation-only and local-only in this block: there is no " +
        "production ingestion mode, and deliberately no flag to force one.",
    );
  }

  // "unknown" covers a connection string we could not parse a host out of.
  // A target we cannot classify is not a target we may write to.
  if (classification.hostClass === "unknown" && !isLocalSocketUrl(url)) {
    throw new UnsafeIngestionTargetError(
      `Refusing to ingest into an unclassifiable target (${classification.redactedTarget}). ` +
        "Use an explicit local host, or a local unix socket.",
    );
  }

  return { url, classification };
}

/**
 * A libpq unix-socket DSN (`host=/var/run/postgresql`) has no network host, so
 * the URL classifier reports `unknown`. A socket path is definitionally on this
 * machine, so it is accepted — but only when the host really is a filesystem
 * path, never as a general escape from `unknown`.
 */
export function isLocalSocketUrl(url: string): boolean {
  const match = /[?&]host=([^&]+)/.exec(url) ?? /(?:^|\s)host=([^\s]+)/.exec(url);
  const host = match?.[1] ? decodeURIComponent(match[1]) : null;
  return host !== null && host.startsWith("/");
}
