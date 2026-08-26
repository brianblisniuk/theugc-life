/**
 * WRITE-TARGET SAFETY for A04.5 review applies.
 *
 * The A04 preview is read-only and may therefore inspect a hosted database. A
 * review apply WRITES, so it inherits the stricter posture the ingestion writer
 * already established: evaluation-only, local-only, and no override flag.
 *
 * Host classification and the unix-socket rule are reused from
 * `scripts/provider-ingestion/db-target.ts` rather than reimplemented. Two
 * answers to "what counts as local?" is one too many, and the second one is
 * always the one that is wrong when it matters.
 */
import { classifyDatabaseUrl, type TargetClassification } from "../../src/lib/import/preflight";
import { isLocalSocketUrl } from "../provider-ingestion/db-target";

export class UnsafeReviewTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeReviewTargetError";
  }
}

export interface ReviewTarget {
  url: string;
  classification: TargetClassification;
}

/**
 * Host classes a review apply may write to. `container-bridge` is deliberately
 * absent: the import preflight documents it as an alias that reaches the
 * DEVELOPER HOST's Postgres from inside a container, which is exactly the
 * persistent database this command must never touch.
 */
const WRITABLE_HOST_CLASSES = new Set(["loopback", "localhost", "local-supabase"]);

export function resolveReviewWriteTarget(
  env: Record<string, string | undefined>,
  args: { environment: string; apply: boolean },
): ReviewTarget {
  const url = env.TEST_DATABASE_URL?.trim() || env.DATABASE_URL?.trim();
  if (!url)
    throw new UnsafeReviewTargetError(
      "No review database configured. Set TEST_DATABASE_URL (or DATABASE_URL) to a disposable local Postgres.",
    );

  if (args.environment !== "evaluation")
    throw new UnsafeReviewTargetError(
      `--environment ${args.environment} is refused. A04.5 records human review evidence for \`evaluation\` only; production ingestion does not exist yet, so a production review would be a decision about nothing.`,
    );

  const classification = classifyDatabaseUrl(url);

  // A dry-run reads only, so it may inspect anything classifiable. Everything
  // below this line is about WRITES.
  if (!args.apply) {
    if (classification.hostClass === "unknown" && !isLocalSocketUrl(url))
      throw new UnsafeReviewTargetError(
        `Cannot classify the review database (${classification.redactedTarget}). A target we cannot classify is not a target we may read a decision out of either.`,
      );
    return { url, classification };
  }

  if (classification.isRemote)
    throw new UnsafeReviewTargetError(
      `Refusing to --apply human review evidence to a remote target (${classification.redactedTarget}). A04.5 writes are local-only and evaluation-only, and there is deliberately no flag to force one.`,
    );

  const socketIsLocal = classification.hostClass === "unknown" && isLocalSocketUrl(url);
  if (!WRITABLE_HOST_CLASSES.has(classification.hostClass) && !socketIsLocal)
    throw new UnsafeReviewTargetError(
      `Refusing to --apply to a ${classification.hostClass} target (${classification.redactedTarget}). Permitted: a loopback/localhost/local-supabase host, or a local unix socket. There is no override.`,
    );

  return { url, classification };
}
