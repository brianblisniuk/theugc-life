/**
 * D03 assistant. Claude is mocked. These tests do not open a socket.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { completeClaude } from "@/lib/ai/claude.server";
import { composePitch, tokenLog, type ComposeDeps } from "@/lib/ai/compose.server";
import {
  AI_LIMITS,
  contextCharsFor,
  maxTokensFor,
  readBudgetMicros,
  resolveModel,
  wouldExceedBudget,
} from "@/lib/ai/limits";
import {
  buildOutreachPrompt,
  onlyOwnedSelected,
  parseDraftText,
  type OutreachFacts,
} from "@/lib/ai/prompt";
import { redact } from "@/lib/log/redact";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const MARKER = "MARKERHOTELNAME";

function facts(overrides: Partial<OutreachFacts> = {}): OutreachFacts {
  return {
    language: "Spanish",
    creatorName: "Ada",
    niche: "hotels",
    instagramHandle: "ada",
    hotelName: MARKER,
    destinationName: "Lisbon",
    tripName: null,
    tripStart: null,
    tripEnd: null,
    portfolioTitle: null,
    portfolioUrl: null,
    contactName: null,
    intelligenceNote: "x".repeat(400),
    pastCollaboration: null,
    pipelineStatus: "pitched",
    selectedMail: [],
    ...overrides,
  };
}

function deps(overrides: Partial<ComposeDeps> = {}): ComposeDeps & {
  calls: { charge: number; complete: number };
} {
  const calls = { charge: 0, complete: 0 };
  const base: ComposeDeps = {
    fullAi: true,
    priority: false,
    balance: 5,
    apiKey: "test-key-value",
    facts: facts(),
    charge: async () => {
      calls.charge += 1;
      return "charged";
    },
    prepare: async () => "reserved",
    finish: async () => undefined,
    complete: async () => {
      calls.complete += 1;
      return {
        ok: true,
        text: JSON.stringify({ subject: "Hello", body: "A short note." }),
        inputTokens: 12,
        outputTokens: 8,
        model: resolveModel(),
      };
    },
    ...overrides,
  };
  return Object.assign(base, { calls });
}

afterEach(() => {
  delete process.env.ANTHROPIC_MONTHLY_BUDGET_USD;
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.ANTHROPIC_PRO_MAX_TOKENS;
  delete process.env.ANTHROPIC_PRIORITY_MAX_TOKENS;
  vi.restoreAllMocks();
});

describe("assistant limits", () => {
  it("uses one Sonnet model for Pro and Max", () => {
    expect(resolveModel(undefined)).toBe(AI_LIMITS.defaultModel);
    expect(resolveModel("")).toBe("claude-sonnet-5-5");
    expect(resolveModel("claude-haiku-5-5")).toBe("claude-haiku-5-5");
    expect(resolveModel("not a model")).toBe(AI_LIMITS.defaultModel);
    expect(maxTokensFor("max")).toBeGreaterThan(maxTokensFor("pro"));
    expect(maxTokensFor("max")).toBeLessThanOrEqual(AI_LIMITS.absoluteMaxTokens);
    expect(contextCharsFor("max")).toBeGreaterThan(contextCharsFor("pro"));
    process.env.ANTHROPIC_PRIORITY_MAX_TOKENS = "9000";
    expect(maxTokensFor("max")).toBe(AI_LIMITS.absoluteMaxTokens);
    process.env.ANTHROPIC_PRO_MAX_TOKENS = "50";
    expect(maxTokensFor("pro")).toBe(AI_LIMITS.proMaxTokens);
  });

  it("refuses a missing or non-positive monthly budget", () => {
    expect(readBudgetMicros(undefined)).toBeNull();
    expect(readBudgetMicros("")).toBeNull();
    expect(readBudgetMicros("0")).toBeNull();
    expect(readBudgetMicros("-4")).toBeNull();
    expect(readBudgetMicros("10")).toBe(10_000_000);
    expect(wouldExceedBudget(9_000_000, 2_000_000, 10_000_000)).toBe(true);
    expect(wouldExceedBudget(1_000, 1_000, 10_000)).toBe(false);
  });
});

describe("outreach prompt", () => {
  it("writes in the creator language and keeps a third-party body out unless selected", () => {
    const caller = "user-a";
    const selected = onlyOwnedSelected(
      [
        { id: "own", text: "own-secret-body", selected: true, ownerId: caller },
        { id: "other", text: "other-secret-body", selected: true, ownerId: "user-b" },
        { id: "skipped", text: "unselected-body", selected: false, ownerId: caller },
      ],
      caller,
    );
    expect(selected.map((item) => item.id)).toEqual(["own"]);
    const prompt = buildOutreachPrompt(
      facts({
        contactName: "Pat",
        selectedMail: selected,
      }),
      "pro",
    );
    expect(prompt.system).toContain("Spanish");
    expect(prompt.user).toContain("own-secret-body");
    expect(prompt.user).not.toContain("other-secret-body");
    expect(prompt.user).not.toContain("unselected-body");
    expect(prompt.user).not.toContain("@");
    expect(prompt.tier).toBe("pro");
  });

  it("drops an address and gives Max more of the public note on the same shape", () => {
    const withAddress = buildOutreachPrompt(
      facts({ contactName: "Pat <pat@hotel.test>", portfolioUrl: "https://example.com/a" }),
      "pro",
    );
    expect(withAddress.user).not.toContain("pat@hotel.test");
    expect(withAddress.user).not.toContain("@");
    expect(withAddress.user).toContain("https://example.com/a");
    const pro = buildOutreachPrompt(facts(), "pro");
    const max = buildOutreachPrompt(facts(), "max");
    expect(max.user.length).toBeGreaterThan(pro.user.length);
    expect(max.system).toContain("concrete reason");
    expect(pro.user.length).toBeLessThanOrEqual(contextCharsFor("pro"));
    expect(max.user.length).toBeLessThanOrEqual(contextCharsFor("max"));
  });

  it("uses English when the profile has no language", () => {
    const prompt = buildOutreachPrompt(facts({ language: null }), "pro");
    expect(prompt.system).toContain("Write in English.");
  });

  it("parses a JSON draft and refuses prose", () => {
    expect(parseDraftText('```json\n{"subject":"Hi","body":"There."}\n```')).toEqual({
      subject: "Hi",
      body: "There.",
    });
    expect(parseDraftText("Hello there")).toBeNull();
  });
});

describe("Claude client", () => {
  it("retries a 429 and never calls the real fetch", async () => {
    const real = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("network");
    });
    let attempts = 0;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
          status: 429,
        });
      }
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: '{"subject":"Hi","body":"There."}' }],
          usage: { input_tokens: 4, output_tokens: 6 },
        }),
        { status: 200 },
      );
    });
    const result = await completeClaude({
      apiKey: "test-key-value",
      model: "claude-sonnet-5-5",
      maxTokens: 400,
      system: "system",
      user: "user",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      delay: async () => undefined,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.inputTokens).toBe(4);
      expect(result.outputTokens).toBe(6);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(real).not.toHaveBeenCalled();
    const init = fetchImpl.mock.calls[0]?.[1];
    if (!init) throw new Error("missing request");
    expect(String(init.body)).toContain('"thinking":{"type":"disabled"}');
    expect(String(init.body)).not.toContain("test-key-value");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("test-key-value");
  });

  it("does not retry a 401", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 401 }));
    const result = await completeClaude({
      apiKey: "test-key-value",
      model: "claude-sonnet-5-5",
      maxTokens: 400,
      system: "s",
      user: "u",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      delay: async () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses the default fetch while tests are running", async () => {
    const result = await completeClaude({
      apiKey: "test-key-value",
      model: "claude-sonnet-5-5",
      maxTokens: 64,
      system: "s",
      user: "u",
      maxRetries: 0,
    });
    expect(result).toMatchObject({ ok: false, status: "timeout" });
  });
});

describe("compose", () => {
  it("does not call the model for Free and does not charge a failed call", async () => {
    process.env.ANTHROPIC_MONTHLY_BUDGET_USD = "25";
    const free = deps({ fullAi: false });
    expect(await composePitch(free)).toEqual({ status: "templates_only" });
    expect(free.calls.complete).toBe(0);
    expect(free.calls.charge).toBe(0);

    const failed = deps({
      complete: async () => {
        failed.calls.complete += 1;
        return { ok: false, status: "http", inputTokens: 3, outputTokens: 0 };
      },
    });
    expect((await composePitch(failed)).status).toBe("error");
    expect(failed.calls.charge).toBe(0);
  });

  it("charges once, uses the same model for Max, and logs counts without the prompt", async () => {
    process.env.ANTHROPIC_MONTHLY_BUDGET_USD = "25";
    const lines: string[] = [];
    vi.spyOn(console, "info").mockImplementation((line?: unknown) => {
      lines.push(String(line));
    });
    let seenModel = "";
    let seenTokens = 0;
    const pro = deps({
      complete: async (request) => {
        pro.calls.complete += 1;
        seenModel = request.model;
        seenTokens = request.maxTokens;
        expect(request.user).toContain(MARKER);
        return {
          ok: true,
          text: JSON.stringify({ subject: "Hola", body: "Una nota." }),
          inputTokens: 10,
          outputTokens: 5,
          model: request.model,
        };
      },
    });
    const drafted = await composePitch(pro);
    expect(drafted.status).toBe("drafted");
    expect(pro.calls.charge).toBe(1);
    expect(seenModel).toBe("claude-sonnet-5-5");
    expect(seenTokens).toBe(maxTokensFor("pro"));
    expect(lines.join("\n")).not.toContain(MARKER);
    expect(lines.join("\n")).toContain('"inputTokens":10');
    expect(lines.join("\n")).toContain('"outputTokens":5');

    const max = deps({
      priority: true,
      complete: async (request) => {
        expect(request.model).toBe(seenModel);
        expect(request.maxTokens).toBeGreaterThan(seenTokens);
        return {
          ok: true,
          text: JSON.stringify({ subject: "Hola", body: "Una nota mas larga." }),
          inputTokens: 20,
          outputTokens: 15,
          model: request.model,
        };
      },
    });
    expect((await composePitch(max)).status).toBe("drafted");
  });

  it("stops before the model when credits or the budget are missing", async () => {
    const poor = deps({ balance: 0 });
    expect((await composePitch(poor)).status).toBe("out_of_credits");
    expect(poor.calls.complete).toBe(0);
    const paused = deps();
    expect((await composePitch(paused)).status).toBe("paused");
    expect(paused.calls.complete).toBe(0);
  });

  it("redacts a prompt if one is ever placed on a log field", () => {
    const redacted = redact({
      prompt: `hotel ${MARKER}`,
      inputTokens: 3,
      access_token: "sekret",
    });
    expect(JSON.stringify(redacted)).not.toContain(MARKER);
    expect(JSON.stringify(redacted)).toContain('"inputTokens":3');
    expect(JSON.stringify(redacted)).not.toContain("sekret");
    expect(redact({ inputTokens: "sekret-token-value" })).toEqual({ inputTokens: "[redacted]" });
    expect(
      JSON.stringify(
        tokenLog({
          model: "claude-sonnet-5-5",
          inputTokens: 1,
          outputTokens: 2,
          status: "completed",
        }),
      ),
    ).not.toContain("prompt");
  });
});

describe("assistant source", () => {
  it("does not send mail and does not read a user id from the form", () => {
    const files = [
      "src/lib/ai/actions.ts",
      "src/lib/ai/compose.server.ts",
      "src/lib/ai/claude.server.ts",
      "src/lib/ai/prompt.ts",
      "src/components/pitch/composer.tsx",
    ];
    const source = files.map((file) => readFileSync(path.join(ROOT, file), "utf8")).join("\n");
    expect(source).not.toMatch(/gmail\.send|messages\.send|users\.messages/);
    expect(source).not.toMatch(/formData\.get\(\s*"userId"/);
    expect(readFileSync(path.join(ROOT, "src/lib/ai/claude.server.ts"), "utf8")).not.toContain(
      "console.",
    );
    const usage = readFileSync(
      path.join(ROOT, "supabase/migrations/0082_ai_assistant.sql"),
      "utf8",
    );
    const table = usage.slice(
      usage.indexOf("create table public.ai_usage"),
      usage.indexOf("comment on table public.ai_usage"),
    );
    expect(table).not.toMatch(/prompt|completion|decoded_text|plain_text/);
  });
});
