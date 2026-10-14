import "server-only";

/**
 * One assistant draft (D142–D145).
 *
 * Free never reaches the model. A failed call is not charged. The returned
 * text is a draft: this module does not send mail.
 * Logs carry token counts only.
 */

import { logger } from "@/lib/logger";
import { CREDITS_CONFIG } from "@/lib/credits/config";

import { completeClaude, type ClaudeRequest, type ClaudeResult } from "./claude.server";
import {
  contextCharsFor,
  costMicros,
  dailyCallCap,
  dailyTokenCap,
  estimateCallMicros,
  maxTokensFor,
  readBudgetMicros,
  resolveModel,
  type AssistantTier,
} from "./limits";
import { buildOutreachPrompt, parseDraftText, type OutreachFacts } from "./prompt";

export type ComposeStatus =
  | "drafted"
  | "templates_only"
  | "out_of_credits"
  | "daily_limit"
  | "rate_limited"
  | "paused"
  | "error";

export interface ComposeOutcome {
  status: ComposeStatus;
  subject?: string;
  body?: string;
  requestId?: string;
}

export interface ComposeDeps {
  fullAi: boolean;
  priority: boolean;
  balance: number | null;
  apiKey: string | null;
  facts: OutreachFacts;
  charge: (
    idempotencyKey: string,
  ) => Promise<"charged" | "already_charged" | "out_of_credits" | "forbidden" | "error">;
  prepare: (input: {
    requestId: string;
    model: string;
    estimateMicros: number;
    budgetMicros: number;
    dailyCalls: number;
    dailyTokens: number;
    estimateInputTokens: number;
    estimateOutputTokens: number;
  }) => Promise<
    | "reserved"
    | "already_reserved"
    | "budget"
    | "daily_calls"
    | "daily_tokens"
    | "rate_limited"
    | "error"
  >;
  finish: (input: {
    requestId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
    status: "completed" | "failed";
  }) => Promise<void>;
  complete?: (request: ClaudeRequest) => Promise<ClaudeResult>;
  now?: () => Date;
}

export function tokenLog(input: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  status: string;
}): {
  model: string;
  inputTokens: number;
  outputTokens: number;
  status: string;
  task: "compose_pitch";
} {
  return {
    task: "compose_pitch",
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    status: input.status,
  };
}

function tierOf(priority: boolean): AssistantTier {
  return priority ? "max" : "pro";
}

export async function composePitch(deps: ComposeDeps): Promise<ComposeOutcome> {
  if (!deps.fullAi) return { status: "templates_only" };
  if (deps.balance === null) return { status: "error" };
  if (deps.balance < CREDITS_CONFIG.aiDraftCost) return { status: "out_of_credits" };

  const budget = readBudgetMicros();
  if (budget === null || !deps.apiKey) return { status: "paused" };

  const tier = tierOf(deps.priority);
  const model = resolveModel();
  const maxTokens = maxTokensFor(tier);
  const prompt = buildOutreachPrompt(deps.facts, tier);
  if (prompt.user.length > contextCharsFor(tier)) return { status: "error" };

  const estimate = estimateCallMicros(prompt.system.length + prompt.user.length, maxTokens);
  const requestId = crypto.randomUUID();
  const prepared = await deps.prepare({
    requestId,
    model,
    estimateMicros: estimate.micros,
    budgetMicros: budget,
    dailyCalls: dailyCallCap(),
    dailyTokens: dailyTokenCap(),
    estimateInputTokens: estimate.inputTokens,
    estimateOutputTokens: estimate.outputTokens,
  });
  if (prepared === "daily_calls" || prepared === "daily_tokens") return { status: "daily_limit" };
  if (prepared === "rate_limited") return { status: "rate_limited" };
  if (prepared === "budget") return { status: "paused" };
  if (prepared === "error") return { status: "error" };

  const complete = deps.complete ?? completeClaude;
  let result: ClaudeResult;
  try {
    result = await complete({
      apiKey: deps.apiKey,
      model,
      maxTokens,
      system: prompt.system,
      user: prompt.user,
    });
  } catch {
    result = { ok: false, status: "http", inputTokens: 0, outputTokens: 0 };
  }

  const inputTokens = result.inputTokens;
  const outputTokens = result.outputTokens;
  const billed = result.ok
    ? costMicros(inputTokens, outputTokens)
    : Math.max(estimate.micros, costMicros(inputTokens, outputTokens));
  await deps.finish({
    requestId,
    model,
    inputTokens,
    outputTokens,
    costMicros: result.ok ? billed : estimate.micros,
    status: result.ok ? "completed" : "failed",
  });
  logger.info(
    "ai.usage",
    tokenLog({
      model,
      inputTokens,
      outputTokens,
      status: result.ok ? "completed" : result.status,
    }),
  );

  if (!result.ok) return { status: "error", requestId };
  const draft = parseDraftText(result.text);
  if (!draft) return { status: "error", requestId };

  const charged = await deps.charge(`ai_draft:${requestId}`);
  if (charged === "out_of_credits") return { status: "out_of_credits", requestId };
  if (charged !== "charged" && charged !== "already_charged") return { status: "error", requestId };

  return { status: "drafted", subject: draft.subject, body: draft.body, requestId };
}
