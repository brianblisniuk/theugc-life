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
 * POLICY (explicit, versioned, deliberately not handicapping any provider):
 * every screening/ceiling candidate is run at its provider's own documented
 * "normal production" reasoning/thinking effort rather than an artificially
 * lowered or raised one. Where a provider exposes no equivalent knob, that is
 * recorded as `not_supported` rather than silently omitted.
 *
 * Bump `INFERENCE_POLICY_VERSION` whenever this policy changes; a version
 * bump participates in result identity via `inferenceConfigDigest`, so old
 * results are never silently reused under a new policy.
 */
import type { Candidate, ProviderId } from "./candidates";
import { digestOf } from "../run/digest";

export const INFERENCE_POLICY_VERSION = "b07_bench_inference_policy_v1";

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

export interface EffectiveInferenceConfig {
  policy_version: string;
  provider_id: ProviderId;
  /** Normalised effort label. `not_supported` when the provider has no equivalent knob. */
  reasoning_effort: ReasoningEffort;
  /** Explicit, so "we relied on an undocumented default" is never true. */
  temperature: number | "provider_default";
  max_output_tokens: number;
  /** Names the exact structured-output request shape version, e.g. after a transport fix. */
  structured_output_transport_version: string;
}

/**
 * One normal-production effort per provider family, stated explicitly rather
 * than left to a provider default that can change without notice. Documented
 * per-model in `config/candidates.ts` notes and printed in every report.
 */
const PROVIDER_DEFAULT_EFFORT: Record<ProviderId, ReasoningEffort> = {
  openai: "medium",
  anthropic: "high",
  google: "medium",
  local: "not_supported",
};

const STRUCTURED_OUTPUT_TRANSPORT_VERSION: Record<ProviderId, string> = {
  // Bump these when the request shape sent to the provider changes (e.g. the
  // Anthropic `output_config.format` fix that dropped the invalid `name`).
  openai: "openai_responses_json_schema_v1",
  anthropic: "anthropic_messages_output_config_json_schema_v2",
  google: "google_generatecontent_responseschema_v2",
  local: "local_deterministic_v1",
};

export function effectiveInferenceConfig(
  candidate: Pick<Candidate, "providerId">,
  maxOutputTokens: number,
): EffectiveInferenceConfig {
  return {
    policy_version: INFERENCE_POLICY_VERSION,
    provider_id: candidate.providerId,
    reasoning_effort: PROVIDER_DEFAULT_EFFORT[candidate.providerId],
    temperature: "provider_default",
    max_output_tokens: maxOutputTokens,
    structured_output_transport_version: STRUCTURED_OUTPUT_TRANSPORT_VERSION[candidate.providerId],
  };
}

/** Canonical digest of the effective config. Participates in result identity. */
export function inferenceConfigDigest(config: EffectiveInferenceConfig): string {
  return digestOf(config);
}
