/**
 * B07 benchmark — provider transport-contract tests (external audit finding
 * 12). No real API key or live network is used anywhere in this file:
 * `global.fetch` is replaced with a mock for every test, and every assertion
 * is against the literal request the adapter sent, or the literal response
 * shape the adapter must tolerate.
 *
 * Acceptance tests covered: 10 (Anthropic request JSON matches the current
 * `{type, schema}` output format, no `name`), 11 (Anthropic thinking-token
 * breakdown captured), 12 (OpenAI reasoning breakdown captured, never
 * double-charged — billing itself is asserted in scoring/pricing tests),
 * 13 (OpenAI cached input captured), 14 (Google thoughts captured), 16
 * (Google default candidate uses an explicit pinned model id), 17 (Google
 * schema preserves logical strictness), 18 (mocked adapters validate current
 * request shapes), plus availability checks and error handling for all three
 * adapters.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { anthropicAdapter } from "../../scripts/b07-benchmark/providers/anthropic";
import { googleAdapter, toGeminiSchema } from "../../scripts/b07-benchmark/providers/google";
import { openaiAdapter } from "../../scripts/b07-benchmark/providers/openai";
import { ProviderCallError } from "../../scripts/b07-benchmark/providers/types";
import type { ProviderRequest } from "../../scripts/b07-benchmark/providers/types";
import { MESSAGE_JSON_SCHEMA, SCHEMA_NAMES } from "../../scripts/b07-benchmark/schema";
import { effectiveInferenceConfig } from "../../scripts/b07-benchmark/config/inference-config";
import { candidateById, MODEL_CANDIDATES } from "../../scripts/b07-benchmark/config/candidates";

function baseRequest(
  providerId: "openai" | "anthropic" | "google",
  model = "irrelevant-for-non-anthropic",
): ProviderRequest {
  return {
    systemPrompt: "system-instructions",
    userPrompt: "user-case-text",
    jsonSchema: MESSAGE_JSON_SCHEMA,
    schemaName: SCHEMA_NAMES.message,
    maxOutputTokens: 512,
    timeoutMs: 5_000,
    inferenceConfig: effectiveInferenceConfig({ providerId, model }, 512),
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

function errorResponse(status: number, bodyText: string): Response {
  return {
    ok: false,
    status,
    json: () => Promise.reject(new Error("not json")),
    text: () => Promise.resolve(bodyText),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// NOTE ON ENDPOINT ASSERTIONS: some sandboxes (including this one) set
// provider *_BASE_URL variables for unrelated host purposes, and the adapter
// module reads its override at import time. Rather than assume any one
// concrete default host, every test below asserts the request URL equals
// `adapter.endpointFor(...)` — i.e. "the adapter called the endpoint it says
// it would" — which is the actual transport-contract property that matters
// and is correct under any override.

describe("OpenAI adapter transport contract", () => {
  it("sends the current Responses structured-output shape with auth, reasoning effort and exact model", async () => {
    process.env.OPENAI_API_KEY = "sk-test-openai-0123456789";
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        model: "gpt-5.6-luna-2026-08-01",
        output_text: '{"disposition":"positive","signals":[],"evidence_strength":"strong"}',
        usage: {
          input_tokens: 120,
          output_tokens: 40,
          input_tokens_details: { cached_tokens: 20 },
          output_tokens_details: { reasoning_tokens: 15 },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await openaiAdapter.invoke("gpt-5.6-luna", baseRequest("openai"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(openaiAdapter.endpointFor("gpt-5.6-luna"));
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test-openai-0123456789");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe("gpt-5.6-luna");
    const text = body.text as { format: Record<string, unknown> };
    expect(text.format.type).toBe("json_schema");
    expect(text.format.strict).toBe(true);
    expect(text.format.schema).toEqual(MESSAGE_JSON_SCHEMA);
    expect(body.reasoning).toEqual({ effort: "medium" });

    expect(response.returned_model).toBe("gpt-5.6-luna-2026-08-01");
    expect(response.usage.input_tokens).toBe(120);
    expect(response.usage.output_tokens).toBe(40);
    // Diagnostic breakdown, NOT additional to output_tokens.
    expect(response.usage.reasoning_tokens).toBe(15);
    expect(response.usage.cached_input_tokens).toBe(20);
    expect(response.text).toContain("positive");

    delete process.env.OPENAI_API_KEY;
  });

  it("surfaces a non-2xx response as a typed ProviderCallError, never a fabricated prediction", async () => {
    process.env.OPENAI_API_KEY = "sk-test-openai-0123456789";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(errorResponse(429, "rate limited: too many requests")),
    );
    await expect(openaiAdapter.invoke("gpt-5.6-luna", baseRequest("openai"))).rejects.toMatchObject(
      { httpStatus: 429 } satisfies Partial<ProviderCallError>,
    );
    delete process.env.OPENAI_API_KEY;
  });

  it("throws before any network call when the API key is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      openaiAdapter.invoke("gpt-5.6-luna", baseRequest("openai")),
    ).rejects.toBeInstanceOf(ProviderCallError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("availability check: 404 means unavailable, 200 means available, network failure means unknown (null)", async () => {
    process.env.OPENAI_API_KEY = "sk-test-openai-0123456789";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(404, {})));
    expect(await openaiAdapter.isModelAvailable("gpt-5.6-luna")).toBe(false);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { id: "gpt-5.6-luna" })));
    expect(await openaiAdapter.isModelAvailable("gpt-5.6-luna")).toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new ProviderCallError("network_error", "boom")),
    );
    expect(await openaiAdapter.isModelAvailable("gpt-5.6-luna")).toBeNull();
    delete process.env.OPENAI_API_KEY;
  });
});

describe("Anthropic adapter transport contract", () => {
  it("FIXED transport (Sonnet 5): adaptive thinking + output_config.effort, never manual `enabled`", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-0123456789";
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        model: "claude-sonnet-5-2026-06-01",
        content: [
          {
            type: "text",
            text: '{"disposition":"neutral","signals":[],"evidence_strength":"weak"}',
          },
        ],
        usage: {
          input_tokens: 200,
          output_tokens: 60,
          output_tokens_details: { thinking_tokens: 25 },
          cache_read_input_tokens: 40,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await anthropicAdapter.invoke(
      "claude-sonnet-5",
      baseRequest("anthropic", "claude-sonnet-5"),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(anthropicAdapter.endpointFor("claude-sonnet-5"));
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test-0123456789");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const outputConfig = body.output_config as { format: Record<string, unknown>; effort?: string };
    expect(outputConfig.format).toEqual({ type: "json_schema", schema: MESSAGE_JSON_SCHEMA });
    expect(outputConfig.format).not.toHaveProperty("name");

    // Current Anthropic transport: adaptive thinking, effort at
    // output_config.effort — NEVER the invalid manual `{type:"enabled",...}`
    // shape the previous adapter revision sent.
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect((body.thinking as { type: string }).type).not.toBe("enabled");
    expect(outputConfig.effort).toBe("medium");
    // No non-default sampling params — the round spec forbids them here.
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("top_k");

    // 11. thinking-token breakdown captured, never folded into a fabricated field.
    expect(response.usage.reasoning_tokens).toBe(25);
    expect(response.usage.output_tokens).toBe(60);
    expect(response.usage.cached_input_tokens).toBe(40);
    expect(response.returned_model).toBe("claude-sonnet-5-2026-06-01");
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("FIXED transport (Haiku 4.5): no adaptive thinking, no output_config.effort, structured output stays on", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-0123456789";
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        model: "claude-haiku-4-5-20251001",
        content: [
          {
            type: "text",
            text: '{"disposition":"neutral","signals":[],"evidence_strength":"weak"}',
          },
        ],
        usage: { input_tokens: 50, output_tokens: 10 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await anthropicAdapter.invoke(
      "claude-haiku-4-5-20251001",
      baseRequest("anthropic", "claude-haiku-4-5-20251001"),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe("claude-haiku-4-5-20251001");
    const outputConfig = body.output_config as { format: Record<string, unknown> };
    expect(outputConfig.format).toEqual({ type: "json_schema", schema: MESSAGE_JSON_SCHEMA });
    expect(outputConfig).not.toHaveProperty("effort");
    expect(body).not.toHaveProperty("thinking");

    expect(response.usage.reasoning_tokens).toBeNull();
    expect(response.usage.cached_input_tokens).toBeNull();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("Sonnet 5 uses the exact requested model id from candidates.ts", async () => {
    const sonnet = candidateById("anthropic-sonnet-5");
    expect(sonnet?.model).toBe("claude-sonnet-5");
  });

  it("records null reasoning/cached tokens when the provider does not report them, never a fabricated 0", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-0123456789";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          model: "claude-haiku-4-5-20251001",
          content: [
            {
              type: "text",
              text: '{"disposition":"neutral","signals":[],"evidence_strength":"weak"}',
            },
          ],
          usage: { input_tokens: 50, output_tokens: 10 },
        }),
      ),
    );
    const response = await anthropicAdapter.invoke(
      "claude-haiku-4-5-20251001",
      baseRequest("anthropic", "claude-haiku-4-5-20251001"),
    );
    expect(response.usage.reasoning_tokens).toBeNull();
    expect(response.usage.cached_input_tokens).toBeNull();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("surfaces a malformed (non-JSON-object) envelope as a typed error", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-0123456789";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(null),
        text: () => Promise.resolve("null"),
      } as unknown as Response),
    );
    await expect(
      anthropicAdapter.invoke("claude-sonnet-5", baseRequest("anthropic", "claude-sonnet-5")),
    ).rejects.toMatchObject({ kind: "malformed_provider_envelope" });
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("availability check distinguishes 404 (unavailable) from a network failure (unknown)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-0123456789";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(404, {})));
    expect(await anthropicAdapter.isModelAvailable("claude-sonnet-5")).toBe(false);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    expect(await anthropicAdapter.isModelAvailable("claude-sonnet-5")).toBeNull();
    delete process.env.ANTHROPIC_API_KEY;
  });
});

describe("Google adapter transport contract", () => {
  it("hits the exact pinned model endpoint, preserves additionalProperties:false, sends thinkingConfig", async () => {
    process.env.GEMINI_API_KEY = "AIzaTestGoogleKey0123456789";
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        modelVersion: "gemini-3.8-flash-002",
        candidates: [
          {
            content: {
              parts: [
                { text: '{"disposition":"positive","signals":[],"evidence_strength":"strong"}' },
                { thought: true, text: "internal reasoning summary, not the answer" },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 90,
          candidatesTokenCount: 35,
          thoughtsTokenCount: 12,
          cachedContentTokenCount: 5,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await googleAdapter.invoke("gemini-3.8-flash", baseRequest("google"));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(googleAdapter.endpointFor("gemini-3.8-flash"));
    expect(url).toMatch(/\/models\/gemini-3\.8-flash:generateContent$/);
    const headers = init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("AIzaTestGoogleKey0123456789");
    const body = JSON.parse(init.body as string) as {
      generationConfig: { responseSchema: Record<string, unknown>; thinkingConfig?: unknown };
    };
    // 17. schema parity: additionalProperties:false is retained, not dropped.
    expect(body.generationConfig.responseSchema.additionalProperties).toBe(false);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "medium" });

    // 14. Google thoughts captured (billed separately — see pricing tests).
    expect(response.usage.reasoning_tokens).toBe(12);
    expect(response.usage.input_tokens).toBe(90);
    expect(response.usage.output_tokens).toBe(35);
    expect(response.usage.cached_input_tokens).toBe(5);
    expect(response.returned_model).toBe("gemini-3.8-flash-002");
    // The `thought: true` part must never leak into the extracted answer text.
    expect(response.text).not.toContain("internal reasoning summary");
    delete process.env.GEMINI_API_KEY;
  });

  it("16. the default Google screening candidate uses an explicit pinned (non-`latest`) model id", () => {
    const flash = candidateById("google-gemini-flash");
    const pro = candidateById("google-gemini-pro");
    expect(flash?.model).toBe("gemini-3.8-flash");
    expect(flash?.model).not.toMatch(/latest/);
    expect(pro?.model).toBe("gemini-3.1-pro-preview");
    expect(pro?.model).not.toMatch(/-latest$/);
    // PREVIEW must be visibly labelled, never presented as GA.
    expect(pro?.family).toMatch(/PREVIEW/);
  });

  it("17b. toGeminiSchema preserves identical enums, required fields and additionalProperties:false", () => {
    const translated = toGeminiSchema(MESSAGE_JSON_SCHEMA);
    expect(translated.additionalProperties).toBe(false);
    expect(translated.required).toEqual(MESSAGE_JSON_SCHEMA.required);
    expect(Object.keys(translated.properties)).toEqual(Object.keys(MESSAGE_JSON_SCHEMA.properties));
  });

  it("availability check: 404 is unavailable, thrown network error is unknown", async () => {
    process.env.GEMINI_API_KEY = "AIzaTestGoogleKey0123456789";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(404, {})));
    expect(await googleAdapter.isModelAvailable("gemini-3.8-flash")).toBe(false);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("dns failure")));
    expect(await googleAdapter.isModelAvailable("gemini-3.8-flash")).toBeNull();
    delete process.env.GEMINI_API_KEY;
  });

  it("surfaces a provider HTTP error as a typed error carrying the status", async () => {
    process.env.GEMINI_API_KEY = "AIzaTestGoogleKey0123456789";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(500, "internal error")));
    await expect(
      googleAdapter.invoke("gemini-3.8-flash", baseRequest("google")),
    ).rejects.toMatchObject({ httpStatus: 500 });
    delete process.env.GEMINI_API_KEY;
  });
});

describe("candidate matrix reproducibility (finding 10)", () => {
  it("no screening/ceiling candidate model id ends in a floating '-latest' alias", () => {
    for (const candidate of MODEL_CANDIDATES) {
      expect(candidate.model, candidate.id).not.toMatch(/-latest$/);
    }
  });

  it("Anthropic Haiku is pinned to its exact dated id, not the floating alias", () => {
    const haiku = candidateById("anthropic-haiku-4-5");
    expect(haiku?.model).toBe("claude-haiku-4-5-20251001");
  });
});
