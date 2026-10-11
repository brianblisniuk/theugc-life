/**
 * Benchmark-time privacy / vendor screen.
 *
 * CRITICAL BOUNDARY (D072 §19/§20): passing this screen authorizes nothing
 * about real Gmail. This round sends SYNTHETIC data only. No provider receives
 * real G1/G2 Gmail-derived content until a separate, explicit privacy/vendor
 * approval for that exact production configuration exists.
 *
 * Every finding records how it was obtained. `verification` distinguishes a
 * page this host actually read from a fact that could not be checked here —
 * an unverifiable claim is recorded as unverifiable, not laundered into a
 * confident statement.
 */

export const VENDOR_SCREEN_VERSION = "b07_vendor_screen_v1";
export const VENDOR_SCREEN_ACCESSED_AT = "2026-09-12";

export const SYNTHETIC_SUITABILITY = [
  "synthetic_benchmark_suitable",
  "blocked_for_synthetic_benchmark",
] as const;
export type SyntheticSuitability = (typeof SYNTHETIC_SUITABILITY)[number];

export const PRIVATE_GMAIL_CANDIDACY = [
  "potential_private_gmail_candidate_pending_final_approval",
  "blocked_for_private_gmail",
  "undetermined_official_source_unreachable",
] as const;
export type PrivateGmailCandidacy = (typeof PRIVATE_GMAIL_CANDIDACY)[number];

export const SOURCE_VERIFICATIONS = [
  "official_page_fetched",
  "official_page_unreachable_from_this_host",
  "secondary_summary_only",
] as const;
export type SourceVerification = (typeof SOURCE_VERIFICATIONS)[number];

export interface VendorScreenEntry {
  provider_id: "openai" | "anthropic" | "google";
  display_name: string;
  /** Does the provider use API/commercial data for model training by default? */
  trains_on_api_data_by_default: "no" | "yes" | "unknown";
  /** Standard retention of prompts/responses on the commercial API. */
  standard_retention: string;
  zero_data_retention_available: "yes_on_request" | "yes_self_serve" | "no" | "unknown";
  paid_vs_free_differences: string;
  deletion_and_control_constraints: string;
  security_compliance_notes: string;
  synthetic_suitability: SyntheticSuitability;
  private_gmail_candidacy: PrivateGmailCandidacy;
  official_sources: { url: string; title: string }[];
  accessed_at: string;
  verification: SourceVerification;
  /** Anything a later production approval must re-check or resolve. */
  open_questions: string[];
}

