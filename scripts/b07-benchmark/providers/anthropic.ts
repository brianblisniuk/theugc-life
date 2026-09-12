/**
 * Anthropic adapter (benchmark only).
 *
 * Uses the Messages API with `output_config.format` — Anthropic's native
 * structured-output transport — so the same logical JSON Schema is enforced
 * server-side, matching what the OpenAI and Google adapters get.
 *
 * TRANSPORT NOTE (external audit correction): the current `JSONOutputFormat`
 * shape is `{ type: "json_schema", schema }` — there is NO `name` field.
 * Earlier revisions of this adapter sent `name` because it mirrored the
 * OpenAI/Google shapes; a real key would have surfaced this as a request
 * validation error, which is exactly why `tests/b07-benchmark/provider-
 * transport.test.ts` asserts the literal request body without needing one.
 *
 * BILLING NOTE: adaptive thinking tokens are billed as, and counted inside,
 * `usage.output_tokens` — `usage.output_tokens_details.thinking_tokens` is an
 * OBSERVABLE breakdown of that total, recorded here for diagnostics only and
 * never added a second time (see `config/pricing.ts`).
 *
 * A note that matters for the PRIVACY screen, not just the transport: the
 * official retention documentation states that JSON schemas compiled for
 * structured outputs are cached separately from message content and do not
 * receive the same protections as prompts and responses. The benchmark's
 * schema contains only D072 enum names — no case content and no Gmail-derived
 * text — and a production B07 configuration must preserve that property.
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

const BASE_URL = process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com/v1";
const API_VERSION = "2023-06-01";

export const anthropicAdapter: ProviderAdapter = {
  providerId: "anthropic",
  apiKeyEnvVar: "ANTHROPIC_API_KEY",

  endpointFor(): string {
    return `${BASE_URL}/messages`;
  },

  async invoke(model: string, request: ProviderRequest): Promise<ProviderResponse> {
    const apiKey = requireApiKey("ANTHROPIC_API_KEY");
    const endpoint = `${BASE_URL}/messages`;

    const response = await timedFetch(
      endpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: request.maxOutputTokens,
          system: request.systemPrompt,
          messages: [{ role: "user", content: request.userPrompt }],
          // Current shape: { type: "json_schema", schema }. No `name` field —
          // see the transport note at the top of this file.
          output_config: {
            format: {
              type: "json_schema",
              schema: request.jsonSchema,
            },
          },
          ...(request.inferenceConfig.reasoning_effort !== "not_supported"
            ? { thinking: { type: "enabled", effort: request.inferenceConfig.reasoning_effort } }
            : {}),
        }),
      },
      request.timeoutMs,
    );

    if (!response.ok) {
      throw new ProviderCallError(
        "http_error",
        `anthropic ${response.status}: ${await summariseErrorBody(response)}`,
        response.status,
      );
    }

    const body = asRecord(await response.json().catch(() => null));
    if (!body) {
      throw new ProviderCallError(
        "malformed_provider_envelope",
        "anthropic returned a non-object body",
      );
    }

    const usage = asRecord(body.usage);
    const outputDetails = asRecord(usage?.output_tokens_details);
    const cacheCreation = readNumber(usage?.cache_creation_input_tokens) ?? 0;
    const cacheRead = readNumber(usage?.cache_read_input_tokens) ?? 0;
    const cachedInput =
      usage?.cache_creation_input_tokens === undefined &&
      usage?.cache_read_input_tokens === undefined
        ? null
        : cacheCreation + cacheRead;

    return {
      text: extractText(body),
      usage: {
        input_tokens: readNumber(usage?.input_tokens),
        // Billed output total — ALREADY INCLUSIVE of thinking_tokens below.
        output_tokens: readNumber(usage?.output_tokens),
        // OBSERVABLE breakdown only (thinking_tokens <= output_tokens).
        // Reporting it again in cost estimation would double-count.
        reasoning_tokens: readNumber(outputDetails?.thinking_tokens),
        cached_input_tokens: cachedInput,
      },
      returned_model: typeof body.model === "string" ? body.model : null,
      endpoint,
      http_status: response.status,
    };
  },

  async isModelAvailable(model: string): Promise<boolean | null> {
    try {
      const apiKey = requireApiKey("ANTHROPIC_API_KEY");
      const response = await timedFetch(
        `${BASE_URL}/models/${encodeURIComponent(model)}`,
        { method: "GET", headers: { "x-api-key": apiKey, "anthropic-version": API_VERSION } },
        15_000,
      );
      if (response.status === 404) return false;
      return response.ok ? true : null;
    } catch {
      return null;
    }
  },
};

function extractText(body: Record<string, unknown>): string | null {
  const content = Array.isArray(body.content) ? body.content : [];
  const chunks: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (!record) continue;
    if (record.type === "text" && typeof record.text === "string") chunks.push(record.text);
  }
  return chunks.length > 0 ? chunks.join("") : null;
}
