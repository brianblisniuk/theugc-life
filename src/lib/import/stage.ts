/**
 * Staging + validation (IMPORT_SPEC.md §6, HOTEL_DATA_CONTRACT §3–§6).
 *
 * Converts raw rows (standard importer) OR pre-normalized adapter output into
 * validated canonical staging rows. Every row keeps its raw lineage, a stable
 * fingerprint, the normalized record, and a validation verdict.
 */
import { normalizeClaimType, normalizeContactScope, normalizeDepartment } from "./aliases";
import {
  SOURCE_TYPES,
  type ContactRecord,
  type EvidenceRecord,
  type OrgType,
  type PropertyRecord,
  type RowKind,
} from "./contract";
import { rowFingerprint } from "./fingerprint";
import {
  classifyVerificationStatus,
  extractEmails,
  foldForMatch,
  isGenericMailbox,
  nameMatchKey,
  normalizeCountryCode,
  normalizeHotelType,
  normalizeSlug,
  normalizeString,
  normalizeUrl,
  parseNumber,
} from "./normalize";
import type { RawRow, RawSheets } from "./parse";
import { REASON, reason } from "./rejections";

export type ValidationStatus = "valid" | "warning" | "review" | "rejected";

export interface StagedRow {
  sheetName: string;
  sourceRowNumber: number;
  rowKind: RowKind;
  sourcePropertyKey: string | null;
  raw: Record<string, string | null>;
  rawFingerprint: string;
  normalized: Record<string, unknown> | null;
  status: ValidationStatus;
  errors: string[];
  warnings: string[];
}

export interface StagedDataset {
  rows: StagedRow[];
}