export const VENDOR_SCREEN: readonly VendorScreenEntry[] = [
  {
    provider_id: "anthropic",
    display_name: "Anthropic — Claude API (api.anthropic.com)",
    trains_on_api_data_by_default: "no",
    standard_retention:
      'Official documentation read on the accessed date states: "Retained data is never used for model training without your express permission" and "Only what is technically necessary for the feature to work is retained. Conversation content (your prompts and Claude\'s outputs) is not retained by default; the exception is Covered Models, which require 30-day retention." NOTE: this is materially NARROWER than the round brief\'s stated assumption of "standard API retention approximately 30 days" — the current documented default for ordinary (non-Covered) models is no default retention of conversation content, with 30 days applying to Covered Models (Fable/Mythos class) specifically.',
    zero_data_retention_available: "yes_on_request",
    paid_vs_free_differences:
      "ZDR and HIPAA readiness are Commercial-organization arrangements; consumer Claude plans (Free/Pro/Max) and the Console/playground are explicitly NOT covered. Covered Models (Fable 5/5.1, Mythos 5/5.1) require 30-day retention and are not ZDR-eligible unless expressly authorized.",
    deletion_and_control_constraints:
      "ZDR is enabled per organization by the account team and does not extend automatically to other organizations on the same account. Flagged content and legal holds are retained regardless of arrangement. CORS is unsupported for ZDR organizations, so browser-direct calls are out; a backend proxy is required (which B07 would use anyway).",
    security_compliance_notes:
      "Structured-output JSON schemas are compiled to grammars and CACHED SEPARATELY from message content, and explicitly do NOT receive the same protections as prompts and responses. Directly relevant to B07: the schema must carry only D072 enum names — never Gmail-derived text, names, property names or regex patterns. The benchmark schema already satisfies this.",
    synthetic_suitability: "synthetic_benchmark_suitable",
    private_gmail_candidacy: "potential_private_gmail_candidate_pending_final_approval",
    official_sources: [
      {
        url: "https://platform.claude.com/docs/en/manage-claude/api-and-data-retention",
        title: "API and data retention — Claude Platform Docs",
      },
      {
        url: "https://platform.claude.com/docs/en/about-claude/models/overview",
        title: "Models overview — Claude Platform Docs (model ids + pricing)",
      },
    ],
    accessed_at: VENDOR_SCREEN_ACCESSED_AT,
    verification: "official_page_fetched",
    open_questions: [
      "Confirm which exact model tier B07 would use and whether it is a Covered Model (which would force 30-day retention and forfeit ZDR).",
      "Confirm the commercial terms' advertising-use and sub-processor positions against D072 §19's list; the retention page does not cover them.",
    ],
  },
  {
    provider_id: "openai",
    display_name: "OpenAI — Platform API",
    trains_on_api_data_by_default: "unknown",
    standard_retention:
      "NOT VERIFIED FROM THIS HOST. The round brief states that business/API data is not used for training by default, that standard API content retention may be up to 30 days, and that eligible organizations/endpoints may support ZDR. Every official OpenAI documentation domain reachable for this check (platform.openai.com, developers.openai.com) is blocked by this environment's egress proxy, so none of that could be confirmed against a primary source.",
    zero_data_retention_available: "unknown",
    paid_vs_free_differences: "NOT VERIFIED FROM THIS HOST.",
    deletion_and_control_constraints: "NOT VERIFIED FROM THIS HOST.",
    security_compliance_notes:
      "NOT VERIFIED FROM THIS HOST. A secondary search summary suggested training exclusion and retention are separate controls and that ZDR requires a qualifying use case plus approval, but a secondary summary is not an official source and is recorded as such.",
    synthetic_suitability: "synthetic_benchmark_suitable",
    private_gmail_candidacy: "undetermined_official_source_unreachable",
    official_sources: [
      {
        url: "https://platform.openai.com/docs/guides/your-data",
        title: "Data controls in the OpenAI platform (UNREACHABLE from this host)",
      },
      {
        url: "https://openai.com/enterprise-privacy/",
        title: "Enterprise privacy at OpenAI (UNREACHABLE from this host)",
      },
    ],
    accessed_at: VENDOR_SCREEN_ACCESSED_AT,
    verification: "official_page_unreachable_from_this_host",
    open_questions: [
      "Re-run this screen from a host with egress to platform.openai.com before any private-Gmail decision.",
      "Confirm ZDR endpoint eligibility for whichever structured-output transport B07 would use.",
    ],
  },
  {
    provider_id: "google",
    display_name: "Google — Gemini Developer API (paid tier)",
    trains_on_api_data_by_default: "no",
    standard_retention:
      "Official Gemini API terms and logging documentation (surfaced via search; the pages themselves are egress-blocked from this host) state that on Paid Services Google does not use prompts or responses to improve its products, that prompts and responses are logged for a limited period solely for abuse/prohibited-use detection and legal obligations, and that logs expire after a default retention window (reported as 55 days) unless saved to a dataset.",
    zero_data_retention_available: "unknown",
    paid_vs_free_differences:
      "Material. The no-product-improvement commitment is specific to PAID Services; the free tier is documented differently. A B07 production configuration would have to be on the paid tier, and that must be verified in the actual project billing configuration, not assumed.",
    deletion_and_control_constraints:
      "NOT VERIFIED FROM THIS HOST. Zero-data-retention documentation for the Gemini Developer API exists (ai.google.dev/gemini-api/docs/zdr) but could not be read here.",
    security_compliance_notes:
      "Vertex AI and the Gemini Developer API are different products with different data-governance documents; a screen for one does not carry over to the other. Which surface B07 would use is undecided and must be fixed before approval.",
    synthetic_suitability: "synthetic_benchmark_suitable",
    private_gmail_candidacy: "undetermined_official_source_unreachable",
    official_sources: [
      {
        url: "https://ai.google.dev/gemini-api/terms",
        title: "Gemini API Additional Terms of Service (UNREACHABLE from this host)",
      },
      {
        url: "https://ai.google.dev/gemini-api/docs/logs-policy",
        title: "Data logging and sharing (UNREACHABLE from this host)",
      },
      {
        url: "https://ai.google.dev/gemini-api/docs/zdr",
        title: "Zero data retention in the Gemini Developer API (UNREACHABLE from this host)",
      },
    ],
    accessed_at: VENDOR_SCREEN_ACCESSED_AT,
    verification: "secondary_summary_only",
    open_questions: [
      "Re-run this screen from a host with egress to ai.google.dev before any private-Gmail decision.",
      "Decide Gemini Developer API vs Vertex AI; they are screened separately.",
      "Confirm the exact abuse-logging retention window and whether ZDR removes it.",
    ],
  },
] as const;

/**
 * The screen's standing conclusion. Written here rather than in prose so it
 * cannot be softened by a later report template.
 */
export const VENDOR_SCREEN_STANDING_CONCLUSION = [
  "Passing the SYNTHETIC benchmark privacy screen DOES NOT authorize real Gmail processing.",
  "No provider receives real G1/G2 Gmail-derived data until a later explicit privacy/vendor approval for that exact production configuration (D072 §19/§20).",
  "This round sent no provider data of any kind: no API keys were present, so no external call was made.",
] as const;

export function vendorScreenFor(providerId: string): VendorScreenEntry | undefined {
  return VENDOR_SCREEN.find((v) => v.provider_id === providerId);
}
