/**
 * OpenAI adapter (benchmark only).
 *
 * Uses the Responses API with a strict `json_schema` text format, which is
 * OpenAI's native structured-output transport. Same logical schema, same
 * instructions as every other candidate — only the transport differs.
 *
 * BILLING NOTE (external audit finding): `usage.output_tokens_details.
 * reasoning_tokens` is a BREAKDOWN of `usage.output_tokens`, not additional
 * tokens above it — the Responses API's own examples show
 * `total_tokens = input_tokens + output_tokens`, never
 * `input_tokens + output_tokens + reasoning_tokens`. This adapter records
 * `reasoning_tokens` for diagnostics only; `config/pricing.ts` must price
 * OpenAI output tokens exactly once (`reasoning_billed_separately_from_output:
 * false`) or the benchmark double-charges every reasoning-heavy response.
 */
import {
  ProviderCallError,
  asRecord,
  readNumber,
  requireApiKey,
  summariseErrorBody,
  timedFetch,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderResponse,
} from "./types";

const BASE_URL = process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";

export const openaiAdapter: ProviderAdapter = {
  providerId: "openai",
  apiKeyEnvVar: "OPENAI_API_KEY",

  endpointFor(): string {
    return `${BASE_URL}/responses`;
  },

  async invoke(model: string, request: ProviderRequest): Promise<ProviderResponse> {
    const apiKey = requireApiKey("OPENAI_API_KEY");
    const endpoint = `${BASE_URL}/responses`;

    const response = await timedFetch(
      endpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          instructions: request.systemPrompt,
          input: request.userPrompt,
          max_output_tokens: request.maxOutputTokens,
          text: {
            format: {
              type: "json_schema",
              name: request.schemaName,
              strict: true,
              schema: request.jsonSchema,
            },
          },
          ...(request.inferenceConfig.reasoning_effort !== "not_supported"
            ? { reasoning: { effort: request.inferenceConfig.reasoning_effort } }
            : {}),
        }),
      },
      request.timeoutMs,
    );

    if (!response.ok) {
      throw new ProviderCallError(
        "http_error",
        `openai ${response.status}: ${await summariseErrorBody(response)}`,
        response.status,
      );
    }

    const body = asRecord(await response.json().catch(() => null));
    if (!body) {
      throw new ProviderCallError(
        "malformed_provider_envelope",
        "openai returned a non-object body",
      );
    }

    const usage = asRecord(body.usage);
    const outputDetails = asRecord(usage?.output_tokens_details);
    const inputDetails = asRecord(usage?.input_tokens_details);

    return {
      text: extractText(body),
      usage: {
        input_tokens: readNumber(usage?.input_tokens),
        // Billed output total — ALREADY INCLUSIVE of reasoning_tokens below.
        output_tokens: readNumber(usage?.output_tokens),
        // Diagnostic breakdown only. Never add this to output_tokens.
        reasoning_tokens: readNumber(outputDetails?.reasoning_tokens),
        // A subset of input_tokens, billed at the cached rate, not additional.
        cached_input_tokens: readNumber(inputDetails?.cached_tokens),
      },
      returned_model: typeof body.model === "string" ? body.model : null,
      endpoint,
      http_status: response.status,
    };
  },

  async isModelAvailable(model: string): Promise<boolean | null> {
    try {
      const apiKey = requireApiKey("OPENAI_API_KEY");
      const response = await timedFetch(
        `${BASE_URL}/models/${encodeURIComponent(model)}`,
        { method: "GET", headers: { authorization: `Bearer ${apiKey}` } },
        15_000,
      );
      if (response.status === 404) return false;
      return response.ok ? true : null;
    } catch {
      return null;
    }
  },
};

/**
 * Pull the assistant text out of a Responses envelope.
 *
 * `output_text` is the convenience field; the structured walk is the fallback
 * so a shape change degrades to "no text" (a schema failure the runner records
 * honestly) rather than to a wrong answer.
 */
function extractText(body: Record<string, unknown>): string | null {
  if (typeof body.output_text === "string" && body.output_text.trim() !== "") {
    return body.output_text;
  }
  const output = Array.isArray(body.output) ? body.output : [];
  const chunks: string[] = [];
  for (const item of output) {
    const record = asRecord(item);
    if (!record || record.type !== "message") continue;
    const content = Array.isArray(record.content) ? record.content : [];
    for (const part of content) {
      const partRecord = asRecord(part);
      if (partRecord && typeof partRecord.text === "string") chunks.push(partRecord.text);
    }
  }
  return chunks.length > 0 ? chunks.join("") : null;
}
