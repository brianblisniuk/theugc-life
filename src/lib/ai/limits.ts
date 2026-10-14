/**
 * Assistant limits (D141, D145).
 *
 * One model id for every paid tier. Max raises the context and token caps.
 * Those caps cannot be raised from the environment past the ceilings here.
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
  dailyCallsDefault: 15,
  dailyCallsCeiling: 40,
  dailyTokensDefault: 20_000,
  dailyTokensCeiling: 80_000,
  /** Sonnet 5.5 list price, USD per million tokens, effective 2026-10-07. */
  inputUsdPerMtok: 2,
  outputUsdPerMtok: 10,
  minMaxTokens: 64,
  rateLimitSeconds: 3,
} as const;

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

export type AssistantTier = "pro" | "max";

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

/** The configured model. Empty means the default Sonnet. Pro and Max share it. */
export function resolveModel(raw: string | undefined = process.env.ANTHROPIC_MODEL): string {
  const name = (raw ?? "").trim();
  if (name === "") return AI_LIMITS.defaultModel;
  if (!MODEL_ID.test(name)) return AI_LIMITS.defaultModel;
  return name;
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

export function dailyCallCap(): number {
  return integerSetting(
    process.env.ANTHROPIC_USER_DAILY_CALLS,
    AI_LIMITS.dailyCallsDefault,
    1,
    AI_LIMITS.dailyCallsCeiling,
  );
}

export function dailyTokenCap(): number {
  return integerSetting(
    process.env.ANTHROPIC_USER_DAILY_TOKENS,
    AI_LIMITS.dailyTokensDefault,
    1,
    AI_LIMITS.dailyTokensCeiling,
  );
}

/**
 * Unset, blank, or not a positive number means the call is refused.
 * The result is USD micros. The ceiling is $100,000 in a month.
 */
export function readBudgetMicros(
  raw: string | undefined = process.env.ANTHROPIC_MONTHLY_BUDGET_USD,
): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const dollars = Number(raw);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  const micros = Math.round(dollars * 1_000_000);
  if (micros <= 0 || micros > 100_000_000_000) return null;
  return micros;
}

/** Micros at list price. Cache reads are counted at the input price, which over-estimates. */
export function costMicros(inputTokens: number, outputTokens: number): number {
  const input = Number.isInteger(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const output = Number.isInteger(outputTokens) && outputTokens > 0 ? outputTokens : 0;
  return input * AI_LIMITS.inputUsdPerMtok + output * AI_LIMITS.outputUsdPerMtok;
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
