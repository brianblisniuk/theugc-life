/**
 * Extract provider issue evidence from the SAME cached artifacts PR #23–#27 used.
 *
 * ZERO network calls, zero credentials, zero new provider surface. Every byte
 * this reads is already on disk, and it is the same file the observations were
 * built from — which is what lets a snapshot claim to describe THAT observation.
 *
 * BINDING, AND WHY IT IS NOT BY NAME
 * ----------------------------------
 * A snapshot is attached to `(identity, observation)` resolved from the
 * provider's own id within a known run. Matching on hotel name or email would
 * attach evidence to whichever property happened to share a string — and this
 * dataset has 47 properties on one phone number and two different Rotana
 * properties whose names contain one another. Provenance is the provider id,
 * the run, and nothing else.
 *
 * COMPLETENESS, AND WHY IT IS A ROW
 * ---------------------------------
 * Hotelbeds OMITS `issues` entirely when a property has none: 3,936 of the 4,110
 * cached records have no such key, and NOT ONE has an empty array. So "the array
 * was empty" is not an observable state, and a child table alone could never
 * separate "the provider reported nothing" from "nobody extracted this".
 *
 * A snapshot row therefore means: WE PROCESSED THIS PROPERTY'S COMPLETE PROVIDER
 * RECORD. `providerIssueCount = 0` is then a real provider statement, and the
 * absence of a snapshot is ignorance, which the evaluator reports as
 * `unresolved` rather than as "no known closure".
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { digestValue } from "../provider-ingestion/digest";
import { HOTELBEDS_CACHED_SELECTIONS } from "../provider-ingestion/manifest";

/** One provider issue, structurally, exactly as the provider stated it. */
export interface ExtractedIssue {
  issueCode: string;
  issueType: string;
  /** The provider's bytes, VERBATIM. Never coerced, never trimmed to fit. */
  dateFromRaw: string | null;
  dateToRaw: string | null;
  providerOrder: number | null;
  alternative: boolean | null;
  description: string | null;
}

/** One property's complete issue extraction, keyed by the provider's own id. */
export interface ExtractedIssueSnapshot {
  sourcePropertyId: string;
  providerIssueCount: number;
  /**
   * Digest of the WHOLE provider record, matching what the ingestion adapter
   * wrote to `source_property_observations.source_payload_digest`. This is the
   * provenance boundary: it names the exact record, so the snapshot can be
   * bound to the observation THAT record produced rather than to whichever
   * observation happens to be newest.
   */
  wholeRecordPayloadDigest: string;
  issues: ExtractedIssue[];
}

/** Why one provider record could not be extracted completely. */
export interface ExtractionFailure {
  sourcePropertyId: string | null;
  reason:
    | "unreadable_record"
    | "missing_source_property_id"
    | "issues_not_an_array"
    | "unreadable_issue_entry"
    | "unreadable_issue_code"
    | "unreadable_issue_type";
  /** Index within the provider's own array, and its `order` when supplied. */
  issueIndex: number | null;
  providerOrder: number | null;
}

