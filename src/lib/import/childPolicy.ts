/**
 * Deterministic child-row inclusion policy (CANONICAL_PROMOTION_SPEC.md §5,
 * D036). A property review approves a bundle, but each contact/evidence row
 * still follows these safety defaults. Reviewer overrides may upgrade a
 * `defer` to `include`, but may NEVER force a structurally rejected/invalid row
 * or an endpoint-less contact into canonical data in Sprint 1B.
 */
import type { ContactRecord, EvidenceRecord } from "./contract";
import type { ValidationStatus } from "./stage";

export type Inclusion = "include" | "defer" | "exclude";
export type ChildDecision = "include" | "exclude" | "defer";

const ORG_LIKE_SCOPES = new Set(["brand", "group", "operator", "agency"]);

export function contactHasActionableEndpoint(c: ContactRecord): boolean {
  return Boolean(c.email || c.phone || c.linkedinUrl);
}

/** Default inclusion for a contact row, before any reviewer override. */
export function defaultContactInclusion(validation: ValidationStatus, c: ContactRecord): Inclusion {
  if (
    validation === "rejected" ||
    c.verificationStatus === "invalid" ||
    !contactHasActionableEndpoint(c)
  ) {
    return "exclude";
  }
  const orgMissing =
    c.contactScope !== null && ORG_LIKE_SCOPES.has(c.contactScope) && !c.organizationName;
  if (validation === "review" || c.verificationStatus === "inferred" || orgMissing) {
    return "defer";
  }
  return "include";
}

/** Default inclusion for an evidence row, before any reviewer override. */
export function defaultEvidenceInclusion(
  validation: ValidationStatus,
  e: EvidenceRecord,
): Inclusion {
  if (validation === "rejected" || e.verificationStatus === "invalid") return "exclude";
  if (validation === "review") return "defer";
  return "include";
}

/**
 * Final contact inclusion given the default + an optional explicit reviewer
 * override. A structurally excluded row (rejected/invalid/no endpoint) can
 * never be forced in; an `include` override only rescues a `defer`.
 */
export function finalContactInclusion(
  validation: ValidationStatus,
  c: ContactRecord,
  override: ChildDecision | undefined,
): Inclusion {
  const base = defaultContactInclusion(validation, c);
  if (base === "exclude") return "exclude"; // cannot be forced in
  if (override === "exclude" || override === "defer") return override;
  if (override === "include") return "include";
  return base;
}

/** Final evidence inclusion given the default + an optional reviewer override. */
export function finalEvidenceInclusion(
  validation: ValidationStatus,
  e: EvidenceRecord,
  override: ChildDecision | undefined,
): Inclusion {
  const base = defaultEvidenceInclusion(validation, e);
  if (base === "exclude") return "exclude";
  if (override === "exclude" || override === "defer") return override;
  if (override === "include") return "include";
  return base;
}
