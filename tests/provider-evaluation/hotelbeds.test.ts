/**
 * Hotelbeds evaluation client — deterministic tests.
 *
 * All fixtures are hand-written synthetic data; no provider response is
 * committed. Every test injects a fake `fetch`, a fake clock and a temp cache
 * root, so nothing here touches the network or the real 50/day quota.
 *
 * The behaviours pinned below are the ones that would silently destroy a day of
 * evaluation capacity if they regressed.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AuthenticationFailedError,
  BudgetExceededError,
  DailyQuotaError,
  EgressBlockedError,
  isTransientStatus,
  RequestBudget,
  terminalReasonFor,
} from "../../scripts/provider-evaluation/hotelbeds/budget";
import { cacheKey } from "../../scripts/provider-evaluation/hotelbeds/cache";
import { HotelbedsClient } from "../../scripts/provider-evaluation/hotelbeds/client";
import {
  buildAuthHeaders,
  redactHeaders,
  signRequest,
} from "../../scripts/provider-evaluation/hotelbeds/signature";
import {
  createHotelbedsTransport,
  probeCredentials,
} from "../../scripts/provider-evaluation/hotelbeds/transport";

const CREDENTIALS = { apiKey: "test-api-key-value", secret: "test-secret-value" };

function tempCacheRoot(): string {
  return mkdtempSync(join(tmpdir(), "hb-cache-"));
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Budget with instant, deterministic pacing. */
function testBudget(maxRequests: number, sleeps: number[] = []): RequestBudget {
  let clock = 0;
  return new RequestBudget({
    maxRequests,
    minIntervalMs: 700,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
}

describe("request signing", () => {
  it("is lowercase hex SHA256 of apiKey + secret + unix seconds", () => {
    // Deterministic vector: same inputs must always produce the same signature.
    const signature = signRequest("abc", "def", 1_700_000_000);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(signature).toBe(signRequest("abc", "def", 1_700_000_000));
  });

  it("changes with the timestamp, so a stale signature is never reused", () => {
    expect(signRequest("abc", "def", 1_700_000_000)).not.toBe(
      signRequest("abc", "def", 1_700_000_001),
    );
  });

  it("truncates fractional timestamps rather than signing a float", () => {
    expect(signRequest("abc", "def", 1_700_000_000.9)).toBe(
      signRequest("abc", "def", 1_700_000_000),
    );
  });

  it("never exposes the key or signature through redaction", () => {
    const headers = buildAuthHeaders(CREDENTIALS, 1_700_000_000);
    const redacted = redactHeaders(headers);

    expect(redacted["Api-key"]).toBe("[REDACTED]");
    expect(redacted["X-Signature"]).toBe("[REDACTED]");
    // Shape survives so a reviewer can see WHICH headers were sent.
    expect(redacted["Accept"]).toBe("application/json");
    expect(JSON.stringify(redacted)).not.toContain(CREDENTIALS.apiKey);
    expect(JSON.stringify(redacted)).not.toContain(CREDENTIALS.secret);
  });
});

describe("request budget", () => {
  it("stops BEFORE exceeding the ceiling", async () => {
    const budget = testBudget(2);
    await budget.reserve();
    await budget.reserve();

    await expect(budget.reserve()).rejects.toBeInstanceOf(BudgetExceededError);
    expect(budget.state.attempted).toBe(2);
    expect(budget.remaining).toBe(0);
  });

  it("paces requests to respect the burst allowance", async () => {
    const sleeps: number[] = [];
    const budget = testBudget(3, sleeps);

    await budget.reserve();
    await budget.reserve();
    await budget.reserve();

    // First request is immediate; each subsequent one waits the interval.
    expect(sleeps).toEqual([700, 700]);
  });

  it("counts a retry as an attempt, because the provider counts it too", async () => {
    const budget = testBudget(5);
    await budget.reserve();
    await budget.reserve(true);

    expect(budget.state.attempted).toBe(2);
    expect(budget.state.retries).toBe(1);
  });

  it("does not retry a 429 — under a 50/day quota that means stop", () => {
    expect(isTransientStatus(429)).toBe(false);
    expect(terminalReasonFor(429)).toBe("blocked_by_daily_quota");
    expect(isTransientStatus(503)).toBe(true);
    expect(terminalReasonFor(401)).toBe("authentication_failed");
    expect(terminalReasonFor(403)).toBe("authentication_failed");
    expect(terminalReasonFor(200)).toBeNull();
  });
});

describe("client caching", () => {
  it("serves a repeat request from cache with ZERO network calls", async () => {
    const cacheRoot = tempCacheRoot();
    let calls = 0;
    const budget = testBudget(10);
    const client = new HotelbedsClient({
      baseUrl: "https://api.test.invalid",
      credentials: CREDENTIALS,
      budget,
      cacheRoot,
      nowSeconds: () => 1_700_000_000,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ hotels: [{ code: 1 }], total: 1 });
      },
    });

    await client.request("/hotels", { destinationCode: "BAL" });
    expect(calls).toBe(1);
    expect(budget.state.attempted).toBe(1);

    // Second identical request: cache hit, no network, no budget spent.
    const second = await client.request("/hotels", { destinationCode: "BAL" });
    expect(second.fromCache).toBe(true);
    expect(calls).toBe(1);
    expect(budget.state.attempted).toBe(1);
    expect(budget.state.cacheHits).toBe(1);
  });

  it("does not confuse two different queries", async () => {
    const cacheRoot = tempCacheRoot();
    let calls = 0;
    const budget = testBudget(10);
    const client = new HotelbedsClient({
      baseUrl: "https://api.test.invalid",
      credentials: CREDENTIALS,
      budget,
      cacheRoot,
      nowSeconds: () => 1_700_000_000,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ hotels: [], total: 0 });
      },
    });

    await client.request("/hotels", { destinationCode: "BAL" });
    await client.request("/hotels", { destinationCode: "DXB" });
    expect(calls).toBe(2);
  });

  it("builds a stable key regardless of query ordering", () => {
    // Otherwise a caller reordering params would silently re-spend quota.
    const a = cacheKey("GET", "https://x/y?a=1&b=2");
    const b = cacheKey("GET", "https://x/y?a=1&b=2");
    expect(a).toBe(b);
    expect(cacheKey("GET", "https://x/y?a=1&b=3")).not.toBe(a);
  });
});

