/**
 * Benchmark-only provider adapter contract.
 *
 * These adapters exist to compare providers on one evaluation. They are
 * deliberately thin `fetch` wrappers rather than three permanent vendor SDK
 * dependencies, and nothing in `src/` imports them — coupling future product
 * code to a benchmark adapter is exactly the scope failure the round warns
 * about.
 *
 * A provider exception is an ERROR, never a prediction: adapters either return
 * a `ProviderResponse` with text the caller must still validate, or they throw
 * `ProviderCallError`. There is no third path that yields a semantic label.
 */
import type { JsonObjectSchema } from "../schema";

export interface ProviderRequest {
  systemPrompt: string;
  userPrompt: string;
  jsonSchema: JsonObjectSchema;
  schemaName: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface ProviderResponse {
  /** Raw text the provider returned in the structured-output slot. */
  text: string | null;
  usage: {
    input_tokens: number | null;
    output_tokens: number | null;
    reasoning_tokens: number | null;
  };
  /** Model/version string the provider reported, when exposed. */
  returned_model: string | null;
  endpoint: string;
  http_status: number;
}

export type ProviderErrorKind =
  "missing_api_key" | "http_error" | "timeout" | "network_error" | "malformed_provider_envelope";

export class ProviderCallError extends Error {
  readonly kind: ProviderErrorKind;
  readonly httpStatus: number | null;

  constructor(kind: ProviderErrorKind, message: string, httpStatus: number | null = null) {
    super(message);
    this.name = "ProviderCallError";
    this.kind = kind;
    this.httpStatus = httpStatus;
  }
}

export interface ProviderAdapter {
  readonly providerId: "openai" | "anthropic" | "google";
  readonly apiKeyEnvVar: string;
  endpointFor(model: string): string;
  /** Throws `ProviderCallError` on any failure. Never returns a fabricated body. */
  invoke(model: string, request: ProviderRequest): Promise<ProviderResponse>;
  /**
   * Best-effort availability check against the provider's own model listing.
   * Returns null when the provider does not expose one, or the check itself
   * failed — "unknown" is reported honestly rather than assumed available.
   */
  isModelAvailable(model: string): Promise<boolean | null>;
}

/** Shared fetch with a hard timeout; converts every failure into a typed error. */
export async function timedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderCallError("timeout", `request exceeded ${timeoutMs}ms`);
    }
    throw new ProviderCallError(
      "network_error",
      error instanceof Error ? error.message : "unknown network failure",
    );
  } finally {
    clearTimeout(timer);
  }
}

export function requireApiKey(
  envVar: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const value = env[envVar];
  if (!value || value.trim() === "") {
    throw new ProviderCallError("missing_api_key", `${envVar} is not set`);
  }
  return value.trim();
}

/** Truncated, credential-free error body for logs and artifacts. */
export async function summariseErrorBody(response: Response): Promise<string> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "<unreadable body>";
  }
  return body.slice(0, 500);
}

export function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
