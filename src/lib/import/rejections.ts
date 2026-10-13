/**
 * Per-row outcome report for a staged import.
 *
 * Counts why a source row was rejected at load or held back from the default
 * promotion policy. Row identities are sheet + source row number + reason
 * codes. Contact names, emails, and other raw values are not copied into the
 * report.
 */
import { defaultContactInclusion, contactHasActionableEndpoint } from "./childPolicy";
import type { ContactRecord } from "./contract";
import type { StagedRow } from "./stage";

export const REASON = {
  missingSourcePropertyId: "missing_source_property_id",
  missingPropertyName: "missing_property_name",
  noUsableEndpoint: "no_usable_endpoint",
  maskedEmail: "masked_email",
  noValidEmail: "no_valid_email",
  organizationIdentityMissing: "organization_identity_missing",
  organizationColumnConflict: "organization_column_conflict",
  departmentUnmapped: "department_unmapped",
  scopeUnmapped: "scope_unmapped",
  claimUnmapped: "claim_unmapped",
  sourceTypeUnmapped: "source_type_unmapped",
  verificationUnmapped: "verification_unmapped",
  sourcePropertyMissing: "source_property_missing",
  multipleEmails: "multiple_emails",
  verifiedWithoutTimestamp: "verified_without_timestamp",
  stagedRejected: "staged_rejected",
  invalidVerification: "invalid_verification",
  noActionableEndpoint: "no_actionable_endpoint",
  deferredInferred: "deferred_inferred",
  deferredReview: "deferred_review",
  excluded: "excluded",
} as const;

export function reason(code: string): string {
  return `reason:${code}`;
}

export function reasonCodesFromMessages(messages: string[]): string[] {
  const codes: string[] = [];
  for (const message of messages) {
    if (message.startsWith("reason:")) codes.push(message.slice("reason:".length));
  }
  return codes;
}

const ORG_SCOPES = new Set(["brand", "group", "operator", "agency"]);

function holdCodes(row: StagedRow): string[] {
  if (row.rowKind !== "contact") {
    return row.status === "rejected" ? [REASON.stagedRejected] : [];
  }
  if (!row.normalized) return [REASON.stagedRejected];
  const contact = row.normalized as unknown as ContactRecord;
  const inclusion = defaultContactInclusion(row.status, contact);
  if (inclusion === "include") return [];
  const codes: string[] = [];
  if (row.status === "rejected") codes.push(REASON.stagedRejected);
  if (contact.verificationStatus === "invalid") codes.push(REASON.invalidVerification);
  if (!contactHasActionableEndpoint(contact)) codes.push(REASON.noActionableEndpoint);
  if (contact.verificationStatus === "inferred") codes.push(REASON.deferredInferred);
  const orgMissing =
    contact.contactScope !== null &&
    ORG_SCOPES.has(contact.contactScope) &&
    !contact.organizationName;
  if (orgMissing) codes.push(REASON.organizationIdentityMissing);
  if (codes.length === 0 && inclusion === "defer") codes.push(REASON.deferredReview);
  if (codes.length === 0 && inclusion === "exclude") codes.push(REASON.excluded);
  return codes;
}

export interface HeldRow {
  sheet: string;
  row: number;
  kind: string;
  reasons: string[];
}

export interface OutcomeReport {
  properties: number;
  contacts: number;
  evidence: number;
  rejected: number;
  promotionInclude: number;
  promotionDefer: number;
  promotionExclude: number;
  /** Each reason counted once per row. */
  reasonCounts: Record<string, number>;
  /** Rejected rows, held contacts, and rows with a mapping reason. No raw values. */
  rows: HeldRow[];
}

export function summarizeOutcomes(rows: StagedRow[]): OutcomeReport {
  const reasonCounts: Record<string, number> = {};
  const held: HeldRow[] = [];
  let properties = 0;
  let contacts = 0;
  let evidence = 0;
  let rejected = 0;
  let promotionInclude = 0;
  let promotionDefer = 0;
  let promotionExclude = 0;

  for (const row of rows) {
    if (row.rowKind === "property") properties++;
    else if (row.rowKind === "contact") contacts++;
    else evidence++;
    if (row.status === "rejected") rejected++;

    if (row.rowKind === "contact" && row.normalized && row.status !== "rejected") {
      const inclusion = defaultContactInclusion(
        row.status,
        row.normalized as unknown as ContactRecord,
      );
      if (inclusion === "include") promotionInclude++;
      else if (inclusion === "defer") promotionDefer++;
      else promotionExclude++;
    }

    const codes = new Set<string>([
      ...reasonCodesFromMessages(row.errors),
      ...reasonCodesFromMessages(row.warnings),
      ...holdCodes(row),
    ]);
    if (codes.size === 0) continue;
    for (const code of codes) reasonCounts[code] = (reasonCounts[code] ?? 0) + 1;
    held.push({
      sheet: row.sheetName,
      row: row.sourceRowNumber,
      kind: row.rowKind,
      reasons: [...codes].sort(),
    });
  }

  held.sort(
    (a, b) => a.sheet.localeCompare(b.sheet) || a.row - b.row || a.kind.localeCompare(b.kind),
  );
  return {
    properties,
    contacts,
    evidence,
    rejected,
    promotionInclude,
    promotionDefer,
    promotionExclude,
    reasonCounts,
    rows: held,
  };
}
