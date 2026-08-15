/**
 * Hotelbeds evaluation client — deterministic tests.
 *
 * All fixtures are hand-written synthetic data; no provider response is
 * committed. Every test injects a fake `fetch`, a fake clock and a temp
 * cache/ledger root, so nothing here touches the network or the real 50/day
 * quota.
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
  DailyQuotaExhaustedError,
  QuotaLedger,
} from "../../scripts/provider-evaluation/hotelbeds/quota-ledger";
import {
  accountFingerprint,
  buildAuthHeaders,
  redactHeaders,
  signRequest,
} from "../../scripts/provider-evaluation/hotelbeds/signature";
import {
  createHotelbedsTransport,
  probeCredentials,
} from "../../scripts/provider-evaluation/hotelbeds/transport";

const CREDENTIALS = { apiKey: "test-api-key-value", secret: "test-secret-value" };
const OTHER_CREDENTIALS = { apiKey: "different-account-key", secret: "other-secret" };

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "hb-eval-"));
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

interface ClientSetup {
  root?: string;
  credentials?: { apiKey: string; secret: string };
  budget?: RequestBudget;
  ledger?: QuotaLedger;
  quota?: number;
  now?: number;
  fetchImpl: typeof fetch;
  useCache?: boolean;
}

function makeClient(setup: ClientSetup): {
  client: HotelbedsClient;
  budget: RequestBudget;
  ledger: QuotaLedger;
  root: string;
} {
  const root = setup.root ?? tempRoot();
  const credentials = setup.credentials ?? CREDENTIALS;
  const budget = setup.budget ?? testBudget(20);
  const ledger =
    setup.ledger ??
    new QuotaLedger(accountFingerprint(credentials.apiKey), {
      root,
      quota: setup.quota ?? 50,
      now: () => setup.now ?? 1_000_000,
    });

  const client = new HotelbedsClient({
    baseUrl: "https://api.test.invalid",
    credentials,
    budget,
    ledger,
    cacheRoot: root,
    useCache: setup.useCache,
    nowSeconds: () => 1_700_000_000,
    fetchImpl: setup.fetchImpl,
  });

  return { client, budget, ledger, root };
}

describe("request signing", () => {
  it("is lowercase hex SHA256 of apiKey + secret + unix seconds", () => {
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
    const redacted = redactHeaders(buildAuthHeaders(CREDENTIALS, 1_700_000_000));
    expect(redacted["Api-key"]).toBe("[REDACTED]");
    expect(redacted["X-Signature"]).toBe("[REDACTED]");
    expect(redacted["Accept"]).toBe("application/json");
    expect(JSON.stringify(redacted)).not.toContain(CREDENTIALS.apiKey);
    expect(JSON.stringify(redacted)).not.toContain(CREDENTIALS.secret);
  });

  it("produces a short irreversible account fingerprint that is not the key", () => {
    const fingerprint = accountFingerprint(CREDENTIALS.apiKey);
    expect(fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprint).not.toContain(CREDENTIALS.apiKey);
    expect(accountFingerprint(OTHER_CREDENTIALS.apiKey)).not.toBe(fingerprint);
  });
});

describe("in-process request budget", () => {
  it("stops BEFORE exceeding the ceiling", async () => {
    const budget = testBudget(2);
    await budget.reserve();
    await budget.reserve();
    await expect(budget.reserve()).rejects.toBeInstanceOf(BudgetExceededError);
    expect(budget.remaining).toBe(0);
  });

  it("paces requests to respect the burst allowance", async () => {
    const sleeps: number[] = [];
    const budget = testBudget(3, sleeps);
    await budget.reserve();
    await budget.reserve();
    await budget.reserve();
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
    expect(terminalReasonFor(200)).toBeNull();
  });
});

describe("persistent daily quota ledger", () => {
  it("SURVIVES a process restart — a second run cannot reset the allowance", async () => {
    // The failure this exists to prevent: run A spends 30, exits; run B starts
    // fresh and allows 40 more, pushing a 50/day account to 70.
    const root = tempRoot();
    const now = 5_000_000;

    // "Process A" — a brand-new ledger instance.
    const ledgerA = new QuotaLedger("acct", { root, quota: 5, now: () => now });
    for (let i = 0; i < 5; i += 1) ledgerA.record(200);
    expect(ledgerA.remaining()).toBe(0);

    // "Process B" — an entirely separate instance, same account, same root.
    const ledgerB = new QuotaLedger("acct", { root, quota: 5, now: () => now });
    expect(ledgerB.spent()).toBe(5);
    expect(ledgerB.remaining()).toBe(0);

    // And the client built on it refuses to make request 6.
    let calls = 0;
    const { client } = makeClient({
      root,
      ledger: ledgerB,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ ok: true });
      },
    });

    await expect(client.request("/hotels", { d: "X" })).rejects.toBeInstanceOf(
      DailyQuotaExhaustedError,
    );
    expect(calls).toBe(0);
  });

  it("scopes the allowance per account fingerprint", () => {
    const root = tempRoot();
    const now = 5_000_000;
    const a = new QuotaLedger("acct-a", { root, quota: 5, now: () => now });
    const b = new QuotaLedger("acct-b", { root, quota: 5, now: () => now });

    for (let i = 0; i < 5; i += 1) a.record(200);
    expect(a.remaining()).toBe(0);
    // A different credential must not inherit another account's spend.
    expect(b.remaining()).toBe(5);
  });

  it("rolls the window forward conservatively over 24h", () => {
    const root = tempRoot();
    const day = 86_400_000;
    let now = 1_000_000_000;

    const early = new QuotaLedger("acct", { root, quota: 5, now: () => now });
    early.record(200);
    expect(early.spent()).toBe(1);

    // 24h + 1ms later the entry has aged out of the rolling window.
    now += day + 1;
    const later = new QuotaLedger("acct", { root, quota: 5, now: () => now });
    expect(later.spent()).toBe(0);
    expect(later.summary().windowIsConservativeRolling).toBe(true);
  });

  it("counts provider responses but never cache hits or egress denials", async () => {
    const root = tempRoot();
    const { client, ledger } = makeClient({
      root,
      fetchImpl: async () => jsonResponse({ hotels: [], total: 0 }),
    });

    await client.request("/hotels", { d: "A" });
    expect(ledger.spent()).toBe(1);

    // Cache hit: no provider contact, no quota.
    await client.request("/hotels", { d: "A" });
    expect(ledger.spent()).toBe(1);

    // Egress denial: never reached the provider, no quota.
    const blocked = makeClient({
      root,
      ledger,
      fetchImpl: async () =>
        new Response("blocked", { status: 403, headers: { "x-deny-reason": "host_not_allowed" } }),
    });
    await expect(blocked.client.request("/hotels", { d: "B" })).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
    expect(ledger.spent()).toBe(1);
  });

  it("refuses to treat a corrupt ledger as an empty one", () => {
    const root = tempRoot();
    const ledger = new QuotaLedger("acct", { root, now: () => 1 });
    ledger.record(200);
    // Corrupt the file: reading it as "nothing spent" would silently restore
    // the whole daily allowance, so it must fail closed.
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(join(root, "hotelbeds/quota-ledger.json"), "{not json", "utf8");
    expect(() => ledger.spent()).toThrow(/unreadable/);
  });
});

describe("account-aware cache", () => {
  it("does not let a different account reuse another's cached response", async () => {
    const root = tempRoot();
    let callsA = 0;
    let callsB = 0;

    const a = makeClient({
      root,
      credentials: CREDENTIALS,
      fetchImpl: async () => {
        callsA += 1;
        return jsonResponse({ hotels: [{ code: "a" }], total: 1 });
      },
    });
    await a.client.request("/hotels", { destinationCode: "BAL" });
    expect(callsA).toBe(1);

    // Same URL, DIFFERENT account: must not read the first account's entry,
    // because provider content can differ by account portfolio.
    const b = makeClient({
      root,
      credentials: OTHER_CREDENTIALS,
      fetchImpl: async () => {
        callsB += 1;
        return jsonResponse({ hotels: [{ code: "b" }], total: 1 });
      },
    });
    const result = await b.client.request("/hotels", { destinationCode: "BAL" });

    expect(callsB).toBe(1);
    expect(result.fromCache).toBe(false);
  });

  it("keys on provider, base URL, account, method and query", () => {
    const base = {
      provider: "hotelbeds",
      baseUrl: "https://api.test.invalid",
      accountFingerprint: "aaa",
      method: "GET",
      url: "https://x/y?a=1",
    };
    const key = cacheKey(base);
    expect(cacheKey(base)).toBe(key);
    expect(cacheKey({ ...base, accountFingerprint: "bbb" })).not.toBe(key);
    expect(cacheKey({ ...base, baseUrl: "https://api.hotelbeds.invalid" })).not.toBe(key);
    expect(cacheKey({ ...base, url: "https://x/y?a=2" })).not.toBe(key);
  });

  it("serves a repeat request from cache with ZERO network calls", async () => {
    let calls = 0;
    const { client, budget } = makeClient({
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ hotels: [{ code: 1 }], total: 1 });
      },
    });

    await client.request("/hotels", { destinationCode: "BAL" });
    const second = await client.request("/hotels", { destinationCode: "BAL" });

    expect(second.fromCache).toBe(true);
    expect(calls).toBe(1);
    expect(budget.state.attempted).toBe(1);
    expect(budget.state.cacheHits).toBe(1);
  });
});

describe("client failure handling", () => {
  it("treats a proxy egress denial as EGRESS_BLOCKED, never an auth failure", async () => {
    const { client, budget } = makeClient({
      fetchImpl: async () =>
        new Response("Host not in allowlist", {
          status: 403,
          headers: { "x-deny-reason": "host_not_allowed" },
        }),
    });

    await expect(client.request("/types/categories")).rejects.toBeInstanceOf(EgressBlockedError);
    expect(budget.state.stopReason).toBe("egress_blocked");
    expect(budget.state.providerReached).toBe(0);
  });

  it("stops immediately on a genuine 401 without retrying", async () => {
    let calls = 0;
    const { client, budget } = makeClient({
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ error: "unauthorised" }, 401);
      },
    });

    await expect(client.request("/hotels")).rejects.toBeInstanceOf(AuthenticationFailedError);
    expect(calls).toBe(1);
    expect(budget.state.providerReached).toBe(1);
  });

  it("records BLOCKED_BY_DAILY_QUOTA on a provider 429 and stops", async () => {
    const { client, budget } = makeClient({
      fetchImpl: async () => jsonResponse({ error: "quota" }, 429),
    });
    await expect(client.request("/hotels")).rejects.toBeInstanceOf(DailyQuotaError);
    expect(budget.state.stopReason).toBe("blocked_by_daily_quota");
  });

  it("retries a transient 503 exactly once, and the retry costs budget and quota", async () => {
    let calls = 0;
    const { client, budget, ledger } = makeClient({
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? jsonResponse({}, 503) : jsonResponse({ hotels: [], total: 0 });
      },
    });

    await client.request("/hotels");
    expect(calls).toBe(2);
    expect(budget.state.retries).toBe(1);
    // Both attempts reached the provider, so both count against the daily quota.
    expect(ledger.spent()).toBe(2);
  });

  it("refuses to start a request once the local budget is spent", async () => {
    let calls = 0;
    const { client } = makeClient({
      budget: testBudget(1),
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ hotels: [], total: 0 });
      },
    });

    await client.request("/hotels", { destinationCode: "A" });
    await expect(client.request("/hotels", { destinationCode: "B" })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(calls).toBe(1);
  });
});

describe("hotels transport pagination", () => {
  function clientReturning(pages: { hotels: unknown[]; total: number }[]): HotelbedsClient {
    let index = 0;
    return makeClient({
      fetchImpl: async () => {
        const page = pages[index] ?? { hotels: [], total: 0 };
        index += 1;
        return jsonResponse(page);
      },
    }).client;
  }

  it("walks the from/to window until the provider's total is reached", async () => {
    const transport = createHotelbedsTransport(
      clientReturning([
        { hotels: Array.from({ length: 3 }, (_, i) => ({ code: i })), total: 5 },
        { hotels: Array.from({ length: 2 }, (_, i) => ({ code: 10 + i })), total: 5 },
      ]),
      3,
    );

    const first = await transport.fetchPage("BAL", null);
    expect(first.records).toHaveLength(3);
    expect(first.nextCursor).toBe("4");

    const second = await transport.fetchPage("BAL", first.nextCursor);
    expect(second.records).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
  });

  it("terminates on a short page", async () => {
    const transport = createHotelbedsTransport(
      clientReturning([{ hotels: [{ code: 1 }], total: 100 }]),
      10,
    );
    expect((await transport.fetchPage("DXB", null)).nextCursor).toBeNull();
  });

  it("terminates on an empty page rather than looping", async () => {
    const transport = createHotelbedsTransport(clientReturning([{ hotels: [], total: 0 }]), 10);
    const page = await transport.fetchPage("DXB", null);
    expect(page.records).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });
});

describe("credential probe", () => {
  it("NEVER reports valid from a cached response — it bypasses the cache", async () => {
    // A cached 200 from yesterday cannot prove today's credential still works:
    // keys get revoked and rotated. The probe must ask the provider.
    const root = tempRoot();
    let calls = 0;

    const seed = makeClient({
      root,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ categories: [] });
      },
    });
    // Warm the cache with the exact request the probe will make.
    await seed.client.request("/hotel-content-api/1.0/types/categories", {
      fields: "all",
      language: "ENG",
      from: 1,
      to: 1,
    });
    expect(calls).toBe(1);

    const result = await probeCredentials(seed.client);

    expect(result.credentials).toBe("valid");
    // The probe issued its own live request rather than reusing the cache.
    expect(calls).toBe(2);
    expect(result.detail).toContain("cache bypassed");
  });

  it("reports UNTESTED when egress is blocked", async () => {
    const { client } = makeClient({
      fetchImpl: async () =>
        new Response("blocked", { status: 403, headers: { "x-deny-reason": "host_not_allowed" } }),
    });
    const result = await probeCredentials(client);
    expect(result.credentials).toBe("untested");
    expect(result.reachable).toBe(false);
  });

  it("reports INVALID only for a genuine provider rejection", async () => {
    const { client } = makeClient({
      fetchImpl: async () => jsonResponse({ error: "bad signature" }, 401),
    });
    const result = await probeCredentials(client);
    expect(result.credentials).toBe("invalid");
    expect(result.reachable).toBe(true);
  });
});
