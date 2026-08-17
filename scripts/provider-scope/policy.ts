/**
 * Reviewed provider HOSPITALITY SCOPE policies.
 *
 * The same shape as the classification policy in `../provider-classification`,
 * and deliberately so: the unit of review is provider + field + code, reviewed
 * once against the provider's own master, versioned so a resolution can name
 * what produced it (D066's method, applied to a different question).
 *
 * The question this dimension answers is narrow:
 *
 *     is this candidate a PHYSICAL HOSPITALITY PROPERTY?
 *
 * and nothing else. It is **not** V1 eligibility. D060 is explicit that property
 * type alone does not decide eligibility: the V1 gate is physical hospitality
 * property AND a resolved exact 4/5 hospitality classification AND a supported
 * destination, composed later at the D062 preview. A `physical_hospitality`
 * result on a 3-star property means nothing on its own, and a 5-star property
 * whose type is `unresolved` is a HOLD, not an exclusion.
 *
 * Pure and offline: a lookup table plus a lookup. No database, no network.
 */

/** The only three answers this dimension has. */
export type HospitalityScopeOutcome =
  "physical_hospitality" | "not_physical_hospitality" | "unresolved";

export interface HospitalityScopePolicy {
  provider: string;
  /** Changing any mapping is a NEW version, enforced in the database. */
  version: string;
  /** The ONE provider field this policy reads. Anything else is out of contract. */
  field: string;
  /**
   * Codes with reviewed semantics. A code that is ABSENT is `unresolved` — an
   * allow-list, so a provider adding a type we have never reviewed cannot
   * silently acquire a meaning.
   */
  mappings: Readonly<Record<string, Exclude<HospitalityScopeOutcome, "unresolved">>>;
  notes: string;
}

/**
 * Resolve one provider type code through a policy.
 *
 * Absent, blank or unmapped is `unresolved`, which means REVIEW — and is
 * explicitly not the same fact as `not_physical_hospitality`.
 */
export function resolveScopeCode(
  policy: HospitalityScopePolicy,
  code: string | null | undefined,
): HospitalityScopeOutcome {
  if (code === null || code === undefined) return "unresolved";
  const trimmed = code.trim();
  if (trimmed === "") return "unresolved";
  return policy.mappings[trimmed] ?? "unresolved";
}
