/**
 * Effective inference configuration — versioned, and part of result identity.
 *
 * External audit finding: recording model/prompt/schema was not enough,
 * because provider defaults differ (OpenAI reasoning effort, Anthropic
 * thinking effort, Google thinking level) and are mutable/undocumented over
 * time. Two runs of the "same" candidate with a different effective inference
 * behaviour are NOT the same benchmark evidence and must never be merged into
 * one score by a resume.
 *
 * SECOND external audit finding (this round): a provider-wide config is not
 * enough EITHER. Anthropic's own model lineup has models with materially
 * different capability contracts — Claude Sonnet 5 supports ONLY adaptive
 * thinking (`thinking:{type:"adaptive"}`; manual `{type:"enabled",...}` is
 * rejected with HTTP 400) with effort at `output_config.effort`, while Claude
 * Haiku 4.5 supports NEITHER adaptive thinking NOR `output_config.effort` —
 * only a legacy, opt-in `{type:"enabled", budget_tokens}` shape, which this
 * round's Haiku screening candidate deliberately does NOT enable (ordinary,
 * non-thinking configuration). Deriving inference config from `provider_id`
 * alone conflated these two into one wrong request shape. This file now
 * derives the shape from the exact candidate model id — never provider_id
 * alone — and stamps a `model_capability_profile` that changes whenever the
 * active model's capability contract changes, in addition to the fields that
 * actually vary (`thinking_mode`, `effort`, `budget_tokens`).
 *
 * POLICY (explicit, versioned, deliberately not handicapping any provider):
 * every screening/ceiling candidate is run at its provider's own documented
 * "normal production" reasoning/thinking effort rather than an artificially
 * lowered or raised one, WITHIN what that exact model actually supports.
 * Where a provider (or a specific model) exposes no equivalent knob, that is
 * recorded as `not_supported` rather than silently omitted or borrowed from a
 * different model's configuration.
 *
 * Bump `INFERENCE_POLICY_VERSION` whenever this policy changes; a version
 * bump participates in result identity via `inferenceConfigDigest`, so old
 * results (including every result computed under the pre-fix
 * `thinking:{type:"enabled",effort:...}` shape) are never silently reused
 * under the new policy.
 */
import type { Candidate, ProviderId } from "./candidates";
import { digestOf } from "../run/digest";

export const INFERENCE_POLICY_VERSION =
  "b07_bench_inference_policy_v2_anthropic_model_capability_aware";

/** Reasoning/thinking effort vocabulary normalised across providers for the report. */
export const REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "not_supported",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * Anthropic-style thinking transport shape actually sent on the wire.
 * `adaptive`  — `thinking: { type: "adaptive" }` (current-generation models;
 *               effort is a separate `output_config.effort` knob).
 * `extended`  — legacy `thinking: { type: "enabled", budget_tokens }`
 *               (older models only; must be explicitly opted into).
 * `disabled`  — no `thinking` parameter sent at all. Used both for Anthropic
 *               models that do not support thinking in this round's
 *               configuration (Claude Haiku 4.5) and, by convention, for
 *               every non-Anthropic provider (their own reasoning knob is
 *               carried in `reasoning_effort`/`effort`, not this field).
 */
export const THINKING_MODES = ["adaptive", "extended", "disabled"] as const;
export type ThinkingMode = (typeof THINKING_MODES)[number];

export interface EffectiveInferenceConfig {
  policy_version: string;
  provider_id: ProviderId;
  /**
   * Identifies the exact model-capability contract this config was derived
   * from. Two candidates on the same provider with different capabilities
   * (e.g. `anthropic-sonnet-5` vs `anthropic-haiku-4-5`) MUST never share a
   * value here — this is what makes config identity candidate/model
   * specific rather than provider-wide.
   */
  model_capability_profile: string;
  /** See `ThinkingMode`. Always `"disabled"` for non-Anthropic providers. */
  thinking_mode: ThinkingMode;
  /**
   * `output_config.effort` value actually sent, or `null` when the active
   * model has no such knob (e.g. Claude Haiku 4.5 in this round, or any
   * non-Anthropic provider — their effort travels in `reasoning_effort`
   * instead of this Anthropic-specific field).
   */
  effort: ReasoningEffort | null;
  /**
   * Legacy `thinking.budget_tokens`, or `null` unless `thinking_mode ===
   * "extended"`. Must stay below `max_output_tokens` when set.
   */
  budget_tokens: number | null;
  /**
   * Normalised effort label used cross-provider in the report table. For
   * Anthropic this mirrors `effort` when the model supports one; it is
   * `not_supported` — NEVER a value borrowed from a different Anthropic
   * model's configuration — when the active model has no effort knob at all
   * (Claude Haiku 4.5 in this round's non-thinking configuration).
   */
  reasoning_effort: ReasoningEffort;
  /** Explicit, so "we relied on an undocumented default" is never true. */
  temperature: number | "provider_default";
  max_output_tokens: number;
  /** Names the exact structured-output request shape version, e.g. after a transport fix. */
  structured_output_transport_version: string;
}

