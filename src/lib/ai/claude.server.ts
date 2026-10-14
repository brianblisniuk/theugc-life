import "server-only";

/**
 * Claude Messages API client (D141, D145).
 *
 * Tests must pass `fetchImpl`. In NODE_ENV=test the default fetch throws,
 * so a forgotten mock cannot reach api.anthropic.com.
 * The request and the response text are not logged.
 */

import { AI_LIMITS } from "./limits";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";

export type ClaudeFailure = "unconfigured" | "timeout" | "http" | "parse" | "refused";

export type ClaudeResult =
  | {
      ok: true;
      text: string;
      inputTokens: number;
      outputTokens: number;
      model: string;
    }
  | {
      ok: false;
      status: ClaudeFailure;
      httpStatus?: number;
      inputTokens: number;
      outputTokens: number;
    };

export interface ClaudeRequest {
  apiKey: string | null;
  model: string;
  maxTokens: number;
  system: string;
  user: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  delay?: (ms: number) => Promise<void>;
}

function forbiddenFetch(): Promise<Response> {
  return Promise.reject(new Error("Claude must be mocked in tests"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function retryable(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 529;
}

function clampCount(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return 0;
  return Math.min(value, max);
}

function readUsage(body: unknown): { inputTokens: number; outputTokens: number } | null {
  if (!body || typeof body !== "object") return null;
  const usage = (body as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const record = usage as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    cache_read_input_tokens?: unknown;
  };
  if (typeof record.output_tokens !== "number") return null;
  const input =
    clampCount(record.input_tokens, 200_000) +
    clampCount(record.cache_creation_input_tokens, 200_000) +
    clampCount(record.cache_read_input_tokens, 200_000);
  return {
    inputTokens: Math.min(input, 200_000),
    outputTokens: clampCount(record.output_tokens, 8192),
  };
}

function readText(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
  }
  const text = parts.join("").trim();
  return text.length > 0 ? text : null;
}

async function once(
  request: ClaudeRequest,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ response: Response } | { failure: "timeout" }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": request.apiKey ?? "",
        "anthropic-version": VERSION,
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens,
        stream: false,
        thinking: { type: "disabled" },
        system: request.system,
        messages: [{ role: "user", content: request.user }],
      }),
    });
    return { response };
  } catch {
    return { failure: "timeout" };
  } finally {
    clearTimeout(timer);
  }
}

export async function completeClaude(request: ClaudeRequest): Promise<ClaudeResult> {
  if (!request.apiKey)
    return { ok: false, status: "unconfigured", inputTokens: 0, outputTokens: 0 };
  const fetchImpl = request.fetchImpl ?? (process.env.NODE_ENV === "test" ? forbiddenFetch : fetch);
  const timeoutMs = request.timeoutMs ?? AI_LIMITS.timeoutMs;
  const maxRetries = request.maxRetries ?? AI_LIMITS.maxRetries;
  const delay = request.delay ?? sleep;
  let lastTokens = { inputTokens: 0, outputTokens: 0 };
  let httpStatus: number | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const result = await once(request, fetchImpl, timeoutMs);
    if ("failure" in result) {
      if (attempt < maxRetries) {
        await delay(50 * (attempt + 1));
        continue;
      }
      return { ok: false, status: "timeout", inputTokens: 0, outputTokens: 0 };
    }
    httpStatus = result.response.status;
    const raw = await result.response.text();
    let parsed: unknown = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    }
    const usage = readUsage(parsed);
    if (usage) lastTokens = usage;
    if (retryable(result.response.status) && attempt < maxRetries) {
      await delay(50 * (attempt + 1));
      continue;
    }
    if (!result.response.ok) {
      return { ok: false, status: "http", httpStatus, ...lastTokens };
    }
    const text = readText(parsed);
    if (!text || !usage) return { ok: false, status: "parse", httpStatus, ...lastTokens };
    return { ok: true, text, model: request.model, ...usage };
  }

  return { ok: false, status: "refused", httpStatus, ...lastTokens };
}
