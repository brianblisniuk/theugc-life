/**
 * The candidate matrix — configuration, not code.
 *
 * FUTURE-PROOFING RULE (task): nothing here may lock the product to one
 * provider or model. This file is benchmark configuration for an evaluation;
 * `src/` never imports it, and the production B07 inference architecture is a
 * separate, later decision that this round only supplies evidence for.
 *
 * Model identifiers are configuration values, overridable per run via
 * `B07_BENCH_MODEL_<CANDIDATE_ID>` so a renamed model never fails the round.
 * Availability is verified at execution time against the provider's own model
 * listing; a model that is gone is recorded `unavailable`, never faked.
 */

export const PROVIDER_IDS = ["openai", "anthropic", "google", "local"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const CANDIDATE_ROLES = ["baseline", "screening", "ceiling"] as const;
export type CandidateRole = (typeof CANDIDATE_ROLES)[number];

export interface Candidate {
  id: string;
  providerId: ProviderId;
  /** Model id as sent to the provider. Overridable by env (see `resolveModel`). */
  model: string;
  role: CandidateRole;
  /** Human-readable family label for the report. */
  family: string;
  /**
   * How confident the authoring round is that this exact id is currently
   * served. `unverified_at_authoring` means: check at execution time.
   */
  idVerification: "verified_at_authoring" | "unverified_at_authoring";
  notes?: string;
}

/**
 * Stage-0 deterministic baseline. Explicitly NOT a production candidate.
 */
export const BASELINE_CANDIDATE: Candidate = {
  id: "benchmark-rules-baseline",
  providerId: "local",
  model: "benchmark-lexical-rules-v1",
  role: "baseline",
  family: "BENCHMARK BASELINE — NOT PRODUCTION B07 IMPLEMENTATION",
  idVerification: "verified_at_authoring",
  notes:
    "Deliberately simple lexical rules, present only to give the model candidates a floor to beat.",
};

export const MODEL_CANDIDATES: readonly Candidate[] = [
  {
    id: "openai-gpt-5-6-luna",
    providerId: "openai",
    model: "gpt-5.6-luna",
    role: "screening",
    family: "OpenAI GPT-5.6 Luna",
    idVerification: "unverified_at_authoring",
    notes:
      "Named in the round specification. The exact API id could not be confirmed from this host (OpenAI docs are egress-blocked); verify at execution time or override with B07_BENCH_MODEL_OPENAI_GPT_5_6_LUNA.",
  },
  {
    id: "openai-gpt-5-6-terra",
    providerId: "openai",
    model: "gpt-5.6-terra",
    role: "screening",
    family: "OpenAI GPT-5.6 Terra",
    idVerification: "unverified_at_authoring",
    notes: "See openai-gpt-5-6-luna note.",
  },
  {
    id: "anthropic-sonnet-5",
    providerId: "anthropic",
    model: "claude-sonnet-5",
    role: "screening",
    family: "Anthropic Claude Sonnet 5 (current Sonnet tier)",
    idVerification: "verified_at_authoring",
    notes: "Model id read from the official Claude models overview on 2026-09-12.",
  },
  {
    id: "anthropic-haiku-4-5",
    providerId: "anthropic",
    model: "claude-haiku-4-5-20251001",
    role: "screening",
    family: "Anthropic Claude Haiku 4.5 (current efficient tier)",
    idVerification: "verified_at_authoring",
    notes:
      "The round specification said 'Fable/efficient tier'. On the official lineup Fable is the MOST capable tier ($10/$50 per MTok), not the efficient one; Haiku 4.5 is the efficient tier. Both are configured — Haiku here as the efficient screening candidate, Fable is not included because a ceiling candidate at Opus tier is cheaper and sufficient. FIXED (external audit finding 10): pinned to the exact dated API id `claude-haiku-4-5-20251001` rather than the floating `claude-haiku-4-5` alias, because a benchmark identity must be reproducible; the alias remains available as an override via B07_BENCH_MODEL_ANTHROPIC_HAIKU_4_5 if a later dated snapshot supersedes it.",
  },
  {
    id: "google-gemini-flash",
    providerId: "google",
    model: "gemini-3.8-flash",
    role: "screening",
    family: "Google Gemini 3.8 Flash (stable, GA)",
    idVerification: "verified_at_authoring",
    notes:
      "FIXED (external audit finding 10): `gemini-flash-latest` is a hot-swapped alias per Google's own documentation and is not an appropriate default identity for a reproducible benchmark. Pinned to the GA stable id `gemini-3.8-flash` (https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash, accessed 2026-09-12). Override with B07_BENCH_MODEL_GOOGLE_GEMINI_FLASH if this id moves.",
  },
  {
    id: "google-gemini-pro",
    providerId: "google",
    model: "gemini-3.1-pro-preview",
    role: "screening",
    family: "Google Gemini 3.1 Pro (PREVIEW — not GA)",
    idVerification: "verified_at_authoring",
    notes:
      "FIXED (external audit finding 10): pinned away from the `gemini-pro-latest` alias to the current documented id `gemini-3.1-pro-preview` (https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview, accessed 2026-09-12). This id is explicitly labelled PREVIEW by Google, not GA — read its results with that caveat; no official price was captured for it this round (see config/pricing.ts), so its cost is reported as unverified, never $0.",
  },
  {
    id: "anthropic-opus-5",
    providerId: "anthropic",
    model: "claude-opus-5",
    role: "ceiling",
    family: "Anthropic Claude Opus 5 (quality ceiling)",
    idVerification: "verified_at_authoring",
    notes:
      "Optional quality ceiling for the finals only. Run it only when the screening result leaves a genuine question about the achievable upper bound.",
  },
] as const;

export const ALL_CANDIDATES: readonly Candidate[] = [BASELINE_CANDIDATE, ...MODEL_CANDIDATES];

export function candidateById(id: string): Candidate | undefined {
  return ALL_CANDIDATES.find((c) => c.id === id);
}

/** Env var that overrides a candidate's model id, e.g. a renamed model. */
export function modelOverrideEnvVar(candidateId: string): string {
  return `B07_BENCH_MODEL_${candidateId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export function resolveModel(
  candidate: Candidate,
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env[modelOverrideEnvVar(candidate.id)];
  return override && override.trim() !== "" ? override.trim() : candidate.model;
}

export const PROVIDER_KEY_ENV: Record<Exclude<ProviderId, "local">, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
};

export function hasApiKey(
  providerId: ProviderId,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (providerId === "local") return true;
  const name = PROVIDER_KEY_ENV[providerId];
  const value = env[name];
  return typeof value === "string" && value.trim() !== "";
}
