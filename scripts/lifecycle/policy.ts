/**
 * Pre-publication lifecycle evaluation.
 *
 * ONE QUESTION, AND IT HAS A DATE IN IT
 * ------------------------------------
 *
 *   Does the latest COMPLETE provider evidence contain a CURRENT property-level
 *   closure window for this source property, AS OF an explicit date?
 *
 * Not "is the hotel active". Not "is this hotel permanently closed". Not
 * "should this be published". D062 will compose this with star, location, scope
 * and entity evidence; this module composes nothing and publishes nothing.
 *
 * WHY THE DATE IS A PARAMETER AND NEVER A CLOCK READ
 * -------------------------------------------------
 * `2026-05-31 → 2026-08-31` is closed on 2026-08-17 and not closed on
 * 2026-09-01, with no new provider statement in between — only the calendar
 * moved. An outcome that reads the clock is therefore not reproducible, cannot
 * be tested at a boundary, and cannot be cited by a receipt that claims to
 * explain a past decision. So `asOf` is required, and there is no default: a
 * caller that does not know which date it means has not yet asked a question.
 *
 * There is no `Date.now()`, no `new Date()` and no `CURRENT_DATE` anywhere in
 * this decision path, and a test reads this file to prove it.
 */

/** The reviewed vocabulary. Deliberately three, and deliberately not "active". */
export type LifecycleOutcome = "known_closed" | "no_known_closure" | "unresolved";

/**
 * `no_known_closure` is the one that gets misread, so it is named for exactly
 * what it is. It means: the latest snapshot is COMPLETE, and it contains no
 * property-level closure window covering this date.
 *
 * It does NOT mean active, open, confirmed_open or operating. Absence of closure
 * evidence is not positive proof of operation, and a provider that never says
 * "this hotel is trading" has not said it.
 */
export const OUTCOME_MEANINGS: Record<LifecycleOutcome, string> = {
  known_closed:
    "The provider currently reports the HOTEL ITSELF closed on this date. NOT permanent closure, NOT inactive forever.",
  no_known_closure:
    "No property-level closure is known for this date. NOT active, NOT open, NOT confirmed operating.",
  unresolved:
    "We cannot safely say either. Missing extraction, or closure evidence we cannot read.",
};

/** Why an evaluation could not be made. Surfaced, never swallowed. */
export type UnresolvedReason =
  | "no_complete_issue_snapshot"
  /**
   * The identity's `last_seen_run_id` resolves to no observation of that
   * identity, so there is no CURRENT evidence to read. Fail closed: the property
   * stays in the sweep and is reported, rather than being dropped from it or
   * answered from some other observation.
   */
  | "no_current_observation"
  /**
   * The snapshot says the provider sent N issues and fewer than N are present.
   * DEFENCE IN DEPTH: the extractor cannot produce this state — a record with an
   * unreadable entry yields no snapshot at all — but a row written by hand, by a
   * future writer, or by a partially-failed load could. Whatever the cause, one
   * provider issue is unaccounted for, and an unaccounted issue may be the
   * closure. Never `no_known_closure`.
   */
  | "issue_count_mismatch"
  /** The provider omitted the endpoint entirely. */
  | "mapped_closure_missing_date_from"
  | "mapped_closure_missing_date_to"
  /**
   * The provider SENT something and it is not a real date — `2026-02-31`,
   * `2026-08-31garbage`. Deliberately a different reason from "missing":
   * calling a malformed value absent would hide that the provider stated
   * something nobody could read.
   */
  | "mapped_closure_invalid_date_from"
  | "mapped_closure_invalid_date_to"
  | "mapped_closure_inverted_range";

export interface IssueEvidence {
  issueCode: string;
  issueType: string;
  /**
   * The provider's bytes, VERBATIM — not necessarily a date at all.
   *
   * `null` = the provider omitted the field. A non-null value may still be
   * unreadable (`2026-02-31`, `2026-08-31garbage`), and telling those two apart
   * is this module's job, not the extractor's or the database's.
   */
  dateFromRaw: string | null;
  dateToRaw: string | null;
  providerOrder: number | null;
  alternative: boolean | null;
}

/**
 * The latest observation's issue extraction.
 *
 * `null` means NO COMPLETE SNAPSHOT EXISTS, which is ignorance — not "no
 * issues". The two must never collapse: an unextracted property reading as
 * "no known closure" is the exact false negative D062 must not act on.
 */
export interface IssueSnapshot {
  snapshotId: string;
  observationId: string;
  providerIssueCount: number;
  issues: IssueEvidence[];
}

/** One approved (code, type) pair. Absence is not lifecycle evidence. */
export interface LifecyclePolicyMapping {
  issueCode: string;
  issueType: string;
  outcome: "property_closed_window";
}

