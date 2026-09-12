/**
 * Price metadata for cost ESTIMATION.
 *
 * Two rules this file exists to enforce:
 *
 *  1. estimated pricing is never presented as measured billing — every figure
 *     derived from here is labelled `estimated_from_published_prices`;
 *  2. every price carries a source, a source URL and an accessed date, so a
 *     stale price is visible rather than silently wrong.
 *
 * `verification` records how the price was obtained IN THIS ENVIRONMENT.
 * `published_page_fetched` means the official page was read directly.
 * `unverified_egress_blocked` means the official source could not be reached
 * from the benchmark host and the figure must be re-checked before any
 * spending decision is made on it.
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
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
  /**
   * Price applied to reasoning/thinking tokens. Providers that bill reasoning
   * tokens at the output rate set this equal to `output_usd_per_mtok`; a
   * provider that does not expose reasoning tokens still records the rate so
   * that a later run with exposed counts prices them rather than ignoring them.
   */
  reasoning_usd_per_mtok: number;
  /**
   * Whether the provider reports reasoning tokens SEPARATELY from output
   * tokens. When false, reasoning tokens are already inside `output_tokens`
   * and must not be charged twice.
   */
  reasoning_tokens_reported_separately: boolean;
  source: string;
  source_url: string;
  accessed_at: string;
  verification: PriceVerification;
  notes?: string;
}

const ANTHROPIC_SOURCE = "Anthropic — Claude models overview / pricing";
const ANTHROPIC_URL = "https://platform.claude.com/docs/en/about-claude/models/overview";
const ACCESSED = "2026-09-12";

/**
 * Anthropic figures were read directly from the official models overview on
 * the accessed date. OpenAI and Google pricing pages were NOT reachable from
 * this benchmark host (the egress proxy blocks `platform.openai.com`,
 * `developers.openai.com` and `ai.google.dev`), so their entries are recorded
 * as placeholders with `unverified_egress_blocked` and a null-safe default of
 * zero — a zero price produces a visibly absurd $0.00 estimate rather than a
 * plausible-looking fabricated number.
 */
export const PRICE_BOOK: readonly PriceBook[] = [
  {
    candidate_id: "anthropic-sonnet-5",
    input_usd_per_mtok: 2.0,
    output_usd_per_mtok: 10.0,
    reasoning_usd_per_mtok: 10.0,
    reasoning_tokens_reported_separately: false,
    source: ANTHROPIC_SOURCE,
    source_url: ANTHROPIC_URL,
    accessed_at: ACCESSED,
    verification: "published_page_fetched",
    notes:
      "Adaptive thinking tokens are billed as output tokens and are included in output_tokens.",
  },
  {
    candidate_id: "anthropic-haiku-4-5",
    input_usd_per_mtok: 1.0,
    output_usd_per_mtok: 5.0,
    reasoning_usd_per_mtok: 5.0,
    reasoning_tokens_reported_separately: false,
    source: ANTHROPIC_SOURCE,
    source_url: ANTHROPIC_URL,
    accessed_at: ACCESSED,
    verification: "published_page_fetched",
  },
  {
    candidate_id: "anthropic-opus-5",
    input_usd_per_mtok: 5.0,
    output_usd_per_mtok: 25.0,
    reasoning_usd_per_mtok: 25.0,
    reasoning_tokens_reported_separately: false,
    source: ANTHROPIC_SOURCE,
    source_url: ANTHROPIC_URL,
    accessed_at: ACCESSED,
    verification: "published_page_fetched",
    notes: "Quality-ceiling candidate only.",
  },
  {
    candidate_id: "openai-gpt-5-6-luna",
    input_usd_per_mtok: 0,
    output_usd_per_mtok: 0,
    reasoning_usd_per_mtok: 0,
    reasoning_tokens_reported_separately: true,
    source: "OpenAI API pricing — NOT VERIFIED FROM THIS HOST",
    source_url: "https://platform.openai.com/docs/pricing",
    accessed_at: ACCESSED,
    verification: "unverified_egress_blocked",
    notes:
      "Placeholder. Populate before quoting any cost figure for this candidate; a $0 estimate means the price was never verified.",
  },
  {
    candidate_id: "openai-gpt-5-6-terra",
    input_usd_per_mtok: 0,
    output_usd_per_mtok: 0,
    reasoning_usd_per_mtok: 0,
    reasoning_tokens_reported_separately: true,
    source: "OpenAI API pricing — NOT VERIFIED FROM THIS HOST",
    source_url: "https://platform.openai.com/docs/pricing",
    accessed_at: ACCESSED,
    verification: "unverified_egress_blocked",
    notes: "Placeholder. See openai-gpt-5-6-luna note.",
  },
  {
    candidate_id: "google-gemini-flash",
    input_usd_per_mtok: 0,
    output_usd_per_mtok: 0,
    reasoning_usd_per_mtok: 0,
    reasoning_tokens_reported_separately: true,
    source: "Google Gemini API pricing — NOT VERIFIED FROM THIS HOST",
    source_url: "https://ai.google.dev/gemini-api/docs/pricing",
    accessed_at: ACCESSED,
    verification: "unverified_egress_blocked",
    notes: "Placeholder. See openai-gpt-5-6-luna note.",
  },
  {
    candidate_id: "google-gemini-pro",
    input_usd_per_mtok: 0,
    output_usd_per_mtok: 0,
    reasoning_usd_per_mtok: 0,
    reasoning_tokens_reported_separately: true,
    source: "Google Gemini API pricing — NOT VERIFIED FROM THIS HOST",
    source_url: "https://ai.google.dev/gemini-api/docs/pricing",
    accessed_at: ACCESSED,
    verification: "unverified_egress_blocked",
    notes: "Placeholder. See openai-gpt-5-6-luna note.",
  },
] as const;

export function priceBookFor(candidateId: string): PriceBook | null {
  return PRICE_BOOK.find((p) => p.candidate_id === candidateId) ?? null;
}

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/** Estimated USD for a token total. Reasoning tokens are never dropped. */
export function estimateCaseCostUsd(price: PriceBook, totals: TokenTotals): number {
  const perToken = (usdPerMtok: number, tokens: number): number =>
    (usdPerMtok * tokens) / 1_000_000;
  const base =
    perToken(price.input_usd_per_mtok, totals.inputTokens) +
    perToken(price.output_usd_per_mtok, totals.outputTokens);
  const reasoning = price.reasoning_tokens_reported_separately
    ? perToken(price.reasoning_usd_per_mtok, totals.reasoningTokens)
    : 0;
  return base + reasoning;
}
