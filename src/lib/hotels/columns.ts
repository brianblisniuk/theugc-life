/**
 * Column allow-lists for hotel reads.
 *
 * Kept in a dependency-free module so tests can assert the discovery/detail
 * projection never includes a premium contact field, without importing the
 * server-only Supabase layer.
 */

/**
 * Columns Discover and hotel detail may select from `public.hotels`.
 * Deliberately contains NO contact field — leaking one here would bypass the
 * premium gate, so a regression test pins this list.
 */
export const HOTEL_PUBLIC_COLUMNS = [
  "id",
  "name",
  "slug",
  "hotel_type",
  "star_rating",
  "country_code",
  "website_url",
  "instagram_url",
  "address",
  "active_status",
  "editorial_verification_status",
  "editorial_verified_at",
  "destination_id",
] as const;

/** Contact columns — only ever selected for an already-authorized caller. */
export const HOTEL_CONTACT_COLUMNS = [
  "id",
  "display_name",
  "first_name",
  "last_name",
  "job_title",
  "department",
  "email",
  "phone",
  "linkedin_url",
  "organization_name",
  "verification_status",
  "verified_at",
  "status",
] as const;

/**
 * Premium/contact-bearing field names that must never appear in a hotel
 * discovery or detail payload.
 */
export const PREMIUM_CONTACT_FIELDS = [
  "email",
  "phone",
  "linkedin_url",
  "display_name",
  "first_name",
  "last_name",
  "job_title",
  "source_reference",
  "organization_name",
] as const;

/** Internal research/provenance columns never shown to creators. */
export const INTERNAL_ONLY_FIELDS = [
  "source_reference",
  "source_type",
  "import_batch_id",
  "import_row_id",
] as const;