const STRUCTURED_OUTPUT_TRANSPORT_VERSION: Record<ProviderId, string> = {
  openai: "openai_responses_json_schema_v1",
  // Bumped (external audit correction, this round): the invalid
  // `thinking:{type:"enabled",effort}` shape is gone; thinking and effort are
  // now derived per exact model id rather than provider-wide.
  anthropic: "anthropic_messages_output_config_json_schema_v3_model_capability_aware",
  google: "google_generatecontent_responseschema_v2",
  local: "local_deterministic_v1",
};

interface AnthropicCapability {
  profile: string;
  thinking_mode: ThinkingMode;
  effort: ReasoningEffort | null;
  budget_tokens: number | null;
  reasoning_effort: ReasoningEffort;
}

/**
 * Per-EXACT-model-id Anthropic capability contract. Never derived from
 * `provider_id` alone (that was the defect this round fixes).
 *
 * LOCKED FOR THIS ROUND (official docs cited in the round spec, accessed
 * 2026-09-12):
 *  - `claude-sonnet-5`: adaptive thinking is the ONLY on-mode; manual
 *    `{type:"enabled",...}` returns HTTP 400. Effort lives at
 *    `output_config.effort`, not inside `thinking`. This screening round
 *    uses `effort: "medium"` deliberately — a narrow classification task,
 *    cost-conscious, with candidate identity already binding this exact
 *    config so a later higher-effort experiment is separate evidence.
 *  - `claude-haiku-4-5*` (including the pinned dated snapshot id): does NOT
 *    support adaptive thinking and does NOT support `output_config.effort`.
 *    Legacy extended thinking exists but is explicitly NOT enabled for this
 *    screening candidate — ordinary, non-thinking configuration. Never
 *    labelled `reasoning_effort: "high"` (or any effort at all) as a result.
 *  - `claude-opus-5`: adaptive by default (kept here for the ceiling
 *    candidate, not run in this Stage-1 round) at this policy's normal
 *    "high" production effort.
 *  - any other/unrecognised Anthropic model id: falls back to the legacy
 *    `enabled` + `budget_tokens` shape, the historically safe behaviour for
 *    older Claude generations that predate adaptive thinking. This benchmark
 *    intentionally never GUESSES that an unrecognised future model id
 *    supports adaptive thinking — a new model gets its own explicit branch
 *    here, verified against official docs, before running it for real.
 */
function anthropicCapability(model: string): AnthropicCapability {
  if (model.startsWith("claude-sonnet-5")) {
    return {
      profile: "anthropic_claude_sonnet_5_adaptive_effort_medium_v1",
      thinking_mode: "adaptive",
      effort: "medium",
      budget_tokens: null,
      reasoning_effort: "medium",
    };
  }
  if (model.startsWith("claude-haiku-4-5")) {
    return {
      profile: "anthropic_claude_haiku_4_5_no_thinking_v1",
      thinking_mode: "disabled",
      effort: null,
      budget_tokens: null,
      reasoning_effort: "not_supported",
    };
  }
  if (model.startsWith("claude-opus-5")) {
    return {
      profile: "anthropic_claude_opus_5_adaptive_effort_high_v1",
      thinking_mode: "adaptive",
      effort: "high",
      budget_tokens: null,
      reasoning_effort: "high",
    };
  }
  return {
    profile: `anthropic_legacy_extended_thinking_v1(${model})`,
    thinking_mode: "extended",
    effort: null,
    budget_tokens: 4096,
    reasoning_effort: "not_supported",
  };
}

/** Non-Anthropic providers keep the prior provider-wide policy — unaffected by this fix. */
const NON_ANTHROPIC_DEFAULT_EFFORT: Record<Exclude<ProviderId, "anthropic">, ReasoningEffort> = {
  openai: "medium",
  google: "medium",
  local: "not_supported",
};

export function effectiveInferenceConfig(
  candidate: Pick<Candidate, "providerId" | "model">,
  maxOutputTokens: number,
): EffectiveInferenceConfig {
  if (candidate.providerId === "anthropic") {
    const cap = anthropicCapability(candidate.model);
    return {
      policy_version: INFERENCE_POLICY_VERSION,
      provider_id: candidate.providerId,
      model_capability_profile: cap.profile,
      thinking_mode: cap.thinking_mode,
      effort: cap.effort,
      budget_tokens: cap.budget_tokens,
      reasoning_effort: cap.reasoning_effort,
      temperature: "provider_default",
      max_output_tokens: maxOutputTokens,
      structured_output_transport_version: STRUCTURED_OUTPUT_TRANSPORT_VERSION.anthropic,
    };
  }

  const reasoning_effort = NON_ANTHROPIC_DEFAULT_EFFORT[candidate.providerId];
  return {
    policy_version: INFERENCE_POLICY_VERSION,
    provider_id: candidate.providerId,
    model_capability_profile: `${candidate.providerId}_provider_default_v1`,
    thinking_mode: "disabled",
    effort: null,
    budget_tokens: null,
    reasoning_effort,
    temperature: "provider_default",
    max_output_tokens: maxOutputTokens,
    structured_output_transport_version: STRUCTURED_OUTPUT_TRANSPORT_VERSION[candidate.providerId],
  };
}

/** Canonical digest of the effective config. Participates in result identity. */
export function inferenceConfigDigest(config: EffectiveInferenceConfig): string {
  return digestOf(config);
}
