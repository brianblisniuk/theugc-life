/**
 * Assistant limits (D141, D145, D162–D164).
 *
 * One model slot per tier. Both slots are Claude Sonnet now. The daily call
 * and token caps are gone: each paid user has a monthly dollar budget.
 * The API key is not read in this module.
 */

export const AI_LIMITS = {
  /** Claude Sonnet 5.5, the latest Sonnet on 2026-10-14. */
  defaultModel: "claude-sonnet-5-5",
  absoluteMaxTokens: 1024,
  proMaxTokens: 400,
  priorityMaxTokens: 800,
  absoluteContextChars: 6000,
  proContextChars: 1800,
  priorityContextChars: 4500,
  selectedMailMax: 3,
  selectedMailChars: 500,
  timeoutMs: 20_000,
  maxRetries: 2,
  /** Sonnet 5.5 list price, USD per million tokens, effective 2026-10-07. */
  inputUsdPerMtok: 2,
  outputUsdPerMtok: 10,
  minMaxTokens: 64,
  rateLimitSeconds: 3,
  generationsPerMinute: 10,
  proBudgetUsd: 5,
  maxBudgetUsd: 15,
  proBudgetCeilingUsd: 50,
  maxBudgetCeilingUsd: 100,
  warningRatio: 0.8,
  regenFreeCount: 3,
  regenWeight: 2,
  poolPercent: 15,
} as const;

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

export type AssistantTier = "pro" | "max";

/** Future slot. This block never selects grok. */
export type AssistantProvider = "anthropic" | "grok";

export interface ResolvedAssistantModel {
  provider: AssistantProvider;
  model: string;
}

function integerSetting(
  raw: string | undefined,
  fallback: number,
  floor: number,
  ceiling: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < floor) return fallback;
  return Math.min(parsed, ceiling);
}

function dollarSetting(raw: string | undefined, fallback: number, ceiling: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, ceiling);
}

/** The configured model. Empty means the default Sonnet. Pro and Max share it. */
export function resolveModel(raw: string | undefined = process.env.ANTHROPIC_MODEL): string {
  const name = (raw ?? "").trim();
  if (name === "") return AI_LIMITS.defaultModel;
  if (!MODEL_ID.test(name)) return AI_LIMITS.defaultModel;
  return name;
}

/**
 * Per-tier model slot (D164). Both tiers are Anthropic Sonnet. A later block
 * can return Grok for Pro and Claude for Max without a second call site.
 */
export function resolveAssistantModel(tier: AssistantTier): ResolvedAssistantModel {
  void tier;
  return { provider: "anthropic", model: resolveModel() };
}

export function maxTokensFor(tier: AssistantTier): number {
  if (tier === "max") {
    return integerSetting(
      process.env.ANTHROPIC_PRIORITY_MAX_TOKENS,
      AI_LIMITS.priorityMaxTokens,
      AI_LIMITS.minMaxTokens,
      AI_LIMITS.absoluteMaxTokens,
    );
  }
  return integerSetting(
    process.env.ANTHROPIC_PRO_MAX_TOKENS,
    AI_LIMITS.proMaxTokens,
    AI_LIMITS.minMaxTokens,
    AI_LIMITS.proMaxTokens,
  );
}

export function contextCharsFor(tier: AssistantTier): number {
  if (tier === "max") {
    return integerSetting(
      process.env.ANTHROPIC_PRIORITY_CONTEXT_CHARS,
      AI_LIMITS.priorityContextChars,
      400,
      AI_LIMITS.absoluteContextChars,
    );
  }
  return integerSetting(
    process.env.ANTHROPIC_PRO_CONTEXT_CHARS,
    AI_LIMITS.proContextChars,
    400,
    AI_LIMITS.proContextChars,
  );
}