export interface LifecyclePolicy {
  provider: string;
  version: string;
  /** A DRAFT policy may not be cited. See `evaluateLifecycle`. */
  approved: boolean;
  dateSemantics: "inclusive_day_interval";
  mappings: LifecyclePolicyMapping[];
}

/** A closure window that actually covers the date, kept for the report. */
export interface ClosureWindow {
  issueCode: string;
  issueType: string;
  dateFrom: string;
  dateTo: string;
}

export interface LifecycleEvaluation {
  outcome: LifecycleOutcome;
  asOf: string;
  policyProvider: string;
  policyVersion: string;
  observationId: string | null;
  snapshotId: string | null;
  /** Every mapped window covering `asOf`. Non-empty exactly when known_closed. */
  activeClosureWindows: ClosureWindow[];
  /** Every mapped window, covering or not — the evidence behind the answer. */
  mappedWindows: IssueEvidence[];
  unresolvedReasons: UnresolvedReason[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Is this string a real calendar date?
 *
 * String comparison of `YYYY-MM-DD` is correct for ordering, but it happily
 * accepts `2026-02-31`, and a range built on a day that does not exist is not a
 * range anybody stated. Parsed in UTC so no local zone can shift the day.
 */
export function isValidIsoDate(value: string | null): value is string {
  if (value === null || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

/**
 * INCLUSIVE on both endpoints, as the approved policy records.
 *
 * The provider documents `dateFrom` as the date the issue STARTS and `dateTo` as
 * the date it ENDS, which are both days the issue is in force. Treating `dateTo`
 * as exclusive would silently declare a hotel open on the last day the provider
 * says it is shut. No time-of-day semantics are invented: these are day-level
 * facts and are compared as days.
 *
 * `YYYY-MM-DD` strings compare lexicographically in date order, so this needs no
 * date arithmetic and no timezone.
 */
export function coversDate(window: { from: string; to: string }, asOf: string): boolean {
  return window.from <= asOf && asOf <= window.to;
}

export class LifecyclePolicyNotApprovedError extends Error {
  constructor(provider: string, version: string) {
    super(
      `Lifecycle policy ${provider}/${version} is a DRAFT. A draft may not decide a property's ` +
        "lifecycle: it has not been reviewed, and an evaluation citing it would claim a review " +
        "that never happened.",
    );
    this.name = "LifecyclePolicyNotApprovedError";
  }
}

/**
 * Evaluate ONE source property against ONE policy, AS OF one explicit date.
 *
 * Pure. No database, no clock, no I/O. Everything it needs is an argument, which
 * is what lets a boundary be tested at all.
 */
export function evaluateLifecycle(args: {
  snapshot: IssueSnapshot | null;
  policy: LifecyclePolicy;
  asOf: string;
  /**
   * The observation the evaluation is ABOUT, supplied even when it has no
   * snapshot. An `unresolved` receipt has to be able to say WHICH observation
   * nobody extracted; "we could not evaluate something, somewhere" is not a
   * citation anybody can act on.
   */
  latestObservationId?: string | null;
  /**
   * False when the identity's current-run pointer resolved to no observation.
   * Distinguished from "no snapshot" because they are different failures: one is
   * missing EVIDENCE, the other is missing the OBSERVATION the evidence would
   * hang from.
   */
  hasCurrentObservation?: boolean;
}): LifecycleEvaluation {
  const { snapshot, policy, asOf } = args;

  if (!policy.approved) {
    throw new LifecyclePolicyNotApprovedError(policy.provider, policy.version);
  }
  if (!isValidIsoDate(asOf)) {
    throw new Error(`--as-of must be a real YYYY-MM-DD date; received ${JSON.stringify(asOf)}.`);
  }

  const base = {
    asOf,
    policyProvider: policy.provider,
    policyVersion: policy.version,
    observationId: args.latestObservationId ?? snapshot?.observationId ?? null,
    snapshotId: snapshot?.snapshotId ?? null,
  };

  // NO CURRENT OBSERVATION AT ALL. Fail closed, and say which failure it is.
  if (args.hasCurrentObservation === false) {
    return {
      ...base,
      outcome: "unresolved",
      activeClosureWindows: [],
      mappedWindows: [],
      unresolvedReasons: ["no_current_observation"],
    };
  }

  // NO COMPLETE SNAPSHOT = IGNORANCE.
  //
  // Not "no issues", and specifically not a fallback to an older snapshot that
  // DOES exist: the older one describes what the provider said at a moment that
  // has passed, and presenting it as current would let a lifted closure keep a
  // property closed, or a stale clean bill keep a closed one open.
  if (snapshot === null) {
    return {
      ...base,
      outcome: "unresolved",
      activeClosureWindows: [],
      mappedWindows: [],
      unresolvedReasons: ["no_complete_issue_snapshot"],
    };
  }

  // EVERY PROVIDER ISSUE MUST BE ACCOUNTED FOR.
  //
  // A snapshot claiming more issues than it carries is not a complete picture,
  // and the one it is missing could be the closure. Checked before anything is
  // read, because the rows that ARE present would otherwise produce a confident
  // answer about an incomplete record.
  //
  // DEFENCE IN DEPTH: the extractor cannot produce this state — a record with an
  // unreadable entry yields no snapshot at all — but a hand-written row, a
  // future writer or a partially-failed load could.
  if (snapshot.providerIssueCount !== snapshot.issues.length) {
    return {
      ...base,
      outcome: "unresolved",
      activeClosureWindows: [],
      mappedWindows: [],
      unresolvedReasons: ["issue_count_mismatch"],
    };
  }

  // Keyed on a NUL separator, not a space. Provider codes are stored verbatim
  // and are no longer trimmed, so a code may legitimately contain spaces — and
  // with a space separator `"HOTEL " + "CLOSED"` and `"HOTEL" + " CLOSED"` would
  // collide into one key, handing an unreviewed pair the approved mapping. NUL
  // cannot appear in a provider string that reached this far.
  const pairKey = (issueCode: string, issueType: string) => `${issueCode}\u0000${issueType}`;
  const mapped = new Set(policy.mappings.map((m) => pairKey(m.issueCode, m.issueType)));

  // ONLY the approved pairs. A facility closure — OUTDOORPOOL, SPA, RESTAURANT,
  // WATERPARK, PARKING — is not property-level lifecycle evidence, so it is not
  // examined here at all. There is deliberately no branch anywhere in this
  // function that looks at `issueType` without its `issueCode`.
  const mappedWindows = snapshot.issues.filter((i) =>
    mapped.has(pairKey(i.issueCode, i.issueType)),
  );

  // MALFORMED MAPPED EVIDENCE IS NOT "NOTHING KNOWN".
  //
  // A property-level closure whose range cannot be read is a problem with the
  // evidence, and reporting it as `no_known_closure` would turn a broken closure
  // notice into a clean bill of health. The reasons are collected rather than
  // short-circuited so a reviewer sees every defect at once.
  //
  // A malformed FACILITY issue does not reach this loop, and so cannot make a
  // whole property unresolved — the approved policy gives it no lifecycle
  // meaning to be defective about.
  const unresolvedReasons: UnresolvedReason[] = [];
  for (const window of mappedWindows) {
    // ABSENT and UNREADABLE are different facts and get different reasons. The
    // provider omitting `dateTo` and the provider sending `2026-02-31` are not
    // the same defect, and a reviewer chasing one should not be told the other.
    if (window.dateFromRaw === null) {
      unresolvedReasons.push("mapped_closure_missing_date_from");
    } else if (!isValidIsoDate(window.dateFromRaw)) {
      unresolvedReasons.push("mapped_closure_invalid_date_from");
    } else if (window.dateToRaw === null) {
      unresolvedReasons.push("mapped_closure_missing_date_to");
    } else if (!isValidIsoDate(window.dateToRaw)) {
      unresolvedReasons.push("mapped_closure_invalid_date_to");
    } else if (window.dateFromRaw > window.dateToRaw) {
      unresolvedReasons.push("mapped_closure_inverted_range");
    }
  }

  if (unresolvedReasons.length > 0) {
    return {
      ...base,
      outcome: "unresolved",
      activeClosureWindows: [],
      mappedWindows,
      unresolvedReasons: [...new Set(unresolvedReasons)],
    };
  }

  // ANY valid mapped window covering the date closes the property for that date.
  // Multiple windows are not merged or averaged: they are separate provider
  // statements, and one of them being in force is enough.
  const activeClosureWindows: ClosureWindow[] = mappedWindows
    .filter((w) => coversDate({ from: w.dateFromRaw!, to: w.dateToRaw! }, asOf))
    .map((w) => ({
      issueCode: w.issueCode,
      issueType: w.issueType,
      dateFrom: w.dateFromRaw!,
      dateTo: w.dateToRaw!,
    }));

  return {
    ...base,
    // A LONG RANGE IS STILL A RANGE. `2020-04-24 → 2039-12-31` produces exactly
    // the same outcome vocabulary as a three-month window: `known_closed` on the
    // dates it covers. There is no branch on how far away `dateTo` is, and
    // nothing in this codebase converts a distant endpoint into permanence.
    outcome: activeClosureWindows.length > 0 ? "known_closed" : "no_known_closure",
    activeClosureWindows,
    mappedWindows,
    unresolvedReasons: [],
  };
}
