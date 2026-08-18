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
  dateFrom: string | null;
  dateTo: string | null;
  providerOrder: number | null;
  alternative: boolean | null;
  description: string | null;
}

/** One property's complete issue extraction, keyed by the provider's own id. */
export interface ExtractedIssueSnapshot {
  sourcePropertyId: string;
  providerIssueCount: number;
  payloadDigest: string;
  issues: ExtractedIssue[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

/**
 * A provider date, kept only when it is shaped like one.
 *
 * A value that is not `YYYY-MM-DD` becomes NULL rather than being coerced —
 * and NULL on a MAPPED closure is exactly what makes the evaluation
 * `unresolved`. Nothing is discarded quietly: the row is still written, so the
 * defect stays visible.
 */
function asProviderDate(value: unknown): string | null {
  const s = asString(value);
  if (s === null) return null;
  const head = s.length > 10 ? s.slice(0, 10) : s;
  return ISO_DATE.test(head) ? head : null;
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
 * Hotelbeds returns `issueCode`/`issueType` as plain strings in the cached
 * payloads, but the same API renders several other vocabularies as objects, so
 * both shapes are accepted rather than assumed. An unreadable code is skipped:
 * an issue whose vocabulary we cannot name cannot be matched against a policy,
 * and inventing a placeholder would let it collide with a real code.
 */
function providerCode(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (value !== null && typeof value === "object" && "code" in value) {
    return asString((value as { code: unknown }).code);
  }
  return null;
}

/** The one place that knows Hotelbeds' issue shape. */
export function extractIssuesFromRecord(raw: unknown): ExtractedIssueSnapshot | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const sourcePropertyId = asString(record.code);
  if (sourcePropertyId === null) return null;

  // A MISSING KEY IS A COMPLETE ANSWER, an unreadable one is not.
  //
  // `issues` absent means the provider reported none, and the extraction is
  // complete with zero rows. `issues` present but not an array means we do not
  // understand this record, so no snapshot is produced and the property stays
  // `unresolved` — the honest outcome, rather than a confident zero.
  const rawIssues = record.issues;
  if (rawIssues !== undefined && !Array.isArray(rawIssues)) return null;
  const list = Array.isArray(rawIssues) ? rawIssues : [];

  const issues: ExtractedIssue[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const issue = entry as Record<string, unknown>;
    const issueCode = providerCode(issue.issueCode ?? issue.code);
    const issueType = providerCode(issue.issueType ?? issue.type);
    if (issueCode === null || issueType === null) continue;
    issues.push({
      issueCode,
      issueType,
      dateFrom: asProviderDate(issue.dateFrom),
      dateTo: asProviderDate(issue.dateTo),
      providerOrder: asInteger(issue.order),
      alternative: asBoolean(issue.alternative),
      description: asString(issue.description),
    });
  }

  return {
    sourcePropertyId,
    // What the PROVIDER supplied, not what we successfully parsed. If those
    // differ the count says so, and a reviewer can see that something was
    // dropped instead of the difference vanishing.
    providerIssueCount: list.length,
    payloadDigest: digestValue(rawIssues ?? null),
    issues,
  };
}

/** Every property in one cached destination artifact. */
export async function extractDestinationIssues(
  destinationSlug: string,
  repoRoot: string,
): Promise<ExtractedIssueSnapshot[]> {
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

  const out: ExtractedIssueSnapshot[] = [];
  const seen = new Set<string>();
  for (const raw of payloads) {
    const snapshot = extractIssuesFromRecord(raw);
    if (snapshot === null) continue;
    // The ingestion writer already treats a repeated provider id within one
    // artifact as one property; the same rule here keeps the two in step.
    if (seen.has(snapshot.sourcePropertyId)) continue;
    seen.add(snapshot.sourcePropertyId);
    out.push(snapshot);
  }
  return out;
}