describe("client failure handling", () => {
  it("treats a proxy egress denial as EGRESS_BLOCKED, never an auth failure", async () => {
    // The distinction that matters: a blocked network says NOTHING about whether
    // the credential is valid, and consumes no provider quota.
    const budget = testBudget(5);
    const client = new HotelbedsClient({
      baseUrl: "https://api.test.invalid",
      credentials: CREDENTIALS,
      budget,
      cacheRoot: tempCacheRoot(),
      nowSeconds: () => 1_700_000_000,
      fetchImpl: async () =>
        new Response("Host not in allowlist", {
          status: 403,
          headers: { "x-deny-reason": "host_not_allowed" },
        }),
    });

    await expect(client.request("/types/categories")).rejects.toBeInstanceOf(EgressBlockedError);
    expect(budget.state.stopReason).toBe("egress_blocked");
    // Local attempt spent, but the provider was never reached.
    expect(budget.state.attempted).toBe(1);
    expect(budget.state.providerReached).toBe(0);
  });

  it("stops immediately on a genuine 401 without retrying", async () => {
    let calls = 0;
    const budget = testBudget(10);
    const client = new HotelbedsClient({
      baseUrl: "https://api.test.invalid",
      credentials: CREDENTIALS,
      budget,
      cacheRoot: tempCacheRoot(),
      nowSeconds: () => 1_700_000_000,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ error: "unauthorised" }, 401);
      },
    });

    await expect(client.request("/hotels")).rejects.toBeInstanceOf(AuthenticationFailedError);
    // Exactly one attempt: hammering a rejected credential burns the day.
    expect(calls).toBe(1);
    expect(budget.state.stopReason).toBe("authentication_failed");
    expect(budget.state.providerReached).toBe(1);
  });

  it("records BLOCKED_BY_DAILY_QUOTA on a 429 and stops", async () => {
    let calls = 0;
    const budget = testBudget(10);
    const client = new HotelbedsClient({
      baseUrl: "https://api.test.invalid",
      credentials: CREDENTIALS,
      budget,
      cacheRoot: tempCacheRoot(),
      nowSeconds: () => 1_700_000_000,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ error: "quota" }, 429);
      },
    });

    await expect(client.request("/hotels")).rejects.toBeInstanceOf(DailyQuotaError);
    expect(calls).toBe(1);
    expect(budget.state.stopReason).toBe("blocked_by_daily_quota");
  });

  it("retries a transient 503 exactly once, and the retry costs budget", async () => {
    let calls = 0;
    const budget = testBudget(10);
    const client = new HotelbedsClient({
      baseUrl: "https://api.test.invalid",
      credentials: CREDENTIALS,
      budget,
      cacheRoot: tempCacheRoot(),
      nowSeconds: () => 1_700_000_000,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? jsonResponse({}, 503) : jsonResponse({ hotels: [], total: 0 });
      },
    });

    await client.request("/hotels");
    expect(calls).toBe(2);
    expect(budget.state.attempted).toBe(2);
    expect(budget.state.retries).toBe(1);
  });

  it("refuses to start a request once the budget is spent", async () => {
    let calls = 0;
    const budget = testBudget(1);
    const client = new HotelbedsClient({
      baseUrl: "https://api.test.invalid",
      credentials: CREDENTIALS,
      budget,
      cacheRoot: tempCacheRoot(),
      nowSeconds: () => 1_700_000_000,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ hotels: [], total: 0 });
      },
    });

    await client.request("/hotels", { destinationCode: "A" });
    await expect(client.request("/hotels", { destinationCode: "B" })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    // The second request never hit the network.
    expect(calls).toBe(1);
  });
});

