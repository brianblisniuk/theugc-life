/**
 * Canonical product-analytics event dictionary (ANALYTICS.md §5).
 *
 * Product analytics answer "how do people use theugc.life and convert". They are
 * a SEPARATE system from domain/outreach events (which live in the
 * `outreach_events` table and are the source of truth for hotel intelligence).
 * Never treat an analytics event as domain truth (ANALYTICS.md §1, EVENTS.md §10).
 *
 * Event names are version-controlled; do not rename casually (ANALYTICS.md §11).
 */
export const PRODUCT_EVENTS = [
  // Acquisition / auth
  "landing_viewed",
  "pricing_viewed",
  "signup_started",
  "signup_completed",
  "login_completed",
  "onboarding_started",
  "onboarding_completed",
  // Discovery
  "discover_viewed",
  "map_moved",
  "search_performed",
  "filter_applied",
  "hotel_viewed",
  "hotel_saved",
  // Premium
  "contact_unlock_clicked",
  "upgrade_modal_viewed",
  "checkout_started",
  "purchase_completed",
  "contact_unlocked",
  "premium_intelligence_viewed",
  // CRM
  "pipeline_viewed",
  "pipeline_item_created",
  "pipeline_status_changed",
  "followup_due_viewed",
  "trip_created",
  "trip_viewed",
  "trip_hotel_added",
  // Portfolio / growth
  "public_profile_viewed",
  "portfolio_asset_added",
  "share_card_created",
  "share_card_shared",
  "hotel_claim_submitted",
  "referral_link_copied",
  "referral_converted",
] as const;

export type ProductEvent = (typeof PRODUCT_EVENTS)[number];

/**
 * Property keys that must NEVER be sent to product analytics
 * (ANALYTICS.md §5 "Premium"/§6, PERMISSIONS.md §6). Enforced defensively at
 * capture time regardless of caller discipline.
 */
export const FORBIDDEN_ANALYTICS_KEYS = [
  "private_notes",
  "notes",
  "email",
  "contact_email",
  "phone",
  "linkedin",
  "value_amount",
  "private_value_amount",
  "private_value_currency",
  "negotiation_terms",
  "terms",
  "inbox",
] as const;

/** Analytics property values are intentionally restricted to safe scalars. */
export type AnalyticsPropertyValue = string | number | boolean | null | undefined;
export type AnalyticsProperties = Record<string, AnalyticsPropertyValue>;