export interface ExtractionOutcome {
  snapshots: ExtractedIssueSnapshot[];
  /** Records that produced NO snapshot. Reported, never silently dropped. */
  failures: ExtractionFailure[];
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

/**
 * A provider date, kept EXACTLY as the provider sent it.
 *
 * Nothing is validated, trimmed, sliced or coerced here, and that is the whole
 * point. The previous version sliced anything longer than ten characters to its
 * first ten, which turned `2026-08-31garbage` into a clean `2026-08-31` — a
 * confident closure window built from a value the provider never sent in that
 * form. And a shape check here would map `2026-02-31` to NULL, making an
 * impossible date indistinguishable from an absent one.
 *
 * VALIDATION BELONGS TO THE EVALUATOR, which can tell "absent" from "present and
 * unreadable" and report them as different reasons. A non-string is NULL because
 * there are no bytes to keep; a string is kept whole.
 */
function providerDateRaw(value: unknown): string | null {
  return typeof value === "string" ? value : value === null ? null : asString(value);
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * Read a provider code that may be a bare string or a `{ code }` object.
 *
 * A PROVIDER CODE IS AN IDENTIFIER, NOT USER TEXT, so it is NOT trimmed.
 * Trimming would turn `"HOTEL "` — malformed, unreviewed provider evidence —
 * into the approved `HOTEL`, and hand it the one mapping that closes a
 * property. The same class of silent repair was already closed in star and
 * scope resolution, and it is closed here for the same reason: repairing an
 * identifier invents a provider statement.
 *
 * `"HOTEL "` therefore matches nothing, and stays visible in the evidence as
 * exactly what the provider sent.
 *
 * Hotelbeds returns these as plain strings in the cached payloads, but the same
 * API renders other vocabularies as `{ code }` objects, so both shapes are read
 * rather than assumed. A value that is not a non-empty string is UNREADABLE,
 * and an unreadable code makes the whole snapshot incomplete — see below.
 */
function providerCode(value: unknown): string | null {
  if (typeof value === "string") return value === "" ? null : value;
  if (value !== null && typeof value === "object" && "code" in value) {
    const inner = (value as { code: unknown }).code;
    if (typeof inner === "string") return inner === "" ? null : inner;
    if (typeof inner === "number") return String(inner);
  }
  return null;
}

/**
 * The one place that knows Hotelbeds' issue shape.
 *
 * Returns EITHER a complete snapshot OR a failure, never a partial snapshot.
 *
 * THE STRUCTURAL INVARIANT
 * -----------------------
 * A COMPLETE snapshot means every provider issue entry was structurally
 * represented — `providerIssueCount` equals `issues.length`, always.
 *
 * The earlier version skipped entries it could not read and still called the
 * result complete, which made this state representable: provider count 1, child
 * rows 0, snapshot complete. The evaluator, seeing a complete snapshot with no
 * mapped closure, would then answer `no_known_closure` about a property whose
 * only provider issue nobody understood. If that unread entry was
 * `HOTEL`/`CLOSED`, a closed hotel reads as clean.
 *
 * So the conservative rule that already governed a non-array `issues` value now
 * governs malformed entries INSIDE the array: no snapshot, an explicit failure,
 * and the property evaluates `unresolved`.
 */
export function extractIssuesFromRecord(
  raw: unknown,
):
  | { snapshot: ExtractedIssueSnapshot; failure: null }
  | { snapshot: null; failure: ExtractionFailure } {
  const fail = (
    reason: ExtractionFailure["reason"],
    sourcePropertyId: string | null,
    issueIndex: number | null = null,
    providerOrder: number | null = null,
  ) =>
    ({ snapshot: null, failure: { sourcePropertyId, reason, issueIndex, providerOrder } }) as const;

  if (raw === null || typeof raw !== "object") return fail("unreadable_record", null);
  const record = raw as Record<string, unknown>;
  const sourcePropertyId = asString(record.code);
  if (sourcePropertyId === null) return fail("missing_source_property_id", null);

  // A MISSING KEY IS A COMPLETE ANSWER, an unreadable one is not.
  //
  // `issues` absent means the provider reported none, and the extraction is
  // complete with zero rows. `issues` present but not an array means we do not
  // understand this record, so no snapshot is produced and the property stays
  // `unresolved` — the honest outcome, rather than a confident zero.
  const rawIssues = record.issues;
  if (rawIssues !== undefined && !Array.isArray(rawIssues)) {
    return fail("issues_not_an_array", sourcePropertyId);
  }
  const list = Array.isArray(rawIssues) ? rawIssues : [];

  const issues: ExtractedIssue[] = [];
  for (const [index, entry] of list.entries()) {
    if (entry === null || typeof entry !== "object") {
      return fail("unreadable_issue_entry", sourcePropertyId, index);
    }
    const issue = entry as Record<string, unknown>;
    const order = asInteger(issue.order);
    const issueCode = providerCode(issue.issueCode ?? issue.code);
    if (issueCode === null) {
      return fail("unreadable_issue_code", sourcePropertyId, index, order);
    }
    const issueType = providerCode(issue.issueType ?? issue.type);
    if (issueType === null) {
      return fail("unreadable_issue_type", sourcePropertyId, index, order);
    }
    issues.push({
      issueCode,
      issueType,
      dateFromRaw: providerDateRaw(issue.dateFrom),
      dateToRaw: providerDateRaw(issue.dateTo),
      providerOrder: order,
      alternative: asBoolean(issue.alternative),
      description: asString(issue.description),
    });
  }

  return {
    snapshot: {
      sourcePropertyId,
      // Equal to `issues.length` by construction — every entry either produced a
      // row or aborted the whole record above. The count is still carried
      // separately so the database can be checked against it (see the
      // evaluator's `issue_count_mismatch`), which is a defence against a row
      // written by some future writer, or by hand.
      providerIssueCount: list.length,
      // The WHOLE record, not `issues[]`. Two provider runs can agree about the
      // issues and differ everywhere else, so a digest of the issues alone does
      // not identify the record this evidence came from.
      wholeRecordPayloadDigest: digestValue(raw),
      issues,
    },
    failure: null,
  };
}

/** Every property in one cached destination artifact. */
export async function extractDestinationIssues(
  destinationSlug: string,
  repoRoot: string,
): Promise<ExtractionOutcome> {
  const selection = HOTELBEDS_CACHED_SELECTIONS[destinationSlug];
  if (!selection) {
    throw new Error(
      `No cached artifact selection for ${destinationSlug}. This command reads only artifacts ` +
        "already in the repository and makes no provider request.",
    );
  }
  const payloads = JSON.parse(
    await readFile(path.resolve(repoRoot, selection.rawProperties), "utf8"),
  ) as unknown[];

  const snapshots: ExtractedIssueSnapshot[] = [];
  const failures: ExtractionFailure[] = [];
  const seen = new Set<string>();
  for (const raw of payloads) {
    const { snapshot, failure } = extractIssuesFromRecord(raw);
    if (failure !== null) {
      failures.push(failure);
      continue;
    }
    // The ingestion writer already treats a repeated provider id within one
    // artifact as one property; the same rule here keeps the two in step.
    if (seen.has(snapshot.sourcePropertyId)) continue;
    seen.add(snapshot.sourcePropertyId);
    snapshots.push(snapshot);
  }
  return { snapshots, failures };
}