/** Monthly user budget in micros. Invalid input keeps the plan default. */
export function userBudgetMicros(tier: AssistantTier): number {
  const dollars =
    tier === "max"
      ? dollarSetting(
          process.env.AI_BUDGET_MAX_USD,
          AI_LIMITS.maxBudgetUsd,
          AI_LIMITS.maxBudgetCeilingUsd,
        )
      : dollarSetting(
          process.env.AI_BUDGET_PRO_USD,
          AI_LIMITS.proBudgetUsd,
          AI_LIMITS.proBudgetCeilingUsd,
        );
  return Math.round(dollars * 1_000_000);
}

/** Weight applied after the free regenerations. The database clamps it to 2–5. */
export function regenWeight(): number {
  return integerSetting(process.env.AI_REGEN_WEIGHT, AI_LIMITS.regenWeight, 2, 5);
}

/**
 * Basis points. 1500 is 15%. Unset, blank, or not a finite number stays at 15%.
 * A finite number is clamped to 15–20% (D188).
 * `ai_pool_snapshot` applies this same clamp. That function is the pool stop.
 */
export function poolPercentBps(
  raw: string | undefined = process.env.AI_GLOBAL_POOL_PERCENT,
): number {
  const fallback = AI_LIMITS.poolPercent * 100;
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const clamped = Math.min(20, Math.max(15, parsed));
  return Math.round(clamped * 100);
}

/**
 * Unset, blank, or not a positive number means there is no floor.
 * The result is USD micros. There is no $100,000 ceiling (D188).
 * A value that is not a safe positive integer number of micros is not a floor.
 * `ai_pool_snapshot` keeps a positive floor and does not cap it at $100,000.
 */
export function readBudgetMicros(
  raw: string | undefined = process.env.ANTHROPIC_MONTHLY_BUDGET_USD,
): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const dollars = Number(raw);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  const micros = Math.round(dollars * 1_000_000);
  if (!Number.isSafeInteger(micros) || micros <= 0) return null;
  return micros;
}

/**
 * Floor of the global pool, in USD micros.
 * Unset, blank, or not a positive number refuses paid generation.
 */
export function poolFloorMicros(): number | null {
  return readBudgetMicros();
}

export function tokenPrices(): { inputUsdPerMtok: number; outputUsdPerMtok: number } {
  return {
    inputUsdPerMtok: dollarSetting(
      process.env.ANTHROPIC_INPUT_USD_PER_MTOK,
      AI_LIMITS.inputUsdPerMtok,
      1000,
    ),
    outputUsdPerMtok: dollarSetting(
      process.env.ANTHROPIC_OUTPUT_USD_PER_MTOK,
      AI_LIMITS.outputUsdPerMtok,
      1000,
    ),
  };
}

/** Micros at the configured list price. Cache reads are counted at the input price. */
export function costMicros(inputTokens: number, outputTokens: number): number {
  const prices = tokenPrices();
  const input = Number.isInteger(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const output = Number.isInteger(outputTokens) && outputTokens > 0 ? outputTokens : 0;
  return input * prices.inputUsdPerMtok + output * prices.outputUsdPerMtok;
}

export function estimateCallMicros(
  inputChars: number,
  maxTokens: number,
): {
  micros: number;
  inputTokens: number;
  outputTokens: number;
} {
  const chars = Number.isFinite(inputChars) && inputChars > 0 ? inputChars : 0;
  const inputTokens = Math.max(1, Math.ceil(chars / 4));
  const outputTokens = Math.max(AI_LIMITS.minMaxTokens, maxTokens);
  const micros = Math.max(1, costMicros(inputTokens, outputTokens));
  return { micros, inputTokens, outputTokens };
}

export function wouldExceedBudget(
  spentMicros: number,
  estimateMicros: number,
  capMicros: number,
): boolean {
  return spentMicros + estimateMicros > capMicros;
}

export function budgetWarning(spentMicros: number, capMicros: number): boolean {
  if (capMicros <= 0) return false;
  return spentMicros * 5 >= capMicros * 4;
}
