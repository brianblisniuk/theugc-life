/**
 * Canonical hotel research contract (HOTEL_DATA_CONTRACT.md).
 *
 * These taxonomies + schemas define the ONLY shape the importer accepts after
 * normalization. Legacy adapters must translate their messy inputs into these
 * canonical staging records — legacy quirks never leak into this contract
 * (IMPORT_SPEC.md §1, D025/D030).
 */
import { z } from "zod";

// --- Taxonomies (closed sets; never invent values) -------------------------

export const HOTEL_TYPES = [
  "hotel",
  "resort",
  "boutique_hotel",
  "aparthotel",
  "hostel",
  "villa",
  "residence",
  "guesthouse",
  "lodge",
  "other",
  "unknown",
] as const;
export type HotelType = (typeof HOTEL_TYPES)[number];

export const DEPARTMENTS = [
  "marketing",
  "pr",
  "communications",
  "social_media",
  "partnerships",
  "events",
  "sales",
  "reservations",
  "general",
  "other",
  "unknown",
] as const;
export type Department = (typeof DEPARTMENTS)[number];

export const CONTACT_SCOPES = [
  "property",
  "brand",
  "group",
  "operator",
  "agency",
  "unknown",
] as const;
export type ContactScope = (typeof CONTACT_SCOPES)[number];

export const VERIFICATION_STATUSES = [
  "verified",
  "probable",
  "inferred",
  "unverified",
  "invalid",
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const CLAIM_TYPES = [
  "property_exists",
  "contact_confirmation",
  "brand_relationship",
  "operator_relationship",
  "agency_representation",
  "creator_collaboration_evidence",
  "other",
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

export const SOURCE_TYPES = [
  "official_website",
  "official_social",
  "official_media_kit",
  "official_privacy_policy",
  "authorized_representative",
  "public_registry",
  "reputable_third_party",
  "research_compilation",
  "unknown",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const ORG_TYPES = [
  "hotel_group",
  "operator",
  "management_company",
  "pr_agency",
  "sales_rep",
  "other",
] as const;
export type OrgType = (typeof ORG_TYPES)[number];

export const ROW_KINDS = ["property", "contact", "evidence"] as const;
export type RowKind = (typeof ROW_KINDS)[number];

// --- Canonical staging records (post-normalization) ------------------------

/**
 * A normalized property staging record. `sourcePropertyKey` groups contacts and
 * evidence to their property within a single import batch (never used as a
 * canonical identity key across imports).
 */
export const propertyRecordSchema = z.object({
  sourcePropertyKey: z.string().min(1),
  propertyName: z.string().min(1),
  brandName: z.string().nullable(),
  hotelType: z.enum(HOTEL_TYPES),
  starRating: z.number().min(0).max(5).nullable(),
  countryCode: z.string().length(2).nullable(),
  region: z.string().nullable(),
  city: z.string().nullable(),
  destinationName: z.string().nullable(),
  parentDestinationName: z.string().nullable(),
  address: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  websiteUrl: z.string().nullable(),
  websiteHost: z.string().nullable(),
  instagramUrl: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  /** Normalized match representation of the name (case/diacritic/punct folded). */
  nameMatchKey: z.string(),
  notes: z.string().nullable(),
});
export type PropertyRecord = z.infer<typeof propertyRecordSchema>;

export const contactRecordSchema = z.object({
  sourcePropertyKey: z.string().min(1),
  contactName: z.string().nullable(),
  jobTitle: z.string().nullable(),
  department: z.enum(DEPARTMENTS).nullable(),
  email: z.string().nullable(),
  isGenericMailbox: z.boolean(),
  phone: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  contactScope: z.enum(CONTACT_SCOPES).nullable(),
  /**
   * Explicit organization identity (HOTEL_DATA_CONTRACT §4/§8, review F1). A
   * person is NOT an organization: this is the ONLY source of an organization
   * name. It is never inferred from contact_name, email, or the property key.
   */
  organizationName: z.string().nullable(),
  verificationStatus: z.enum(VERIFICATION_STATUSES),
  sourceUrl: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  notes: z.string().nullable(),
});
export type ContactRecord = z.infer<typeof contactRecordSchema>;

export const evidenceRecordSchema = z.object({
  sourcePropertyKey: z.string().min(1),
  claimType: z.enum(CLAIM_TYPES),
  sourceType: z.enum(SOURCE_TYPES),
  sourceUrl: z.string().nullable(),
  verificationStatus: z.enum(VERIFICATION_STATUSES),
  observedAt: z.string().nullable(),
  notes: z.string().nullable(),
});
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;

/** A normalized, source-agnostic staging dataset produced by any adapter. */
export interface StagingDataset {
  properties: PropertyRecord[];
  contacts: ContactRecord[];
  evidence: EvidenceRecord[];
}
