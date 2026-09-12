/**
 * Google Gemini adapter (benchmark only).
 *
 * Uses `generateContent` with `responseMimeType: application/json` plus a
 * `responseSchema`. Gemini's schema dialect does not accept
 * `additionalProperties`, so the schema is translated field-by-field from the
 * same logical schema rather than replaced — the enums and required fields are
 * identical, which is what fairness requires.
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
import type { JsonObjectSchema } from "../schema";

const BASE_URL =
  process.env.GEMINI_BASE_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta";

interface GeminiSchema {
  type: string;
  properties: Record<string, GeminiSchema>;
  required?: string[];
  items?: GeminiSchema;
  enum?: string[];
  propertyOrdering?: string[];
}

/** Same enums, same required fields; only dialect-specific keys differ. */
export function toGeminiSchema(schema: JsonObjectSchema): GeminiSchema {
  const properties: Record<string, GeminiSchema> = {};
  for (const [name, property] of Object.entries(schema.properties)) {
    properties[name] =
      property.type === "string"
        ? { type: "STRING", enum: [...property.enum], properties: {} }
        : {
            type: "ARRAY",
            properties: {},
            items: { type: "STRING", enum: [...property.items.enum], properties: {} },
          };
  }
  return {
    type: "OBJECT",
    properties,
    required: [...schema.required],
    propertyOrdering: [...schema.required],
  };
}

export const googleAdapter: ProviderAdapter = {
  providerId: "google",
  apiKeyEnvVar: "GEMINI_API_KEY",

  endpointFor(model: string): string {
    return `${BASE_URL}/models/${encodeURIComponent(model)}:generateContent`;
  },

  async invoke(model: string, request: ProviderRequest): Promise<ProviderResponse> {
    const apiKey = requireApiKey("GEMINI_API_KEY");
    const endpoint = `${BASE_URL}/models/${encodeURIComponent(model)}:generateContent`;

    const response = await timedFetch(
      endpoint,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: request.userPrompt }] }],
          generationConfig: {
            maxOutputTokens: request.maxOutputTokens,
            responseMimeType: "application/json",
            responseSchema: toGeminiSchema(request.jsonSchema),
          },
        }),
      },
      request.timeoutMs,
    );

    if (!response.ok) {
      throw new ProviderCallError(
        "http_error",
        `google ${response.status}: ${await summariseErrorBody(response)}`,
        response.status,
      );
    }

    const body = asRecord(await response.json().catch(() => null));
    if (!body) {
      throw new ProviderCallError(
        "malformed_provider_envelope",
        "google returned a non-object body",
      );
    }

    const usage = asRecord(body.usageMetadata);

    return {
      text: extractText(body),
      usage: {
        input_tokens: readNumber(usage?.promptTokenCount),
        output_tokens: readNumber(usage?.candidatesTokenCount),
        reasoning_tokens: readNumber(usage?.thoughtsTokenCount),
      },
      returned_model: typeof body.modelVersion === "string" ? body.modelVersion : null,
      endpoint,
      http_status: response.status,
    };
  },

  async isModelAvailable(model: string): Promise<boolean | null> {
    try {
      const apiKey = requireApiKey("GEMINI_API_KEY");
      const response = await timedFetch(
        `${BASE_URL}/models/${encodeURIComponent(model)}`,
        { method: "GET", headers: { "x-goog-api-key": apiKey } },
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
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  const chunks: string[] = [];
  for (const candidate of candidates) {
    const content = asRecord(asRecord(candidate)?.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    for (const part of parts) {
      const record = asRecord(part);
      // `thought: true` parts are reasoning summaries, not the answer.
      if (record && record.thought !== true && typeof record.text === "string") {
        chunks.push(record.text);
      }
    }
  }
  return chunks.length > 0 ? chunks.join("") : null;
}