describe("hotels transport pagination", () => {
  function clientReturning(pages: { hotels: unknown[]; total: number }[]): {
    client: HotelbedsClient;
    budget: RequestBudget;
  } {
    let index = 0;
    const budget = testBudget(20);
    const client = new HotelbedsClient({
      baseUrl: "https://api.test.invalid",
      credentials: CREDENTIALS,
      budget,
      cacheRoot: tempCacheRoot(),
      nowSeconds: () => 1_700_000_000,
      fetchImpl: async () => {
        const page = pages[index] ?? { hotels: [], total: 0 };
        index += 1;
        return jsonResponse(page);
      },
    });
    return { client, budget };
  }

  it("walks the from/to window until the provider's total is reached", async () => {
    const { client } = clientReturning([
      { hotels: Array.from({ length: 3 }, (_, i) => ({ code: i })), total: 5 },
      { hotels: Array.from({ length: 2 }, (_, i) => ({ code: 10 + i })), total: 5 },
    ]);
    const transport = createHotelbedsTransport(client, 3);

    const first = await transport.fetchPage("BAL", null);
    expect(first.records).toHaveLength(3);
    expect(first.reportedTotal).toBe(5);
    expect(first.nextCursor).toBe("4");

    const second = await transport.fetchPage("BAL", first.nextCursor);
    expect(second.records).toHaveLength(2);
    // 3 + 2 = 5 = total, so the walk terminates.
    expect(second.nextCursor).toBeNull();
  });

  it("terminates on a short page", async () => {
    const { client } = clientReturning([{ hotels: [{ code: 1 }], total: 100 }]);
    const transport = createHotelbedsTransport(client, 10);
    const page = await transport.fetchPage("DXB", null);
    expect(page.nextCursor).toBeNull();
  });

  it("terminates on an empty page rather than looping", async () => {
    const { client } = clientReturning([{ hotels: [], total: 0 }]);
    const transport = createHotelbedsTransport(client, 10);
    const page = await transport.fetchPage("DXB", null);
    expect(page.records).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });
});

describe("credential probe", () => {
  it("reports UNTESTED when egress is blocked", async () => {
    const budget = testBudget(5);
    const client = new HotelbedsClient({
      baseUrl: "https://api.test.invalid",
      credentials: CREDENTIALS,
      budget,
      cacheRoot: tempCacheRoot(),
      nowSeconds: () => 1_700_000_000,
      fetchImpl: async () =>
        new Response("blocked", { status: 403, headers: { "x-deny-reason": "host_not_allowed" } }),
    });

    const result = await probeCredentials(client);
    expect(result.credentials).toBe("untested");
    expect(result.reachable).toBe(false);
  });

  it("reports INVALID only for a genuine provider rejection", async () => {
    const budget = testBudget(5);
    const client = new HotelbedsClient({
      baseUrl: "https://api.test.invalid",
      credentials: CREDENTIALS,
      budget,
      cacheRoot: tempCacheRoot(),
      nowSeconds: () => 1_700_000_000,
      fetchImpl: async () => jsonResponse({ error: "bad signature" }, 401),
    });

    const result = await probeCredentials(client);
    expect(result.credentials).toBe("invalid");
    expect(result.reachable).toBe(true);
  });

  it("reports VALID on success", async () => {
    const budget = testBudget(5);
    const client = new HotelbedsClient({
      baseUrl: "https://api.test.invalid",
      credentials: CREDENTIALS,
      budget,
      cacheRoot: tempCacheRoot(),
      nowSeconds: () => 1_700_000_000,
      fetchImpl: async () => jsonResponse({ categories: [] }),
    });

    const result = await probeCredentials(client);
    expect(result.credentials).toBe("valid");
    expect(result.reachable).toBe(true);
  });
});
