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
  proxyConfiguredButUnused,
  RequestBudget,
  terminalReasonFor,
} from "../../scripts/provider-evaluation/hotelbeds/budget";
import { cacheKey } from "../../scripts/provider-evaluation/hotelbeds/cache";
import { HotelbedsClient } from "../../scripts/provider-evaluation/hotelbeds/client";
import {
  DailyQuotaExhaustedError,
  EvaluationLock,
  EvaluationLockedError,
  QuotaLedger,
} from "../../scripts/provider-evaluation/hotelbeds/quota-ledger";
import {
  accountFingerprint,
  buildAuthHeaders,
  redactHeaders,
  signRequest,
} from "../../scripts/provider-evaluation/hotelbeds/signature";
import { analyseDestination } from "../../scripts/provider-evaluation/hotelbeds/destination-report";
import {
  comparePilotAgainstProvider,
  type ProviderRecordLike,
} from "../../scripts/provider-evaluation/hotelbeds/pilot-comparison";
import { hotelbedsContentDescriptor } from "../../scripts/provider-evaluation/adapters/hotelbeds";
import {
  createHotelbedsTransport,
  fetchDestinations,
  fetchHotelbedsCategoryMaster,
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

describe("ambiguous network failures protect the allowance honestly", () => {
  it("counts a mid-flight failure as POSSIBLY consumed, not confirmed", async () => {
    // The request left this process and no response came back. Hotelbeds may
    // have received and charged it; we cannot prove otherwise.
    const { client, ledger } = makeClient({
      budget: testBudget(1),
      fetchImpl: async () => {
        throw new TypeError("terminated");
      },
    });

    await expect(client.request("/hotels", { d: "A" })).rejects.toThrow();

    const summary = ledger.summary();
    expect(summary.possiblyConsumedInWindow).toBe(1);
    expect(summary.confirmedInWindow).toBe(0);
    // The guard is conservative even though the report is honest.
    expect(summary.spentInWindow).toBe(1);
    expect(summary.remainingInWindow).toBe(49);
  });

  it("keeps an explicit egress denial OUT of the quota entirely", async () => {
    const { client, ledger } = makeClient({
      fetchImpl: async () =>
        new Response("blocked", { status: 403, headers: { "x-deny-reason": "host_not_allowed" } }),
    });

    await expect(client.request("/hotels")).rejects.toBeInstanceOf(EgressBlockedError);

    const summary = ledger.summary();
    expect(summary.spentInWindow).toBe(0);
    expect(summary.possiblyConsumedInWindow).toBe(0);
  });

  it("reports the CONFIGURED quota when exhausted, not a reconstruction", async () => {
    const root = tempRoot();
    const ledger = new QuotaLedger("acct", { root, quota: 7, now: () => 1_000 });
    for (let i = 0; i < 7; i += 1) ledger.record(200);

    const { client } = makeClient({ root, ledger, fetchImpl: async () => jsonResponse({}) });

    // `spent + remaining` collapses to `spent` at zero; the message must still
    // name the real limit.
    await expect(client.request("/hotels")).rejects.toMatchObject({ spent: 7, quota: 7 });
  });
});

describe("cross-process evaluation lock", () => {
  it("refuses a second concurrent evaluation on the same account", () => {
    const root = tempRoot();
    const first = new EvaluationLock("acct", { root, now: () => 1_000 });
    first.acquire(111);

    // A second process must not proceed: both reading 49/50 would both issue 50.
    const second = new EvaluationLock("acct", { root, now: () => 1_000 });
    expect(() => second.acquire(222)).toThrow(EvaluationLockedError);
  });

  it("allows a fresh acquisition after release", () => {
    const root = tempRoot();
    const first = new EvaluationLock("acct", { root, now: () => 1_000 });
    first.acquire(111);
    first.release();

    const second = new EvaluationLock("acct", { root, now: () => 1_000 });
    expect(() => second.acquire(222)).not.toThrow();
  });

  it("reclaims a stale lock deliberately, and says so", () => {
    const root = tempRoot();
    new EvaluationLock("acct", { root, now: () => 0 }).acquire(111);

    // 16 minutes later the owner is presumed crashed.
    const later = new EvaluationLock("acct", { root, now: () => 16 * 60_000 });
    const result = later.acquire(222);
    expect(result.reclaimedStaleLock).toBe(true);
  });

  it("does NOT steal a lock that is still fresh", () => {
    const root = tempRoot();
    new EvaluationLock("acct", { root, now: () => 0 }).acquire(111);
    const soon = new EvaluationLock("acct", { root, now: () => 60_000 });
    expect(() => soon.acquire(222)).toThrow(EvaluationLockedError);
  });
});

describe("exhaustive master-data pagination", () => {
  function pagedClient(
    pages: { rows: unknown[]; total: number | null }[],
    key: string,
    budget?: RequestBudget,
  ) {
    let index = 0;
    return makeClient({
      budget,
      fetchImpl: async () => {
        // Out of fixtures: an empty page that asserts NO total, so it cannot
        // clobber the provider total the earlier pages reported.
        const page = pages[index] ?? { rows: [], total: null };
        index += 1;
        return jsonResponse({
          [key]: page.rows,
          ...(page.total === null ? {} : { total: page.total }),
        });
      },
    });
  }

  function destinations(n: number, offset = 0): unknown[] {
    return Array.from({ length: n }, (_, i) => ({
      code: `D${offset + i}`,
      name: { content: `Dest ${offset + i}` },
      countryCode: "ID",
    }));
  }

  it("A: a single short page is exhaustive", async () => {
    const { client } = pagedClient([{ rows: destinations(12), total: 12 }], "destinations");
    const result = await fetchDestinations(client, "ID", 1000);
    expect(result.destinations).toHaveLength(12);
    expect(result.evidence.exhaustionProven).toBe(true);
    expect(result.interrupted).toBe(false);
  });

  it("B: a FULL page with a larger provider total fetches the next page", async () => {
    // The exact bug the single-request version had: 1000 returned, 1500 exist.
    const { client } = pagedClient(
      [
        { rows: destinations(1000), total: 1500 },
        { rows: destinations(500, 1000), total: 1500 },
      ],
      "destinations",
    );
    const result = await fetchDestinations(client, "ID", 1000);
    expect(result.destinations).toHaveLength(1500);
    expect(result.evidence.pages).toBe(2);
    expect(result.evidence.exhaustionProven).toBe(true);
  });

  it("C: walks several pages to exhaustion", async () => {
    const { client } = pagedClient(
      [
        { rows: destinations(10), total: 25 },
        { rows: destinations(10, 10), total: 25 },
        { rows: destinations(5, 20), total: 25 },
      ],
      "destinations",
    );
    const result = await fetchDestinations(client, "ID", 10);
    expect(result.destinations).toHaveLength(25);
    expect(result.evidence.exhaustionProven).toBe(true);
  });

  it("D: a provider-total disagreement means exhaustion is NOT proven", async () => {
    const { client } = pagedClient([{ rows: destinations(5), total: 900 }], "destinations");
    const result = await fetchDestinations(client, "ID", 1000);
    expect(result.evidence.exhaustionProven).toBe(false);
    expect(result.interrupted).toBe(true);
    expect(result.evidence.coverageRisks.join(" ")).toContain("reported a total of 900");
  });

  it("E: a budget interruption stops the walk rather than reporting a partial total", async () => {
    const { client } = pagedClient(
      [
        { rows: destinations(10), total: 100 },
        { rows: destinations(10, 10), total: 100 },
      ],
      "destinations",
      // Only one request is affordable, so the walk cannot reach 100.
      testBudget(1),
    );
    await expect(fetchDestinations(client, "ID", 10)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("fetches the categories master and reports duplicates", async () => {
    const { client } = pagedClient(
      [
        {
          rows: [
            {
              code: "5EST",
              simpleCode: "5",
              accommodationType: "HOTEL",
              description: { content: "5 STAR" },
            },
            {
              code: "5LL",
              simpleCode: "5",
              accommodationType: "APARTMENT",
              description: { content: "5 KEY" },
            },
            {
              code: "5EST",
              simpleCode: "5",
              accommodationType: "HOTEL",
              description: { content: "5 STAR" },
            },
          ],
          total: 3,
        },
      ],
      "categories",
    );

    const master = await fetchHotelbedsCategoryMaster(client);
    expect(master.rawCount).toBe(3);
    expect(master.uniqueCodes).toBe(2);
    expect(master.duplicateCodes).toEqual(["5EST"]);
    expect(master.evidence.exhaustionProven).toBe(true);
    // The join preserves the distinction that matters.
    expect(master.classifications.get("5EST")?.accommodationType).toBe("HOTEL");
    expect(master.classifications.get("5LL")?.description).toBe("5 KEY");
  });
});

describe("a bypassed proxy is not a policy denial", () => {
  // Node's built-in fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY is set.
  // With a proxy configured and the flag missing, a REACHABLE host comes back
  // denied — and reporting that as "blocked by policy" sends someone to change
  // an allowlist that was never the problem.
  it("detects a configured-but-unused proxy", () => {
    expect(proxyConfiguredButUnused({ HTTPS_PROXY: "http://127.0.0.1:1" })).toBe(true);
    expect(proxyConfiguredButUnused({ https_proxy: "http://127.0.0.1:1" })).toBe(true);
    expect(
      proxyConfiguredButUnused({ HTTPS_PROXY: "http://127.0.0.1:1", NODE_USE_ENV_PROXY: "1" }),
    ).toBe(false);
    // No proxy at all: a denial really is a denial.
    expect(proxyConfiguredButUnused({})).toBe(false);
  });

  it("still reports the host and the deny reason", () => {
    const error = new EgressBlockedError("api.test.hotelbeds.com", "host_not_allowed");
    expect(error.host).toBe("api.test.hotelbeds.com");
    expect(error.denyReason).toBe("host_not_allowed");
    // The core claim is unchanged: nothing reached the provider, so nothing was
    // spent and the credential stays UNTESTED rather than invalid.
    expect(error.message).toContain("no provider quota was consumed");
    expect(error.message).toContain("UNTESTED");
  });
});

describe("per-destination source analysis", () => {
  const descriptor = hotelbedsContentDescriptor;
  const master = new Map([
    [
      "5EST",
      {
        code: "5EST",
        simpleCode: "5",
        accommodationType: null,
        group: "GRUPO5",
        description: "5 STARS",
      },
    ],
    [
      "5LL",
      {
        code: "5LL",
        simpleCode: "5",
        accommodationType: null,
        group: "GRUPO7",
        description: "5 KEYS",
      },
    ],
    [
      "VILLA",
      {
        code: "VILLA",
        simpleCode: "4",
        accommodationType: null,
        group: "GRUPO4",
        description: "VILLA",
      },
    ],
  ]);

  function hotel(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      code: 100,
      name: { content: "Test Hotel" },
      destinationCode: "DXB",
      zoneCode: 1,
      categoryCode: "5EST",
      accommodationTypeCode: "H",
      coordinates: { latitude: 25.1, longitude: 55.2 },
      address: { content: "1 Test Street" },
      postalCode: "00000",
      chainCode: "TEST",
      web: "https://test.example",
      email: "info@test.example",
      phones: [{ phoneNumber: "+97141234567", phoneType: "PHONEHOTEL" }],
      images: [
        { imageTypeCode: "GEN", path: "a.jpg", visualOrder: 900 },
        { imageTypeCode: "HAB", path: "b.jpg", visualOrder: 100 },
      ],
      ...over,
    };
  }

  const pagination = { requests: 1, pages: 1, providerReportedTotal: 2, exhaustionProven: true };

  it("retains every record and never discards an unrecognised one", () => {
    // A source record that vanishes because we do not understand it is
    // indistinguishable, in the output, from one the provider never had.
    const analysis = analyseDestination(
      "dubai",
      ["DXB"],
      [hotel(), hotel({ code: 101, categoryCode: "UNKNOWN_CODE" })],
      descriptor,
      master,
      pagination,
    );
    expect(analysis.inventory.rawRecords).toBe(2);
    expect(analysis.inventory.uniqueProviderIds).toBe(2);
    expect(analysis.providerClassification.unjoined).toBe(1);
    expect(analysis.providerClassification.codesMissingFromMaster).toEqual(["UNKNOWN_CODE"]);
  });

  it("keeps KEY and VILLA categories out of any star bucket", () => {
    const analysis = analyseDestination(
      "dubai",
      ["DXB"],
      [
        hotel(),
        hotel({ code: 101, categoryCode: "5LL" }),
        hotel({ code: 102, categoryCode: "VILLA" }),
      ],
      descriptor,
      master,
      pagination,
    );
    expect(analysis.providerClassification.starLabelled).toBe(1);
    expect(analysis.providerClassification.keyLabelled).toBe(1);
    expect(analysis.providerClassification.otherLabelled).toBe(1);
    // Both share simpleCode 5 with 5EST — which is precisely why simpleCode
    // cannot stand in for a star rating.
    expect(analysis.providerClassification.simpleCodeDistribution["5"]).toBe(2);
  });

  it("separates OUR wrong path from the provider's empty field", () => {
    // `status` does not exist anywhere in a Hotelbeds hotels payload, while a
    // present-but-blank key is a genuine provider gap. Same 0% on the surface,
    // opposite owners underneath.
    const withBlank = analyseDestination(
      "dubai",
      ["DXB"],
      [hotel({ web: "" }), hotel({ code: 101, web: "" })],
      descriptor,
      master,
      pagination,
    );
    const website = withBlank.fieldFindings.find((f) => f.field === "websiteUrl");
    expect(website?.verdict).toBe("field_not_populated");

    const mismatched = analyseDestination(
      "dubai",
      ["DXB"],
      [hotel()],
      { ...descriptor, fieldMap: { ...descriptor.fieldMap, websiteUrl: "no_such_key" } },
      master,
      pagination,
    );
    expect(mismatched.fieldFindings.find((f) => f.field === "websiteUrl")?.verdict).toBe(
      "field_map_mismatch",
    );
  });

  it("counts a record outside the approved mapping as a contradiction", () => {
    const analysis = analyseDestination(
      "dubai",
      ["DXB"],
      [hotel(), hotel({ code: 101, destinationCode: "AUH" })],
      descriptor,
      master,
      pagination,
    );
    expect(analysis.geography.contradictions).toBe(1);
    expect(analysis.geography.destinationCodesReturned).toEqual({ DXB: 1, AUH: 1 });
  });

  it("does not report a fax number as a phone", () => {
    const analysis = analyseDestination(
      "dubai",
      ["DXB"],
      [hotel({ phones: [{ phoneNumber: "+97141234567", phoneType: "FAXNUMBER" }] })],
      descriptor,
      master,
      pagination,
    );
    expect(analysis.identity.phoneAnyPresent).toBe(1);
    expect(analysis.identity.nonFaxPhonePresent).toBe(0);
  });

  it("never lets a locally-chosen image count as the provider's principal", () => {
    // Live visualOrder values are large ranks, so the DOCUMENTED provider rule
    // finds nothing here. A deterministic local pick is still available — but
    // "we can select one image" is not "the provider says this one is main",
    // and only the second may be cited as hero coverage.
    const analysis = analyseDestination(
      "dubai",
      ["DXB"],
      [hotel()],
      descriptor,
      master,
      pagination,
    );
    expect(analysis.media.propertiesWithProviderDesignatedPrincipal).toBe(0);
    expect(analysis.media.documentedPrincipalSemanticsContradicted).toBe(true);
    expect(analysis.media.propertiesWithDeterministicRepresentativeCandidate).toBe(1);
    expect(analysis.media.representativeCandidateSelectionOrigin).toBe(
      "local_deterministic_fallback",
    );
  });

  it("counts the provider-designated principal when the documented marker IS present", () => {
    const analysis = analyseDestination(
      "dubai",
      ["DXB"],
      [hotel({ images: [{ imageTypeCode: "GEN", path: "a.jpg", visualOrder: 0 }] })],
      descriptor,
      master,
      pagination,
    );
    expect(analysis.media.propertiesWithProviderDesignatedPrincipal).toBe(1);
    expect(analysis.media.documentedPrincipalSemanticsContradicted).toBe(false);
  });

  it("reports median and average image counts separately", () => {
    const analysis = analyseDestination(
      "dubai",
      ["DXB"],
      [
        hotel({ images: [] }),
        hotel({ code: 101, images: [{ path: "a.jpg", visualOrder: 1 }] }),
        hotel({
          code: 102,
          images: Array.from({ length: 100 }, (_, i) => ({ path: `${i}.jpg`, visualOrder: i })),
        }),
      ],
      descriptor,
      master,
      pagination,
    );
    // A long tail of image-rich properties drags the mean far above the median,
    // which is why the brief asks for both.
    expect(analysis.media.medianImages).toBe(1);
    expect(analysis.media.averageImages).toBeCloseTo(33.67, 1);
  });
});

describe("pilot comparison counts INDEPENDENT dimensions", () => {
  // The bug this suite exists to prevent: `exactNormalizedNameAgrees` and
  // `allPilotNameTokensPresent` were counted as two signals. An exact name match
  // satisfies token containment BY CONSTRUCTION, so one identity dimension
  // promoted candidates to strong_multi_signal with no corroboration at all.
  const pilot = {
    sourcePropertyId: "p1",
    name: "Burj Test Hotel",
    address: "1 Sheikh Street",
    latitude: null,
    longitude: null,
    websiteUrl: "https://burjtest.example",
  };

  function record(over: Partial<ProviderRecordLike> = {}): ProviderRecordLike {
    return {
      id: "h1",
      name: "Burj Test Hotel",
      address: "somewhere else entirely",
      websiteUrl: null,
      phone: "+97141234567",
      chain: "TEST",
      latitude: 25.1,
      longitude: 55.2,
      ...over,
    };
  }

  it("A. an exact name match is ONE identity dimension", () => {
    const result = comparePilotAgainstProvider([pilot], [record()]);
    const candidate = result.findings[0]?.candidates[0];
    expect(candidate?.nameEvidence).toBe("exact");
    expect(candidate?.agreeingDimensions).toBe(1);
    expect(result.outcomes.plausible_single_signal).toBe(1);
    expect(result.outcomes.strong_multi_signal).toBe(0);
  });

  it("B. exact name + token containment is still ONE dimension, not two", () => {
    // Every significant pilot token is present in the identical name, so the old
    // implementation scored this pair twice off a single agreement.
    const result = comparePilotAgainstProvider([pilot], [record({ name: "Burj Test Hotel" })]);
    const candidate = result.findings[0]?.candidates[0];
    expect(candidate?.nameEvidence).toBe("exact");
    expect(candidate?.agreeingDimensions).toBe(1);
    expect(result.outcomes.strong_multi_signal).toBe(0);
  });

  it("C. exact name + same website domain IS multi-signal", () => {
    const result = comparePilotAgainstProvider(
      [pilot],
      [record({ websiteUrl: "https://www.burjtest.example/rooms?utm=x" })],
    );
    const candidate = result.findings[0]?.candidates[0];
    expect(candidate?.domain).toBe("agrees");
    expect(candidate?.agreeingDimensions).toBe(2);
    expect(result.outcomes.strong_multi_signal).toBe(1);
  });

  it("D. exact name + normalized address agreement IS multi-signal", () => {
    const result = comparePilotAgainstProvider(
      [pilot],
      [record({ address: "1  Sheikh   Street" })],
    );
    const candidate = result.findings[0]?.candidates[0];
    expect(candidate?.address).toBe("agrees");
    expect(candidate?.agreeingDimensions).toBe(2);
    expect(result.outcomes.strong_multi_signal).toBe(1);
  });

  it("E. several candidates stay ambiguous unless independent evidence separates them", () => {
    const result = comparePilotAgainstProvider(
      [pilot],
      [record({ id: "h1" }), record({ id: "h2" })],
    );
    expect(result.outcomes.ambiguous_multiple_candidates).toBe(1);
    expect(result.outcomes.strong_multi_signal).toBe(0);

    // Give exactly one of them a second INDEPENDENT dimension and it separates.
    const separated = comparePilotAgainstProvider(
      [pilot],
      [record({ id: "h1", websiteUrl: "https://burjtest.example" }), record({ id: "h2" })],
    );
    expect(separated.outcomes.strong_multi_signal).toBe(1);
    expect(separated.findings[0]?.candidates[0]?.providerId).toBe("h1");
  });

  it("reports an unusable dimension as unavailable, never as disagreement", () => {
    // The pilot supplies no phone column. "We could not compare" is not
    // evidence against a match, and scoring it as a non-match would make every
    // candidate look weaker than the evidence warrants.
    const result = comparePilotAgainstProvider([pilot], [record()]);
    expect(result.findings[0]?.candidates[0]?.phone).toBe("unavailable");
    expect(result.dimensionAvailability.phone).toContain("UNAVAILABLE");
    // Provider has no website here, so that dimension is unavailable too.
    expect(result.findings[0]?.candidates[0]?.domain).toBe("unavailable");
  });
});

describe("pilot comparison invents no threshold", () => {
  const pilot = [
    {
      sourcePropertyId: "p1",
      name: "Burj Test Hotel",
      address: null,
      latitude: null,
      longitude: null,
      websiteUrl: null,
    },
    {
      sourcePropertyId: "p2",
      name: "Totally Absent Property",
      address: null,
      latitude: null,
      longitude: null,
      websiteUrl: null,
    },
  ];

  function record(over: Partial<Parameters<typeof comparePilotAgainstProvider>[1][number]> = {}) {
    return {
      id: "h1",
      name: "Burj Test Hotel",
      address: "1 Street",
      websiteUrl: "https://burjtest.example",
      phone: "+97141234567",
      chain: "TEST",
      latitude: 25.1,
      longitude: 55.2,
      ...over,
    };
  }

  it("never calls provider coordinates an agreement when the pilot has none", () => {
    const result = comparePilotAgainstProvider(pilot, [record()]);
    expect(result.pilotEntriesWithCoordinates).toBe(0);
    expect(result.coordinateEnrichmentAvailable).toBe(1);
    expect(result.disclaimers.join(" ")).toContain("COORDINATE ENRICHMENT AVAILABLE");
  });

  it("reports ambiguity instead of picking a winner", () => {
    const result = comparePilotAgainstProvider(
      [pilot[0]!],
      [record({ id: "h1" }), record({ id: "h2" })],
    );
    // Two identical-looking candidates. Choosing one would require a threshold
    // we have no basis to invent, so the honest output is "ambiguous".
    expect(result.outcomes.ambiguous_multiple_candidates).toBe(1);
    expect(result.outcomes.strong_multi_signal).toBe(0);
  });

  it("says NO TEXTUAL EVIDENCE, which is not the same as absent from the provider", () => {
    const result = comparePilotAgainstProvider([pilot[1]!], [record()]);
    expect(result.outcomes.no_textual_evidence).toBe(1);
    expect(result.disclaimers.join(" ")).toContain("NOT that the provider lacks the property");
  });
});
