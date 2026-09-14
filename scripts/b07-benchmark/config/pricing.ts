/**
 * Price metadata for cost ESTIMATION.
 *
 * Rules this file exists to enforce:
 *
 *  1. estimated pricing is never presented as measured billing — every figure
 *     derived from here is labelled `estimated_from_published_prices`;
 *  2. every price carries a source, a source URL and an accessed date, so a
 *     stale price is visible rather than silently wrong;
 *  3. an UNVERIFIED or MISSING price NEVER becomes a numeric $0 — a candidate
 *     with no verified price has cost `null`/"unavailable", and the scorer
 *     must never claim it is cheaper than anything on that basis (external
 *     audit finding 8);
 *  4. reasoning/thinking tokens are billed EXACTLY ONCE. Whether they are a
 *     free-standing charge or already inside `output_tokens` is
 *     provider-specific: OpenAI and Anthropic both bill them AS PART OF
 *     output tokens (`reasoning_billed_separately_from_output: false`);
 *     Google's own response-pricing documentation sums output tokens AND
 *     thinking tokens as separate billed quantities
 *     (`reasoning_billed_separately_from_output: true`). Copying one
 *     provider's accounting onto another double- or under-charges it
 *     (external audit findings 6, 7, 9).
 *
 * `verification` records how the price was obtained IN THIS ENVIRONMENT.
 * `published_page_fetched` means the official page was read directly (or, for
 * this correction round, handed down from the product/architecture owner as
 * an independently-verified official fact with a source URL and access date —
 * still distinct from a live re-fetch, which is why the URL and date are kept
 * alongside every figure). `unverified_egress_blocked` means the official
 * source could not be reached from the benchmark host.
 * `unverified_not_checked` means no official figure has been captured for
 * this exact model id at all (for example a freshly-pinned PREVIEW id) — in
 * every unverified case the numeric rate fields are `null`, never `0`.
 */

export const PRICE_VERIFICATIONS = [
  "published_page_fetched",
  "unverified_egress_blocked",
  "unverified_not_checked",
] as const;
export type PriceVerification = (typeof PRICE_VERIFICATIONS)[number];

export interface PriceBook {
  /** Candidate id this price applies to. */
  candidate_id: string;
  /** `null` means "no verified rate" — NEVER treat as $0. */
  input_usd_per_mtok: number | null;
  /**
   * Rate for the CACHED subset of input tokens, when the provider exposes
   * cached-input token counts. `null` is fine when the candidate has no
   * cached tokens in a given run: the estimator only requires this rate when
   * `cachedInputTokens > 0` for that run.
   */
  cached_input_usd_per_mtok: number | null;
  output_usd_per_mtok: number | null;
  /**
   * Rate applied to reasoning/thinking tokens IF AND ONLY IF
   * `reasoning_billed_separately_from_output` is true. When false, this value
   * is documentation only — reasoning tokens are already inside
   * `output_tokens` and pricing them again would double-charge.
   */
  reasoning_usd_per_mtok: number | null;
  /**
   * Whether the provider bills reasoning/thinking tokens as an ADDITIONAL
   * charge on top of `output_tokens` (Google), or whether they are already
   * counted inside `output_tokens` (OpenAI, Anthropic). This is a BILLING
   * fact, independent of whether the provider also happens to report the
   * count separately for diagnostics — OpenAI and Anthropic both report the
   * count separately while billing it only once.
   */
  reasoning_billed_separately_from_output: boolean;
  source: string;
  source_url: string;
  accessed_at: string;
  verification: PriceVerification;
  notes?: string;
}

const ANTHROPIC_SOURCE = "Anthropic — Claude models overview / pricing";
const ANTHROPIC_URL = "https://platform.claude.com/docs/en/about-claude/models/overview";
const ACCESSED = "2026-09-12";

const OPENAI_LUNA_SOURCE = "OpenAI — GPT-5.6 Luna model page";
const OPENAI_LUNA_URL = "https://developers.openai.com/api/docs/models/gpt-5.6-luna";
const OPENAI_TERRA_SOURCE = "OpenAI — GPT-5.6 Terra model page";
const OPENAI_TERRA_URL = "https://developers.openai.com/api/docs/models/gpt-5.6-terra";

const GOOGLE_FLASH_SOURCE = "Google — Gemini 3.8 Flash model page / pricing";
const GOOGLE_FLASH_MODEL_URL = "https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash";
const GOOGLE_PRICING_URL = "https://ai.google.dev/gemini-api/docs/pricing";