// Normalize a header to canonical snake_case for lookup.
function headerKey(header: string): string {
  return header
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

/** Look up a canonical field value from a raw row by tolerant header matching. */
function pick(data: Record<string, string | null>, canonical: string): string | null {
  for (const [header, value] of Object.entries(data)) {
    if (headerKey(header) === canonical) return value;
  }
  return null;
}

function worst(a: ValidationStatus, b: ValidationStatus): ValidationStatus {
  const order: ValidationStatus[] = ["valid", "warning", "review", "rejected"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

function inTaxonomy<T extends readonly string[]>(
  list: T,
  value: string | null,
): value is T[number] {
  return value !== null && (list as readonly string[]).includes(value);
}

// --- Property mapping ------------------------------------------------------

export function mapProperty(raw: RawRow): StagedRow {
  const errors: string[] = [];
  const warnings: string[] = [];
  let status: ValidationStatus = "valid";

  const propertyName = normalizeString(pick(raw.data, "property_name"));
  const sourceKeyRaw = normalizeString(pick(raw.data, "source_property_id"));
  const sourcePropertyKey = sourceKeyRaw ?? `row:${raw.sheetName}:${raw.sourceRowNumber}`;
  if (!sourceKeyRaw) {
    warnings.push("missing source_property_id; using row-based key");
    status = worst(status, "warning");
  }

  if (!propertyName) {
    errors.push("property_name is required");
    errors.push(reason(REASON.missingPropertyName));
    return {
      sheetName: raw.sheetName,
      sourceRowNumber: raw.sourceRowNumber,
      rowKind: "property",
      sourcePropertyKey,
      raw: raw.data,
      rawFingerprint: rowFingerprint(raw.data),
      normalized: null,
      status: "rejected",
      errors,
      warnings,
    };
  }

  // Ambiguous multi-property heuristic (durable; not legacy-specific): a single
  // property_name that clearly encodes several distinct properties must be
  // reviewed/split by a human — never silently promoted (LEGACY §5).
  if (/\s\/\s|\n|\s\+\s/.test(propertyName)) {
    warnings.push("possible multi-property row (ambiguous); needs review before split");
    status = worst(status, "review");
  }

  const countryCode = normalizeCountryCode(pick(raw.data, "country_code"));
  if (!countryCode) {
    warnings.push("country_code missing or not ISO 3166-1 alpha-2");
    status = worst(status, "review");
  }

  const destinationName = normalizeString(pick(raw.data, "destination_name"));
  if (!destinationName) {
    warnings.push("destination_name missing; geography must be reviewed");
    status = worst(status, "review");
  }

  const website = normalizeUrl(pick(raw.data, "website_url"));
  const instagram = normalizeUrl(pick(raw.data, "instagram_url"));
  const sourceUrl = normalizeUrl(pick(raw.data, "source_url"));
  if (!sourceUrl.normalized) {
    warnings.push("source_url missing or invalid (provenance incomplete)");
    status = worst(status, "warning");
  }

  const starRating = parseNumber(pick(raw.data, "star_rating"));
  let star = starRating;
  if (starRating !== null && (starRating < 0 || starRating > 5)) {
    warnings.push("star_rating out of range; dropped");
    star = null;
    status = worst(status, "warning");
  }

  const record: PropertyRecord = {
    sourcePropertyKey,
    propertyName,
    brandName: normalizeString(pick(raw.data, "brand_name")),
    hotelType: normalizeHotelType(pick(raw.data, "hotel_type")),
    starRating: star,
    countryCode,
    region: normalizeString(pick(raw.data, "region")),
    city: normalizeString(pick(raw.data, "city")),
    destinationName,
    destinationSlug: normalizeSlug(pick(raw.data, "destination_slug")),
    parentDestinationName: normalizeString(pick(raw.data, "parent_destination_name")),
    address: normalizeString(pick(raw.data, "address")),
    latitude: parseNumber(pick(raw.data, "latitude")),
    longitude: parseNumber(pick(raw.data, "longitude")),
    websiteUrl: website.normalized,
    websiteHost: website.host,
    instagramUrl: instagram.normalized,
    sourceUrl: sourceUrl.normalized,
    nameMatchKey: nameMatchKey(propertyName),
    notes: normalizeString(pick(raw.data, "notes")),
  };

  return {
    sheetName: raw.sheetName,
    sourceRowNumber: raw.sourceRowNumber,
    rowKind: "property",
    sourcePropertyKey,
    raw: raw.data,
    rawFingerprint: rowFingerprint(raw.data),
    normalized: record as unknown as Record<string, unknown>,
    status,
    errors,
    warnings,
  };
}

// --- Contact mapping -------------------------------------------------------

export function mapContact(raw: RawRow): StagedRow {
  const errors: string[] = [];
  const warnings: string[] = [];
  let status: ValidationStatus = "valid";

  const sourcePropertyKey = normalizeString(pick(raw.data, "source_property_id"));
  if (!sourcePropertyKey) {
    errors.push("contact has no source_property_id to attach to");
    errors.push(reason(REASON.missingSourcePropertyId));
    return baseRejected(raw, "contact", null, errors, warnings);
  }

  const emailCell = pick(raw.data, "email");
  const extraction = extractEmails(emailCell);
  let email: string | null = null;
  let generic = false;
  const verificationClass = classifyVerificationStatus(pick(raw.data, "verification_status"));
  let verification = verificationClass.status;
  if (verificationClass.unmapped) {
    warnings.push(reason(REASON.verificationUnmapped));
    status = worst(status, "warning");
  }

  if (extraction.masked) {
    warnings.push("masked/obfuscated email rejected as endpoint");
    warnings.push(reason(REASON.maskedEmail));
    verification = "invalid";
    status = worst(status, "warning");
  } else if (extraction.emails.length >= 1) {
    email = extraction.emails[0] ?? null;
    generic = email ? isGenericMailbox(email) : false;
    if (extraction.emails.length > 1) {
      warnings.push(`multiple emails in one cell; kept first (${extraction.emails.length})`);
      warnings.push(reason(REASON.multipleEmails));
      status = worst(status, "warning");
    }
  }

  const contactNameRaw = normalizeString(pick(raw.data, "contact_name"));
  const phone = normalizeString(pick(raw.data, "phone"));
  const linkedinUrl = normalizeUrl(pick(raw.data, "linkedin_url")).normalized;

  // A LinkedIn URL is an endpoint (child policy already treats it as one). A
  // name alone is not an endpoint and is rejected here only when email, phone,
  // and LinkedIn are all absent.
  if (!email && !contactNameRaw && !phone && !linkedinUrl) {
    errors.push("contact has no usable endpoint (no valid email, name, phone, or linkedin)");
    errors.push(reason(REASON.noUsableEndpoint));
    return baseRejected(raw, "contact", sourcePropertyKey, errors, warnings);
  }
  if (!email && !extraction.masked) {
    warnings.push("no valid email endpoint for contact");
    warnings.push(reason(REASON.noValidEmail));
    status = worst(status, "review");
  }

  const departmentResult = normalizeDepartment(pick(raw.data, "department"));
  if (departmentResult.unmapped) {
    warnings.push(reason(REASON.departmentUnmapped));
    status = worst(status, "warning");
  }
  const scopeResult = normalizeContactScope(pick(raw.data, "contact_scope"));
  if (scopeResult.unmapped) {
    warnings.push(reason(REASON.scopeUnmapped));
    status = worst(status, "warning");
  }
  const department = departmentResult.value;
  const contactScope = scopeResult.value;

  // Never label an inferred value verified just because it parses.
  if (email && verification === "verified") {
    const providedVerifiedAt = normalizeString(pick(raw.data, "verified_at"));
    if (!providedVerifiedAt) {
      warnings.push("verification=verified without verified_at; downgraded to probable");
      warnings.push(reason(REASON.verifiedWithoutTimestamp));
      verification = "probable";
      status = worst(status, "warning");
    }
  }

  // Explicit organization identity only (review F1). Never inferred from a
  // person's name, email, or property key. Typed columns (hotel group,
  // management company, agency, operator) are organization_name aliases.
  const organization = readOrganization(raw.data);
  if (organization.conflict) {
    warnings.push(reason(REASON.organizationColumnConflict));
    status = worst(status, "warning");
  }
  const organizationName = organization.name;
  const organizationType = organization.type;
  const orgLikeScope =
    contactScope !== null && ["brand", "group", "operator", "agency"].includes(contactScope);
  if (orgLikeScope && !organizationName) {
    warnings.push(
      "organization_identity_missing: broader-than-property scope without an explicit organization_name; kept attached to property for review",
    );
    warnings.push(reason(REASON.organizationIdentityMissing));
    status = worst(status, "review");
  }

  const record: ContactRecord = {
    sourcePropertyKey,
    // A generic mailbox is an endpoint, not a fabricated named person.
    contactName: contactNameRaw,
    jobTitle: normalizeString(pick(raw.data, "job_title")),
    department,
    email,
    isGenericMailbox: generic,
    phone,
    linkedinUrl,
    contactScope,
    organizationName,
    organizationType,
    verificationStatus: verification,
    sourceUrl: normalizeUrl(pick(raw.data, "source_url")).normalized,
    verifiedAt: normalizeString(pick(raw.data, "verified_at")),
    notes: normalizeString(pick(raw.data, "notes")),
  };

  return {
    sheetName: raw.sheetName,
    sourceRowNumber: raw.sourceRowNumber,
    rowKind: "contact",
    sourcePropertyKey,
    raw: raw.data,
    rawFingerprint: rowFingerprint(raw.data),
    normalized: record as unknown as Record<string, unknown>,
    status,
    errors,
    warnings,
  };
}

// --- Evidence mapping ------------------------------------------------------

export function mapEvidence(raw: RawRow): StagedRow {
  const errors: string[] = [];
  const warnings: string[] = [];

  const sourcePropertyKey = normalizeString(pick(raw.data, "source_property_id"));
  if (!sourcePropertyKey) {
    errors.push("evidence has no source_property_id to attach to");
    errors.push(reason(REASON.missingSourcePropertyId));
    return baseRejected(raw, "evidence", null, errors, warnings);
  }

  const claim = normalizeClaimType(pick(raw.data, "claim_type"));
  if (claim.unmapped) warnings.push(reason(REASON.claimUnmapped));

  const sourceTypeRaw = foldForMatch(normalizeString(pick(raw.data, "source_type")) ?? "").replace(
    / /g,
    "_",
  );
  const sourceType = inTaxonomy(SOURCE_TYPES, sourceTypeRaw) ? sourceTypeRaw : "unknown";
  if (normalizeString(pick(raw.data, "source_type")) && !inTaxonomy(SOURCE_TYPES, sourceTypeRaw)) {
    warnings.push(reason(REASON.sourceTypeUnmapped));
  }

  const verificationClass = classifyVerificationStatus(pick(raw.data, "verification_status"));
  if (verificationClass.unmapped) warnings.push(reason(REASON.verificationUnmapped));

  let status: ValidationStatus = "valid";
  if (warnings.length > 0) status = "warning";

  const record: EvidenceRecord = {
    sourcePropertyKey,
    claimType: claim.value,
    sourceType,
    sourceUrl: normalizeUrl(pick(raw.data, "source_url")).normalized,
    verificationStatus: verificationClass.status,
    observedAt: normalizeString(pick(raw.data, "observed_at")),
    notes: normalizeString(pick(raw.data, "notes")),
  };

  return {
    sheetName: raw.sheetName,
    sourceRowNumber: raw.sourceRowNumber,
    rowKind: "evidence",
    sourcePropertyKey,
    raw: raw.data,
    rawFingerprint: rowFingerprint(raw.data),
    normalized: record as unknown as Record<string, unknown>,
    status,
    errors,
    warnings,
  };
}

/**
 * Organization columns, most specific contract name first. A typed column is
 * used only when `organization_name` itself is empty, or when it repeats the
 * same name (so we learn the type without inventing a second organization).
 */
const ORGANIZATION_COLUMNS: { header: string; type: OrgType | null }[] = [
  { header: "organization_name", type: null },
  { header: "organisation_name", type: null },
  { header: "org_name", type: null },
  { header: "hotel_group", type: "hotel_group" },
  { header: "hotel_group_name", type: "hotel_group" },
  { header: "group_name", type: "hotel_group" },
  { header: "management_company", type: "management_company" },
  { header: "management_company_name", type: "management_company" },
  { header: "operator_name", type: "operator" },
  { header: "agency_name", type: "pr_agency" },
  { header: "company_name", type: null },
  { header: "company", type: null },
  { header: "organization", type: null },
  { header: "organisation", type: null },
];

function readOrganization(data: Record<string, string | null>): {
  name: string | null;
  type: OrgType | null;
  conflict: boolean;
} {
  const filled = ORGANIZATION_COLUMNS.flatMap((column) => {
    const name = normalizeString(pick(data, column.header));
    return name ? [{ name, type: column.type }] : [];
  });
  if (filled.length === 0) return { name: null, type: null, conflict: false };
  const primary = filled[0]!;
  const sameName = filled.filter(
    (entry) => foldForMatch(entry.name) === foldForMatch(primary.name),
  );
  const typed = sameName.find((entry) => entry.type !== null);
  const conflict = filled.some((entry) => foldForMatch(entry.name) !== foldForMatch(primary.name));
  return { name: primary.name, type: typed?.type ?? primary.type, conflict };
}

function baseRejected(
  raw: RawRow,
  rowKind: RowKind,
  sourcePropertyKey: string | null,
  errors: string[],
  warnings: string[],
): StagedRow {
  return {
    sheetName: raw.sheetName,
    sourceRowNumber: raw.sourceRowNumber,
    rowKind,
    sourcePropertyKey,
    raw: raw.data,
    rawFingerprint: rowFingerprint(raw.data),
    normalized: null,
    status: "rejected",
    errors,
    warnings,
  };
}

/** Stage raw sheets from the standard importer into validated staged rows. */
export function stageRawSheets(sheets: RawSheets): StagedDataset {
  const rows: StagedRow[] = [
    ...sheets.properties.map(mapProperty),
    ...sheets.contacts.map(mapContact),
    ...sheets.evidence.map(mapEvidence),
  ];
  const propertyKeys = new Set(
    rows
      .filter((row) => row.rowKind === "property" && row.status !== "rejected")
      .map((row) => row.sourcePropertyKey)
      .filter((key): key is string => key !== null),
  );
  for (const row of rows) {
    if (row.rowKind === "property" || row.status === "rejected" || !row.sourcePropertyKey) continue;
    if (propertyKeys.has(row.sourcePropertyKey)) continue;
    row.warnings.push(reason(REASON.sourcePropertyMissing));
    row.status = worst(row.status, "review");
  }
  return { rows };
}
