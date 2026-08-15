/**
 * Exhaustive pagination driver.
 *
 * Brief §10: paginate until completion. Never stop at 100, 500, 1000, the first
 * page, or a convenient sample. If the API cannot demonstrate exhaustion, that
 * is recorded as a COVERAGE RISK rather than quietly reported as a total.
 *
 * The safety limits below are runaway guards, not coverage caps. Hitting one is
 * itself a coverage risk and is reported as such — the distinction matters,
 * because a silent cap and a genuine end-of-data look identical in the output.
 */
import type { PaginationEvidence } from "./types";

export interface PageResult<T> {
  records: T[];
  /** Cursor/offset for the next page, or null when the provider says it is done. */
  nextCursor: string | null;
  /** Provider's own claim about the total, when it supplies one. */
  reportedTotal?: number | null;
}

export interface PaginateOptions {
  method: string;
  documentedHardCap?: number | null;
  /** Runaway guard, NOT a coverage cap. Exceeding it is a recorded risk. */
  maxRequests?: number;
  /** Runaway guard, NOT a coverage cap. Exceeding it is a recorded risk. */
  maxRecords?: number;
}

export interface PaginateResult<T> {
  records: T[];
  evidence: PaginationEvidence;
}

const DEFAULT_MAX_REQUESTS = 10_000;
const DEFAULT_MAX_RECORDS = 1_000_000;

export async function paginateAll<T>(
  fetchPage: (cursor: string | null) => Promise<PageResult<T>>,
  options: PaginateOptions,
): Promise<PaginateResult<T>> {
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;

  const records: T[] = [];
  const coverageRisks: string[] = [];
  const seenCursors = new Set<string>();

  let cursor: string | null = null;
  let requests = 0;
  let pages = 0;
  let reportedTotal: number | null = null;
  let terminatedNaturally = false;

  while (requests < maxRequests && records.length < maxRecords) {
    const page: PageResult<T> = await fetchPage(cursor);
    requests += 1;
    pages += 1;
    records.push(...page.records);

    if (page.reportedTotal !== undefined && page.reportedTotal !== null) {
      reportedTotal = page.reportedTotal;
    }

    if (page.nextCursor === null) {
      terminatedNaturally = true;
      break;
    }

    // A repeated cursor means the provider is looping. Continuing would inflate
    // counts with duplicates and never terminate.
    if (seenCursors.has(page.nextCursor)) {
      coverageRisks.push(
        `Pagination cursor repeated after ${requests} requests; provider may be looping. Extraction stopped and is NOT proven exhaustive.`,
      );
      break;
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;

    // An empty page with a next cursor is legal but suspicious; note it once.
    if (page.records.length === 0) {
      coverageRisks.push(
        `Empty page returned at request ${requests} while a next cursor was still supplied.`,
      );
    }
  }

  if (requests >= maxRequests) {
    coverageRisks.push(
      `Runaway guard hit: ${maxRequests} requests. This is a safety limit, NOT a coverage cap — extraction is incomplete and must be re-run with a raised guard.`,
    );
  }
  if (records.length >= maxRecords) {
    coverageRisks.push(
      `Runaway guard hit: ${maxRecords} records. This is a safety limit, NOT a coverage cap — extraction is incomplete and must be re-run with a raised guard.`,
    );
  }

  if (
    options.documentedHardCap !== null &&
    options.documentedHardCap !== undefined &&
    records.length >= options.documentedHardCap
  ) {
    coverageRisks.push(
      `Record count reached the provider's documented hard cap (${options.documentedHardCap}). The destination universe may exceed what this endpoint can return; a different enumeration strategy is required before any completeness claim.`,
    );
  }

  // Exhaustion is only "proven" when the provider itself said it was done AND
  // nothing suspicious happened along the way. Anything else is a risk.
  let exhaustionProven = terminatedNaturally && coverageRisks.length === 0;

  if (exhaustionProven && reportedTotal !== null && records.length !== reportedTotal) {
    coverageRisks.push(
      `Provider reported a total of ${reportedTotal} but ${records.length} records were retrieved. Exhaustion cannot be claimed while those disagree.`,
    );
    exhaustionProven = false;
  }

  if (!terminatedNaturally && coverageRisks.length === 0) {
    coverageRisks.push("Pagination did not terminate naturally; exhaustion is unproven.");
  }

  return {
    records,
    evidence: {
      requests,
      pages,
      totalRecords: records.length,
      method: options.method,
      documentedHardCap: options.documentedHardCap ?? null,
      reportedTotal,
      exhaustionProven,
      coverageRisks,
    },
  };
}