export const PRICE_BOOK: readonly PriceBook[] = [
  {
    candidate_id: "anthropic-sonnet-5",
    input_usd_per_mtok: 2.0,
    cached_input_usd_per_mtok: null,
    output_usd_per_mtok: 10.0,
    reasoning_usd_per_mtok: 10.0,
    reasoning_billed_separately_from_output: false,
    source: ANTHROPIC_SOURCE,
    source_url: ANTHROPIC_URL,
    accessed_at: ACCESSED,
    verification: "published_page_fetched",
    notes:
      "Adaptive thinking tokens are billed as output tokens and are already included in output_tokens; do not add reasoning_usd_per_mtok on top.",
  },
  {
    candidate_id: "anthropic-haiku-4-5",
    input_usd_per_mtok: 1.0,
    cached_input_usd_per_mtok: null,
    output_usd_per_mtok: 5.0,
    reasoning_usd_per_mtok: 5.0,
    reasoning_billed_separately_from_output: false,
    source: ANTHROPIC_SOURCE,
    source_url: ANTHROPIC_URL,
    accessed_at: ACCESSED,
    verification: "published_page_fetched",
  },
  {
    candidate_id: "anthropic-opus-5",
    input_usd_per_mtok: 5.0,
    cached_input_usd_per_mtok: null,
    output_usd_per_mtok: 25.0,
    reasoning_usd_per_mtok: 25.0,
    reasoning_billed_separately_from_output: false,
    source: ANTHROPIC_SOURCE,
    source_url: ANTHROPIC_URL,
    accessed_at: ACCESSED,
    verification: "published_page_fetched",
    notes: "Quality-ceiling candidate only.",
  },
  {
    candidate_id: "openai-gpt-5-6-luna",
    input_usd_per_mtok: 0.2,
    cached_input_usd_per_mtok: 0.02,
    output_usd_per_mtok: 1.2,
    // FIXED (external audit finding 7): reasoning_tokens is a BREAKDOWN of
    // output_tokens for the Responses API, not an additional charge above it
    // (total_tokens = input_tokens + output_tokens, never
    // + reasoning_tokens). This rate is documentation only.
    reasoning_usd_per_mtok: 1.2,
    reasoning_billed_separately_from_output: false,
    source: OPENAI_LUNA_SOURCE,
    source_url: OPENAI_LUNA_URL,
    accessed_at: "2026-09-12",
    verification: "published_page_fetched",
    notes:
      "Figures handed down as independently-verified official facts for this correction round (egress to developers.openai.com is still blocked from this benchmark host); re-fetch before any spending decision.",
  },
  {
    candidate_id: "openai-gpt-5-6-terra",
    input_usd_per_mtok: 2.0,
    cached_input_usd_per_mtok: 0.2,
    output_usd_per_mtok: 12.0,
    reasoning_usd_per_mtok: 12.0,
    reasoning_billed_separately_from_output: false,
    source: OPENAI_TERRA_SOURCE,
    source_url: OPENAI_TERRA_URL,
    accessed_at: "2026-09-12",
    verification: "published_page_fetched",
    notes: "See openai-gpt-5-6-luna note.",
  },
  {
    candidate_id: "google-gemini-flash",
    input_usd_per_mtok: 0.75,
    cached_input_usd_per_mtok: null,
    output_usd_per_mtok: 3.75,
    // FIXED (external audit finding 9): Google's response-pricing sums output
    // tokens AND thinking tokens as SEPARATE billed quantities, at the same
    // published rate. Do not copy OpenAI/Anthropic's inclusive accounting.
    reasoning_usd_per_mtok: 3.75,
    reasoning_billed_separately_from_output: true,
    source: GOOGLE_FLASH_SOURCE,
    source_url: `${GOOGLE_FLASH_MODEL_URL} ; ${GOOGLE_PRICING_URL}`,
    accessed_at: "2026-09-12",
    verification: "published_page_fetched",
    notes:
      "Introductory paid price documented through 2026-12-31; re-verify after that date before quoting this figure.",
  },
  {
    candidate_id: "google-gemini-pro",
    // FIXED (external audit finding 8): no official price was captured for
    // gemini-3.1-pro-preview this round. NULL, never $0 — a $0 estimate is
    // decision-corrupting (it would make this candidate look free/cheapest).
    input_usd_per_mtok: null,
    cached_input_usd_per_mtok: null,
    output_usd_per_mtok: null,
    reasoning_usd_per_mtok: null,
    reasoning_billed_separately_from_output: true,
    source: "Google Gemini API pricing — NOT CAPTURED for gemini-3.1-pro-preview",
    source_url: GOOGLE_PRICING_URL,
    accessed_at: ACCESSED,
    verification: "unverified_not_checked",
    notes:
      "PREVIEW model id; capture an official price before quoting any cost figure or Pareto claim for this candidate.",
  },
] as const;

export function priceBookFor(candidateId: string): PriceBook | null {
  return PRICE_BOOK.find((p) => p.candidate_id === candidateId) ?? null;
}

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** A SUBSET of inputTokens, never additional to it. */
  cachedInputTokens: number;
}

/**
 * Estimated USD for a token total, or `null` when the price is not fully
 * verified for the token dimensions actually used. `null` must propagate to
 * the caller as "unavailable" — it must never be coerced to 0.
 */
export function estimateCaseCostUsd(price: PriceBook, totals: TokenTotals): number | null {
  if (price.input_usd_per_mtok === null || price.output_usd_per_mtok === null) return null;
  if (totals.cachedInputTokens > 0 && price.cached_input_usd_per_mtok === null) return null;
  if (
    price.reasoning_billed_separately_from_output &&
    totals.reasoningTokens > 0 &&
    price.reasoning_usd_per_mtok === null
  ) {
    return null;
  }

  const perToken = (usdPerMtok: number, tokens: number): number =>
    (usdPerMtok * tokens) / 1_000_000;
  const nonCachedInput = Math.max(0, totals.inputTokens - totals.cachedInputTokens);

  let cost =
    perToken(price.input_usd_per_mtok, nonCachedInput) +
    perToken(price.output_usd_per_mtok, totals.outputTokens);

  if (totals.cachedInputTokens > 0 && price.cached_input_usd_per_mtok !== null) {
    cost += perToken(price.cached_input_usd_per_mtok, totals.cachedInputTokens);
  }
  if (price.reasoning_billed_separately_from_output && price.reasoning_usd_per_mtok !== null) {
    cost += perToken(price.reasoning_usd_per_mtok, totals.reasoningTokens);
  }
  return cost;
}
