/**
 * WRITE-TARGET SAFETY for A05 publication.
 *
 * A05 inverts A04.5's posture, and the inversion is the point.
 *
 *   A04.5/A04.6 write REVIEW EVIDENCE, which is pilot data about the evaluation
 *   corpus. Those paths are local-only and evaluation-only: writing them to a
 *   real database would be the mistake.
 *
 *   A05 writes CANONICAL INVENTORY. A real publication belongs in the real
 *   persistent database, and running one against a disposable local database
 *   would produce a hotel nobody can see and a receipt nobody can audit.
 *
 * So a real `--apply` reuses `assertPersistentApplyTarget` — the import apply
 * CLI's existing definition of "a deliberate remote persistent database", which
 * requires an explicit `DATABASE_URL` and NEVER falls back to
 * `TEST_DATABASE_URL`. There is deliberately no second definition of "the
 * production database" in this repository.
 *
 * TWO DIFFERENT CONCEPTS, and confusing them is how evaluation data reaches
 * canonical inventory:
 *
 *   DATABASE DEPLOYMENT TARGET   where the rows are written
 *   PROVIDER source_environment  whose evidence they describe
 *
 * This module governs the first. The second is governed by the hard wall in
 * `publish.ts`, by 0027's `hotel_source_identities_production_only` and
 * `source_property_identities_eligible_is_production`, and by 0034's
 * `source_property_publication_receipts_production_only` — none of which is
 * relaxed because a test database happens to be local.
 */
import {
  assertPersistentApplyTarget,
  classifyDatabaseUrl,
  type TargetClassification,
} from "../../src/lib/import/preflight";

export class PublicationTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationTargetError";
  }
}

export interface PublicationTarget {
  url: string;
  classification: TargetClassification;
}

/**
 * Resolve the database a publication command may use.
 *
 * `apply: false` — prepare and dry-run. Read-only in effect (the dry-run rolls
 * back), so any classifiable target is valid, including a disposable local one.
 *
 * `apply: true` — a real canonical publication. Delegated to
 * `assertPersistentApplyTarget`, unchanged and unwrapped.
 */
export function resolvePublicationTarget(
  env: Record<string, string | undefined>,
  args: { apply: boolean },
): PublicationTarget {
  if (args.apply) {
    try {
      return assertPersistentApplyTarget(env);
    } catch (error) {
      throw new PublicationTargetError(
        `${error instanceof Error ? error.message : String(error)} A05 publishes canonical inventory; there is deliberately no flag to force one into a disposable database.`,
      );
    }
  }

  const url = env.DATABASE_URL?.trim() || env.TEST_DATABASE_URL?.trim();
  if (!url)
    throw new PublicationTargetError(
      "No publication database configured; set DATABASE_URL (or TEST_DATABASE_URL for a dry-run against a disposable database).",
    );
  const classification = classifyDatabaseUrl(url);
  if (classification.hostClass === "unknown" && !/(^|[?&])host=\//.test(url))
    throw new PublicationTargetError(
      `Cannot classify the publication database (${classification.redactedTarget}). A target we cannot classify is not a target we may read a publication decision out of either.`,
    );
  return { url, classification };
}
