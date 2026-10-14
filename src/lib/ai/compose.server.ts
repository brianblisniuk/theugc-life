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
import { briefLooksLikeInjection } from "./injection";
import {
  contextCharsFor,
  costMicros,
  estimateCallMicros,
  maxTokensFor,
  poolFloorMicros,
  poolPercentBps,
  regenWeight,
  resolveAssistantModel,
  userBudgetMicros,
  type AssistantTier,
} from "./limits";
import { collaborationPitchOk } from "./postcheck";
import { buildOutreachPrompt, parseDraftText, type OutreachFacts } from "./prompt";
import type { PitchBrief } from "./structured";

export type ComposeStatus =
  | "drafted"
  | "templates_only"
  | "out_of_credits"
  | "monthly_limit"
  | "pool_exhausted"
  | "rate_limited"
  | "paused"
  | "not_unlocked"
  | "injection"
  | "off_topic"
  | "invalid_input"
  | "error";

export interface ComposeOutcome {
  status: ComposeStatus;
  subject?: string;
  body?: string;
  requestId?: string;
  warning?: "budget_80";
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
  hotelId: string;
  brief: PitchBrief;
  prepare: (input: {
    requestId: string;
    model: string;
    hotelId: string;
    estimateMicros: number;
    userBudgetMicros: number;
    regenWeight: number;
    poolFloorMicros: number;
    poolPercentBps: number;
  }) => Promise<
    | "reserved"
    | "already_reserved"
    | "budget"
    | "pool"
    | "rate_limited"
    | "paused"
    | "not_unlocked"
    | { status: "reserved" | "already_reserved"; warning?: "budget_80"; weight: number }
    | "error"
  >;
  finish: (input: {
    requestId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
    status: "completed" | "failed" | "rejected";
    poolFloorMicros: number;
    poolPercentBps: number;
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

  if (!deps.hotelId || !deps.brief) return { status: "invalid_input" };
  if (briefLooksLikeInjection(deps.brief.keyPoints)) return { status: "injection" };
  const floor = poolFloorMicros();
  if (floor === null || !deps.apiKey) return { status: "paused" };

  const tier = tierOf(deps.priority);
  const resolved = resolveAssistantModel(tier);
  if (resolved.provider !== "anthropic") return { status: "error" };
  const model = resolved.model;
  const maxTokens = maxTokensFor(tier);
  const prompt = buildOutreachPrompt({ ...deps.facts, brief: deps.brief }, tier);
  if (prompt.user.length > contextCharsFor(tier)) return { status: "error" };

  const estimate = estimateCallMicros(prompt.system.length + prompt.user.length, maxTokens);
  const requestId = crypto.randomUUID();
  const prepared = await deps.prepare({
    requestId,
    model,
    hotelId: deps.hotelId,
    estimateMicros: estimate.micros,
    userBudgetMicros: userBudgetMicros(tier),
    regenWeight: regenWeight(),
    poolFloorMicros: floor,
    poolPercentBps: poolPercentBps(),
  });
  const preparedStatus = typeof prepared === "string" ? prepared : prepared.status;
  const warning = typeof prepared === "string" ? undefined : prepared.warning;
  const weight =
    typeof prepared === "object" && typeof prepared.weight === "number" ? prepared.weight : 1;
  if (preparedStatus === "rate_limited") return { status: "rate_limited" };
  if (preparedStatus === "paused") return { status: "paused" };
  if (preparedStatus === "budget") return { status: "monthly_limit" };
  if (preparedStatus === "pool") return { status: "pool_exhausted" };
  if (preparedStatus === "not_unlocked") return { status: "not_unlocked" };
  if (preparedStatus === "error") return { status: "error" };
  if (preparedStatus !== "reserved" && preparedStatus !== "already_reserved") {
    return { status: "error" };
  }

  if (weight > 0 && deps.balance < CREDITS_CONFIG.aiDraftCost) {
    await deps.finish({
      requestId,
      model,
      inputTokens: 0,
      outputTokens: 0,
      costMicros: 0,
      status: "rejected",
      poolFloorMicros: floor,
      poolPercentBps: poolPercentBps(),
    });
    return { status: "out_of_credits", requestId };
  }

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
  const draft = result.ok ? parseDraftText(result.text) : null;
  const onTopic =
    result.ok &&
    draft !== null &&
    collaborationPitchOk({
      subject: draft.subject,
      body: draft.body,
      hotelName: deps.facts.hotelName,
    });
  const finishStatus = !result.ok || !draft ? "failed" : onTopic ? "completed" : "rejected";
  await deps.finish({
    requestId,
    model,
    inputTokens,
    outputTokens,
    costMicros: result.ok ? billed : estimate.micros,
    status: finishStatus,
    poolFloorMicros: floor,
    poolPercentBps: poolPercentBps(),
  });
  logger.info(
    "ai.usage",
    tokenLog({
      model,
      inputTokens,
      outputTokens,
      status: finishStatus === "completed" ? "completed" : result.ok ? finishStatus : result.status,
    }),
  );

  if (!result.ok || !draft) return { status: "error", requestId };
  if (!onTopic) return { status: "off_topic", requestId };
  if (weight === 0) {
    return { status: "drafted", subject: draft.subject, body: draft.body, requestId, warning };
  }

  const charged = await deps.charge(`ai_draft:${requestId}`);
  if (charged === "out_of_credits") return { status: "out_of_credits", requestId };
  if (charged !== "charged" && charged !== "already_charged") return { status: "error", requestId };

  return { status: "drafted", subject: draft.subject, body: draft.body, requestId, warning };
}
