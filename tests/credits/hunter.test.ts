/**
 * Hunter is mocked. These tests never call api.hunter.io.
 * The fake provider remains the default for local and CI.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CONTACT_LOOKUP_UNAVAILABLE } from "@/lib/credits/config";
import {
  HUNTER_DOMAIN_SEARCH_VERIFICATION_HEADROOM,
  HUNTER_ORIGIN,
  HUNTER_SEARCH_BUDGET,
  HUNTER_VERIFICATION_BUDGET,
  chooseHotelEmail,
  domainSearchVerificationCount,
  findWithHunter,
  lookupCacheKey,
  memoryLookupStore,
  normalizeLookupDomain,
  parseDomainSearch,
  type HunterCandidate,
  type HunterEnv,
  type LookupStore,
  LOOKUP_PENDING_MS,
} from "@/lib/contacts/hunter-lookup";
import { readHunterEnv } from "@/lib/contacts/hunter.server";
import { contactProviderName, getContactProvider, unlockFollowUp } from "@/lib/contacts/provider";
import type { ContactLookup } from "@/lib/contacts/types";

const HOTEL = "22222222-2222-4222-8222-222222222222";
const KEY = "hunter-test-key";

function lookup(over: Partial<ContactLookup> = {}): ContactLookup {
  return {
    hotelId: HOTEL,
    name: "Casa Lucia",
    domain: "casa-lucia.test",
    ...over,
  };
}

function env(over: Partial<HunterEnv> = {}): HunterEnv {
  return { apiKey: KEY, disabled: false, ...over };
}

interface Call {
  url: string;
  key: string | null;
}

function mockFetch(handler: (url: string) => { status: number; body: unknown }): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    calls.push({ url, key: headers.get("x-api-key") });
    const response = handler(url);
    return Promise.resolve(
      new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetchImpl, calls };
}

function domainBody(emails: unknown[]): unknown {
  return { data: { domain: "casa-lucia.test", emails }, meta: { results: emails.length } };
}

function person(over: Partial<HunterCandidate> = {}): HunterCandidate {
  return {
    email: "ada@casa-lucia.test",
    confidence: 90,
    type: "personal",
    department: "marketing",
    position: "Partnerships Manager",
    verification: "valid",
    decisionMaker: true,
    ...over,
  };
}

function net(ops: readonly string[], bucket: "search" | "verification"): number {
  return (
    ops.filter((op) => op === `${bucket}:reserve`).length -
    ops.filter((op) => op === `${bucket}:release`).length
  );
}

function watching(store: LookupStore): { store: LookupStore; ops: string[] } {
  const ops: string[] = [];
  return {
    ops,
    store: {
      claim: (key) => store.claim(key),
      complete: (key, status, email, raw) => store.complete(key, status, email, raw),
      abandon: (key) => store.abandon(key),
      budget: async (bucket, op) => {
        ops.push(`${bucket}:${op}`);
        return store.budget(bucket, op);
      },
    },
  };
}

describe("Hunter contact lookup", () => {
  const previousProvider = process.env.CONTACT_PROVIDER;
  const previousKey = process.env.HUNTER_API_KEY;
  const previousDisabled = process.env.HUNTER_DISABLED;

  afterEach(() => {
    if (previousProvider === undefined) delete process.env.CONTACT_PROVIDER;
    else process.env.CONTACT_PROVIDER = previousProvider;
    if (previousKey === undefined) delete process.env.HUNTER_API_KEY;
    else process.env.HUNTER_API_KEY = previousKey;
    if (previousDisabled === undefined) delete process.env.HUNTER_DISABLED;
    else process.env.HUNTER_DISABLED = previousDisabled;
  });

  it("accepts fake and hunter, and refuses any other provider", () => {
    expect(contactProviderName(undefined)).toBe("fake");
    expect(contactProviderName(" hunter ")).toBe("hunter");
    expect(() => contactProviderName("apollo")).toThrow(/not approved/);
    expect(
      readHunterEnv({ NODE_ENV: "test", HUNTER_API_KEY: "short", HUNTER_DISABLED: "no" }),
    ).toEqual({
      apiKey: null,
      disabled: false,
    });
    expect(
      readHunterEnv({ NODE_ENV: "test", HUNTER_API_KEY: KEY, HUNTER_DISABLED: "true" }).disabled,
    ).toBe(true);
  });

  it("prefers a named marketing contact over a generic route and skips invalid", () => {
    const chosen = chooseHotelEmail([
      person({
        email: "desk@casa-lucia.test",
        type: "generic",
        department: null,
        position: null,
        decisionMaker: false,
        verification: "valid",
        confidence: 99,
      }),
      person({ email: "bad@casa-lucia.test", verification: "invalid", confidence: 100 }),
      person({ email: "ada@casa-lucia.test", verification: "valid", confidence: 40 }),
    ]);
    expect(chosen?.email).toBe("ada@casa-lucia.test");
    expect(normalizeLookupDomain("WWW.Casa-Lucia.test")).toBe("casa-lucia.test");
    expect(lookupCacheKey(lookup({ domain: "https://nope" }))).toBeNull();
  });

  it("ranks outreach roles, then guest relations, then generic routes, and penalizes the rest", () => {
    const marketing = person({
      email: "ada@casa-lucia.test",
      department: "marketing",
      position: "Marketing Manager",
      confidence: 10,
      decisionMaker: false,
    });
    const partnerships = person({
      email: "pia@casa-lucia.test",
      department: null,
      position: "Partnerships",
      confidence: 11,
    });
    const pr = person({
      email: "press@casa-lucia.test",
      department: "communication",
      position: "PR Manager",
      confidence: 12,
    });
    const social = person({
      email: "sam@casa-lucia.test",
      department: null,
      position: "Social Media Manager",
      confidence: 13,
    });
    const sales = person({
      email: "sal@casa-lucia.test",
      department: "sales",
      position: "Sales",
      confidence: 14,
    });
    const guest = person({
      email: "gia@casa-lucia.test",
      department: null,
      position: "Guest Relations Manager",
      confidence: 80,
    });
    const experience = person({
      email: "eve@casa-lucia.test",
      department: null,
      position: "Guest Experience",
      confidence: 70,
    });
    const info = person({
      email: "info@casa-lucia.test",
      type: "generic",
      department: null,
      position: null,
      confidence: 99,
      decisionMaker: false,
    });
    const desk = person({
      email: "desk@casa-lucia.test",
      type: "generic",
      department: null,
      position: null,
      confidence: 100,
      decisionMaker: false,
    });
    const director = person({
      email: "md@casa-lucia.test",
      department: "marketing",
      position: "Managing Director",
      confidence: 100,
      decisionMaker: true,
    });
    const gm = person({
      email: "gm@casa-lucia.test",
      department: null,
      position: "General Manager",
      confidence: 100,
      decisionMaker: true,
    });
    const gmShort = person({
      email: "boss@casa-lucia.test",
      department: "executive",
      position: "GM",
      confidence: 100,
    });
    const kitchen = person({
      email: "chef@casa-lucia.test",
      department: "kitchen",
      position: "Head Chef",
      confidence: 100,
    });
    const food = person({
      email: "fb@casa-lucia.test",
      department: null,
      position: "F&B Manager",
      confidence: 100,
    });
    const rooms = person({
      email: "hk@casa-lucia.test",
      department: null,
      position: "Housekeeping Supervisor",
      confidence: 100,
    });
    const plant = person({
      email: "eng@casa-lucia.test",
      department: "engineering",
      position: "Chief Engineer",
      confidence: 100,
    });

    const prefer = (winner: HunterCandidate, loser: HunterCandidate) => {
      expect(chooseHotelEmail([loser, winner])?.email).toBe(winner.email);
      expect(chooseHotelEmail([winner, loser])?.email).toBe(winner.email);
    };

    for (const outreach of [marketing, partnerships, pr, social, sales]) {
      prefer(outreach, guest);
      prefer(outreach, info);
      prefer(outreach, desk);
      prefer(outreach, director);
    }
    prefer(guest, experience);
    prefer(guest, info);
    prefer(experience, info);
    prefer(info, desk);
    prefer(info, director);
    prefer(info, gm);
    prefer(desk, gmShort);
    prefer(desk, kitchen);
    prefer(desk, food);
    prefer(desk, rooms);
    prefer(desk, plant);
    prefer(marketing, director);

    expect(
      chooseHotelEmail([
        person({
          email: "zoe@casa-lucia.test",
          department: "marketing",
          position: "Marketing Manager",
          confidence: 40,
        }),
        person({
          email: "ada@casa-lucia.test",
          department: "marketing",
          position: "Marketing Manager",
          confidence: 40,
        }),
      ])?.email,
    ).toBe("ada@casa-lucia.test");
    expect(
      chooseHotelEmail([
        person({
          email: "low@casa-lucia.test",
          department: "marketing",
          position: "Marketing Coordinator",
          confidence: 20,
        }),
        person({
          email: "high@casa-lucia.test",
          department: "sales",
          position: "Sales Manager",
          confidence: 70,
        }),
      ])?.email,
    ).toBe("high@casa-lucia.test");
    expect(
      chooseHotelEmail([
        person({ email: "bad@casa-lucia.test", verification: "invalid", confidence: 100 }),
        info,
      ])?.email,
    ).toBe("info@casa-lucia.test");
  });

  it("uses Domain Search for a website and does not call Hunter again for that domain", async () => {
    const http = mockFetch(() => ({
      status: 200,
      body: domainBody([
        {
          value: "ada@casa-lucia.test",
          type: "personal",
          confidence: 91,
          department: "marketing",
          position: "Partnerships",
          decision_maker: true,
          verification: { status: "valid" },
        },
      ]),
    }));
    const watched = watching(memoryLookupStore());
    const first = await findWithHunter(lookup(), {
      env: env(),
      store: watched.store,
      fetchImpl: http.fetchImpl,
    });
    const second = await findWithHunter(
      lookup({ hotelId: "33333333-3333-4333-8333-333333333333" }),
      {
        env: env(),
        store: watched.store,
        fetchImpl: http.fetchImpl,
      },
    );
    expect(first).toMatchObject({ status: "found", email: "ada@casa-lucia.test" });
    expect(second).toMatchObject({ status: "found", email: "ada@casa-lucia.test" });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.url).toBe(
      `${HUNTER_ORIGIN}/v2/domain-search?domain=casa-lucia.test&limit=10`,
    );
    expect(http.calls[0]!.url).not.toContain("api_key");
    expect(http.calls[0]!.url).not.toContain(KEY);
    expect(http.calls[0]!.key).toBe(KEY);
    expect(net(watched.ops, "search")).toBe(1);
    expect(net(watched.ops, "verification")).toBe(1);
    expect(domainSearchVerificationCount(domainBody([]))).toBe(0);
    expect(JSON.stringify(first)).not.toContain(KEY);
    if (first.status === "found") {
      expect(first.raw).not.toHaveProperty("value");
      expect(JSON.stringify(first.raw)).not.toContain("ada@");
    }
  });

  it("treats www and the bare domain as one lookup", async () => {
    const http = mockFetch(() => ({
      status: 200,
      body: domainBody([
        {
          value: "ada@casa-lucia.test",
          type: "personal",
          confidence: 80,
          verification: { status: "valid" },
        },
      ]),
    }));
    const store = memoryLookupStore();
    await findWithHunter(lookup({ domain: "www.casa-lucia.test" }), {
      env: env(),
      store,
      fetchImpl: http.fetchImpl,
    });
    await findWithHunter(lookup({ domain: "casa-lucia.test" }), {
      env: env(),
      store,
      fetchImpl: http.fetchImpl,
    });
    expect(http.calls).toHaveLength(1);
  });

  it("uses Email Finder only for a named person without a website", async () => {
    const http = mockFetch((url) => {
      if (url.includes("email-finder")) {
        return {
          status: 200,
          body: {
            data: {
              email: "ada@casa-lucia.test",
              score: 88,
              verification: { status: "valid" },
            },
          },
        };
      }
      return { status: 500, body: {} };
    });
    const found = await findWithHunter(
      lookup({ domain: null, firstName: "Ada", lastName: "Lovelace" }),
      { env: env(), store: memoryLookupStore(), fetchImpl: http.fetchImpl },
    );
    expect(found.status).toBe("found");
    expect(http.calls[0]!.url).toContain("/v2/email-finder?");
    expect(http.calls[0]!.url).not.toContain("api_key");
    const domainWins = mockFetch(() => ({
      status: 200,
      body: domainBody([
        {
          value: "desk@casa-lucia.test",
          type: "generic",
          confidence: 70,
          verification: { status: "valid" },
        },
      ]),
    }));
    await findWithHunter(lookup({ firstName: "Ada", lastName: "Lovelace" }), {
      env: env(),
      store: memoryLookupStore(),
      fetchImpl: domainWins.fetchImpl,
    });
    expect(domainWins.calls[0]!.url).toContain("/v2/domain-search?");
    const none = mockFetch(() => ({ status: 500, body: {} }));
    const missed = await findWithHunter(lookup({ domain: null }), {
      env: env(),
      store: memoryLookupStore(),
      fetchImpl: none.fetchImpl,
    });
    expect(missed.status).toBe("not_found");
    expect(none.calls).toHaveLength(0);
  });

  it("does not charge the search budget for an empty Domain Search", async () => {
    const http = mockFetch(() => ({ status: 200, body: domainBody([]) }));
    const watched = watching(memoryLookupStore());
    for (let i = 0; i < HUNTER_SEARCH_BUDGET + 5; i += 1) {
      const result = await findWithHunter(lookup({ domain: `empty-${i}.test` }), {
        env: env(),
        store: watched.store,
        fetchImpl: http.fetchImpl,
      });
      expect(result.status).toBe("not_found");
    }
    expect(http.calls).toHaveLength(HUNTER_SEARCH_BUDGET + 5);
    expect(watched.ops.filter((op) => op === "search:reserve")).toHaveLength(
      HUNTER_SEARCH_BUDGET + 5,
    );
    expect(watched.ops.filter((op) => op === "search:release")).toHaveLength(
      HUNTER_SEARCH_BUDGET + 5,
    );
  });

  it("fails closed at 50 counted searches and does not call Hunter again", async () => {
    const http = mockFetch((url) => {
      if (!url.includes("email-finder")) return { status: 500, body: {} };
      return {
        status: 200,
        body: {
          data: {
            email: "ada@hotel.test",
            score: 80,
            verification: { status: "valid" },
          },
        },
      };
    });
    const store = memoryLookupStore();
    for (let i = 0; i < HUNTER_SEARCH_BUDGET; i += 1) {
      const result = await findWithHunter(
        lookup({ domain: null, name: `Hotel ${i}`, firstName: "Ada", lastName: "Lovelace" }),
        { env: env(), store, fetchImpl: http.fetchImpl },
      );
      expect(result.status).toBe("found");
    }
    const blocked = await findWithHunter(
      lookup({ domain: null, name: "Hotel extra", firstName: "Ada", lastName: "Lovelace" }),
      { env: env(), store, fetchImpl: http.fetchImpl },
    );
    expect(blocked).toEqual({ status: "unavailable", email: null });
    expect(http.calls).toHaveLength(HUNTER_SEARCH_BUDGET);
    expect(http.calls.every((call) => call.url.includes("/v2/email-finder?"))).toBe(true);
    expect(unlockFollowUp(blocked)).toEqual({ kind: "stop", status: "unavailable" });
  });

  it("debits domain-search verifications and stops before the next search can pass 50", async () => {
    const http = mockFetch((url) => {
      const domain = new URL(url).searchParams.get("domain") ?? "hotel.test";
      return {
        status: 200,
        body: domainBody([
          {
            value: `ada@${domain}`,
            type: "personal",
            confidence: 70,
            department: "marketing",
            position: "Marketing Manager",
            verification: { status: "valid" },
          },
          {
            value: `gm@${domain}`,
            type: "personal",
            confidence: 99,
            position: "General Manager",
            verification: { status: "valid" },
          },
        ]),
      };
    });
    const watched = watching(memoryLookupStore());
    const first = await findWithHunter(lookup({ domain: "ranked.test" }), {
      env: env(),
      store: watched.store,
      fetchImpl: http.fetchImpl,
    });
    expect(first).toMatchObject({ status: "found", email: "ada@ranked.test" });
    expect(net(watched.ops, "verification")).toBe(2);
    expect(http.calls).toHaveLength(1);

    const store = memoryLookupStore();
    let accepted = 0;
    for (let i = 0; i < HUNTER_VERIFICATION_BUDGET; i += 1) {
      const result = await findWithHunter(lookup({ domain: `wall-${i}.test` }), {
        env: env(),
        store,
        fetchImpl: http.fetchImpl,
      });
      if (result.status !== "found") break;
      accepted += 1;
    }
    const callsAtWall = http.calls.length;
    const blocked = await findWithHunter(lookup({ domain: "wall-extra.test" }), {
      env: env(),
      store,
      fetchImpl: http.fetchImpl,
    });
    let used = 0;
    let expected = 0;
    while (used + HUNTER_DOMAIN_SEARCH_VERIFICATION_HEADROOM <= HUNTER_VERIFICATION_BUDGET) {
      used += 2;
      expected += 1;
    }
    expect(blocked.status).toBe("unavailable");
    expect(http.calls).toHaveLength(callsAtWall);
    expect(accepted).toBe(expected);
    expect(unlockFollowUp(blocked)).toEqual({ kind: "stop", status: "unavailable" });
  });

  it("stops before the network when the kill switch or the key is missing", async () => {
    const http = mockFetch(() => ({ status: 200, body: domainBody([]) }));
    const paused = await findWithHunter(lookup(), {
      env: env({ disabled: true }),
      store: memoryLookupStore(),
      fetchImpl: http.fetchImpl,
    });
    const missing = await findWithHunter(lookup(), {
      env: env({ apiKey: null }),
      store: memoryLookupStore(),
      fetchImpl: http.fetchImpl,
    });
    expect(paused.status).toBe("unavailable");
    expect(missing.status).toBe("unavailable");
    expect(http.calls).toHaveLength(0);
  });

  it("maps 401, 429, and a quota body to the Error state", async () => {
    const http = mockFetch((url) => {
      const domain = new URL(url).searchParams.get("domain");
      if (domain === "unauthorized.test")
        return { status: 401, body: { errors: [{ id: "unauthorized" }] } };
      if (domain === "limited.test")
        return { status: 429, body: { errors: [{ id: "too_many_requests" }] } };
      if (domain === "quota.test")
        return { status: 403, body: { errors: [{ id: "usage_limit" }] } };
      return {
        status: 200,
        body: domainBody([
          {
            value: "ada@later.test",
            type: "personal",
            confidence: 10,
            verification: { status: "valid" },
          },
        ]),
      };
    });
    const store = memoryLookupStore();
    const unauthorized = await findWithHunter(lookup({ domain: "unauthorized.test" }), {
      env: env(),
      store,
      fetchImpl: http.fetchImpl,
    });
    const limited = await findWithHunter(lookup({ domain: "limited.test" }), {
      env: env(),
      store,
      fetchImpl: http.fetchImpl,
    });
    const afterLimit = await findWithHunter(lookup({ domain: "later.test" }), {
      env: env(),
      store,
      fetchImpl: http.fetchImpl,
    });
    expect(unauthorized.status).toBe("error");
    expect(limited.status).toBe("error");
    expect(afterLimit.status).toBe("unavailable");
    expect(http.calls.map((call) => new URL(call.url).searchParams.get("domain"))).toEqual([
      "unauthorized.test",
      "limited.test",
    ]);
    expect(unlockFollowUp(unauthorized)).toEqual({ kind: "stop", status: "error" });

    const quota = mockFetch(() => ({
      status: 400,
      body: { errors: [{ id: "insufficient_credits" }] },
    }));
    const quotaResult = await findWithHunter(lookup({ domain: "quota.test" }), {
      env: env(),
      store: memoryLookupStore(),
      fetchImpl: quota.fetchImpl,
    });
    expect(quotaResult.status).toBe("error");
  });

  it("treats a short rate limit as an error and does not exhaust the month", async () => {
    const http = mockFetch((url) => {
      const domain = new URL(url).searchParams.get("domain");
      if (domain === "slow.test") return { status: 403, body: { errors: [{ id: "rate_limit" }] } };
      return {
        status: 200,
        body: domainBody([
          {
            value: "ada@next.test",
            type: "personal",
            confidence: 10,
            verification: { status: "valid" },
          },
        ]),
      };
    });
    const store = memoryLookupStore();
    const limited = await findWithHunter(lookup({ domain: "slow.test" }), {
      env: env(),
      store,
      fetchImpl: http.fetchImpl,
    });
    const next = await findWithHunter(lookup({ domain: "next.test" }), {
      env: env(),
      store,
      fetchImpl: http.fetchImpl,
    });
    expect(limited.status).toBe("error");
    expect(next.status).toBe("found");
  });

  it("verifies only when Domain Search did not already mark the address usable", async () => {
    const http = mockFetch((url) => {
      if (url.includes("email-verifier")) {
        return { status: 200, body: { data: { status: "valid", email: "ada@casa-lucia.test" } } };
      }
      return {
        status: 200,
        body: domainBody([
          {
            value: "ada@casa-lucia.test",
            type: "personal",
            confidence: 70,
            department: "marketing",
            verification: { status: "unknown" },
          },
        ]),
      };
    });
    const watched = watching(memoryLookupStore());
    const found = await findWithHunter(lookup(), {
      env: env(),
      store: watched.store,
      fetchImpl: http.fetchImpl,
      delay: () => Promise.resolve(),
    });
    expect(found).toMatchObject({ status: "found", email: "ada@casa-lucia.test" });
    expect(http.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/v2/domain-search",
      "/v2/email-verifier",
    ]);
    expect(net(watched.ops, "search")).toBe(1);
    expect(net(watched.ops, "verification")).toBe(2);
    const again = await findWithHunter(
      lookup({ hotelId: "33333333-3333-4333-8333-333333333333" }),
      {
        env: env(),
        store: watched.store,
        fetchImpl: http.fetchImpl,
      },
    );
    expect(again.status).toBe("found");
    expect(http.calls).toHaveLength(2);
  });

  it("keeps a verifier failure off the search budget and off the contact cache", async () => {
    const http = mockFetch((url) => {
      if (url.includes("email-verifier"))
        return { status: 429, body: { errors: [{ id: "too_many_requests" }] } };
      if (url.includes("email-finder")) {
        return {
          status: 200,
          body: {
            data: { email: "ada@ready-hotel.test", score: 80, verification: { status: "valid" } },
          },
        };
      }
      const domain = new URL(url).searchParams.get("domain");
      if (domain === "ready.test") {
        return {
          status: 200,
          body: domainBody([
            {
              value: "ada@ready.test",
              type: "personal",
              confidence: 70,
              verification: { status: "valid" },
            },
          ]),
        };
      }
      return {
        status: 200,
        body: domainBody([{ value: "ada@casa-lucia.test", type: "personal", confidence: 70 }]),
      };
    });
    const watched = watching(memoryLookupStore());
    const failed = await findWithHunter(lookup(), {
      env: env(),
      store: watched.store,
      fetchImpl: http.fetchImpl,
    });
    const other = await findWithHunter(lookup({ domain: "other.test" }), {
      env: env(),
      store: watched.store,
      fetchImpl: http.fetchImpl,
    });
    const ready = await findWithHunter(lookup({ domain: "ready.test" }), {
      env: env(),
      store: watched.store,
      fetchImpl: http.fetchImpl,
    });
    expect(failed.status).toBe("error");
    expect(other.status).toBe("unavailable");
    expect(ready.status).toBe("unavailable");
    expect(watched.ops).toContain("verification:exhaust");
    expect(net(watched.ops, "search")).toBe(1);
    expect(http.calls.filter((call) => call.url.includes("email-verifier"))).toHaveLength(1);
    expect(http.calls.filter((call) => call.url.includes("ready.test"))).toHaveLength(0);
    expect(unlockFollowUp(failed)).toEqual({ kind: "stop", status: "error" });
    const finder = await findWithHunter(
      lookup({ domain: null, name: "Ready Hotel", firstName: "Ada", lastName: "Lovelace" }),
      { env: env(), store: watched.store, fetchImpl: http.fetchImpl },
    );
    expect(finder).toMatchObject({ status: "found", email: "ada@ready-hotel.test" });
    expect(http.calls.some((call) => call.url.includes("email-finder"))).toBe(true);
  });

  it("does not call Hunter while another claim for that domain is in flight", async () => {
    const http = mockFetch(() => ({ status: 500, body: {} }));
    let clock = 0;
    const store = memoryLookupStore(() => clock);
    await store.claim("domain:casa-lucia.test");
    const blocked = await findWithHunter(lookup(), {
      env: env(),
      store,
      fetchImpl: http.fetchImpl,
    });
    expect(blocked.status).toBe("unavailable");
    expect(http.calls).toHaveLength(0);
    clock = LOOKUP_PENDING_MS + 1;
    const http2 = mockFetch(() => ({
      status: 200,
      body: domainBody([
        {
          value: "ada@casa-lucia.test",
          type: "personal",
          confidence: 10,
          verification: { status: "valid" },
        },
      ]),
    }));
    const found = await findWithHunter(lookup(), { env: env(), store, fetchImpl: http2.fetchImpl });
    expect(found.status).toBe("found");
    expect(http2.calls).toHaveLength(1);
  });

  it("finishes a verifier 451 as a miss with no address and does not ask again", async () => {
    const address = "ada@claimed.test";
    const http = mockFetch((url) => {
      if (url.includes("email-verifier"))
        return { status: 451, body: { errors: [{ id: "claimed_email" }] } };
      return {
        status: 200,
        body: domainBody([{ value: address, type: "personal", confidence: 70 }]),
      };
    });
    const store = memoryLookupStore();
    const missed = await findWithHunter(lookup({ domain: "claimed.test" }), {
      env: env(),
      store,
      fetchImpl: http.fetchImpl,
    });
    expect(missed.status).toBe("not_found");
    expect(missed.email).toBeNull();
    expect(JSON.stringify(missed)).not.toContain(address);
    expect(unlockFollowUp(missed)).toMatchObject({
      kind: "cache",
      status: "not_found",
      email: null,
    });
    const stored = await store.claim("domain:claimed.test");
    expect(stored).toMatchObject({ outcome: "hit", status: "not_found", email: null });
    expect(JSON.stringify(stored)).not.toContain(address);
    const again = await findWithHunter(lookup({ domain: "claimed.test" }), {
      env: env(),
      store,
      fetchImpl: http.fetchImpl,
    });
    expect(again.status).toBe("not_found");
    expect(http.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/v2/domain-search",
      "/v2/email-verifier",
    ]);
  });

  it("keeps invalid as an uncharged miss and does not cache unknown, webmail, or disposable off the hotel domain", async () => {
    const cases = [
      { status: "invalid", domain: "invalid.test", email: "ada@invalid.test", follow: "cache" },
      { status: "unknown", domain: "unknown.test", email: "ada@unknown.test", follow: "stop" },
      { status: "webmail", domain: "webmail.test", email: "ada@gmail.com", follow: "stop" },
      { status: "disposable", domain: "burner.test", email: "ada@mailinator.com", follow: "stop" },
      { status: "webmail", domain: "on-domain.test", email: "ada@on-domain.test", follow: "found" },
      {
        status: "disposable",
        domain: "temp-hotel.test",
        email: "ada@temp-hotel.test",
        follow: "found",
      },
    ] as const;
    for (const item of cases) {
      const http = mockFetch((url) => {
        if (url.includes("email-verifier")) {
          return { status: 200, body: { data: { status: item.status, email: item.email } } };
        }
        return {
          status: 200,
          body: domainBody([{ value: item.email, type: "personal", confidence: 60 }]),
        };
      });
      const store = memoryLookupStore();
      const result = await findWithHunter(lookup({ domain: item.domain }), {
        env: env(),
        store,
        fetchImpl: http.fetchImpl,
        delay: () => Promise.resolve(),
      });
      const before = http.calls.length;
      const again = await findWithHunter(lookup({ domain: item.domain }), {
        env: env(),
        store,
        fetchImpl: http.fetchImpl,
      });
      if (item.follow === "found") {
        expect(result).toMatchObject({ status: "found", email: item.email });
        expect(unlockFollowUp(result)).toMatchObject({ kind: "cache", status: "found" });
        expect(again.status).toBe("found");
        expect(http.calls).toHaveLength(before);
      } else if (item.follow === "cache") {
        expect(result.status).toBe("not_found");
        expect(JSON.stringify(result)).not.toContain(item.email);
        expect(unlockFollowUp(result)).toMatchObject({
          kind: "cache",
          status: "not_found",
          email: null,
        });
        expect(again.status).toBe("not_found");
        expect(http.calls).toHaveLength(before);
      } else {
        expect(result).toEqual({ status: "error", email: null });
        expect(unlockFollowUp(result)).toEqual({ kind: "stop", status: "error" });
        expect(again).toEqual({ status: "error", email: null });
        if (item.status === "unknown") {
          expect(http.calls.map((call) => new URL(call.url).pathname)).toEqual([
            "/v2/domain-search",
            "/v2/email-verifier",
            "/v2/email-verifier",
          ]);
        } else {
          expect(http.calls).toHaveLength(before);
          const stored = await store.claim(`domain:${item.domain}`);
          expect(JSON.stringify(result)).not.toContain(item.email);
          expect(stored).toMatchObject({ outcome: "hit", status: "unverified" });
          if (stored.outcome === "hit")
            expect(JSON.stringify(stored.raw)).not.toContain(item.email);
        }
      }
    }
  });

  it("treats a quota-like 403 the same on search and on the verifier", async () => {
    const search = mockFetch((url) => {
      const domain = new URL(url).searchParams.get("domain");
      if (domain === "usage.test")
        return { status: 403, body: { errors: [{ id: "usage_limit" }] } };
      return {
        status: 200,
        body: domainBody([
          {
            value: "ada@later-usage.test",
            type: "personal",
            confidence: 10,
            verification: { status: "valid" },
          },
        ]),
      };
    });
    const searchStore = memoryLookupStore();
    const usage = await findWithHunter(lookup({ domain: "usage.test" }), {
      env: env(),
      store: searchStore,
      fetchImpl: search.fetchImpl,
    });
    const afterUsage = await findWithHunter(lookup({ domain: "later-usage.test" }), {
      env: env(),
      store: searchStore,
      fetchImpl: search.fetchImpl,
    });
    expect(usage.status).toBe("error");
    expect(afterUsage.status).toBe("unavailable");
    expect(search.calls).toHaveLength(1);

    const verifier = mockFetch((url) => {
      if (url.includes("email-verifier"))
        return { status: 403, body: { errors: [{ id: "usage_limit" }] } };
      return {
        status: 200,
        body: domainBody([{ value: "ada@verify-usage.test", type: "personal", confidence: 10 }]),
      };
    });
    const verifierStore = memoryLookupStore();
    const failed = await findWithHunter(lookup({ domain: "verify-usage.test" }), {
      env: env(),
      store: verifierStore,
      fetchImpl: verifier.fetchImpl,
    });
    const blocked = await findWithHunter(lookup({ domain: "verify-next.test" }), {
      env: env(),
      store: verifierStore,
      fetchImpl: verifier.fetchImpl,
    });
    expect(failed.status).toBe("error");
    expect(blocked.status).toBe("unavailable");
    expect(verifier.calls.filter((call) => call.url.includes("verify-next.test"))).toHaveLength(0);
    expect(unlockFollowUp(failed)).toEqual({ kind: "stop", status: "error" });
  });

  it("releases a timed-out or malformed search and does not leave the domain pending", async () => {
    const slow: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    const store = memoryLookupStore();
    const watched = watching(store);
    const timedOut = await findWithHunter(lookup({ domain: "slow-body.test" }), {
      env: env(),
      store: watched.store,
      fetchImpl: slow,
      timeoutMs: 20,
    });
    expect(timedOut).toEqual({ status: "error", email: null });
    expect(net(watched.ops, "search")).toBe(0);
    expect(net(watched.ops, "verification")).toBe(0);
    const http = mockFetch(() => ({
      status: 200,
      body: domainBody([
        {
          value: "ada@slow-body.test",
          type: "personal",
          confidence: 20,
          verification: { status: "valid" },
        },
      ]),
    }));
    const recovered = await findWithHunter(lookup({ domain: "slow-body.test" }), {
      env: env(),
      store,
      fetchImpl: http.fetchImpl,
    });
    expect(recovered.status).toBe("found");

    const malformed = mockFetch((url) => {
      if (url.includes("email-finder")) return { status: 200, body: { unexpected: true } };
      return { status: 200, body: { data: { domain: "bad.test" } } };
    });
    const badStore = memoryLookupStore();
    const badWatched = watching(badStore);
    const broken = await findWithHunter(lookup({ domain: "bad.test" }), {
      env: env(),
      store: badWatched.store,
      fetchImpl: malformed.fetchImpl,
    });
    expect(broken).toEqual({ status: "error", email: null });
    expect(net(badWatched.ops, "search")).toBe(0);
    expect(net(badWatched.ops, "verification")).toBe(0);
    const finderBroken = await findWithHunter(
      lookup({ domain: null, name: "Bad Hotel", firstName: "Ada", lastName: "Lovelace" }),
      { env: env(), store: badWatched.store, fetchImpl: malformed.fetchImpl },
    );
    expect(finderBroken).toEqual({ status: "error", email: null });
    const domainAgain = mockFetch(() => ({
      status: 200,
      body: domainBody([
        {
          value: "ada@bad.test",
          type: "personal",
          confidence: 20,
          verification: { status: "valid" },
        },
      ]),
    }));
    const domainFound = await findWithHunter(lookup({ domain: "bad.test" }), {
      env: env(),
      store: badStore,
      fetchImpl: domainAgain.fetchImpl,
    });
    expect(domainFound.status).toBe("found");
    const later = mockFetch(() => ({
      status: 200,
      body: {
        data: { email: "ada@bad-hotel.test", score: 50, verification: { status: "valid" } },
      },
    }));
    const found = await findWithHunter(
      lookup({ domain: null, name: "Bad Hotel", firstName: "Ada", lastName: "Lovelace" }),
      { env: env(), store: badStore, fetchImpl: later.fetchImpl },
    );
    expect(found.status).toBe("found");
  });

  it("abandons the claim when the budget call throws and does not keep the credit", async () => {
    const inner = memoryLookupStore();
    let throwBudget = true;
    const ops: string[] = [];
    const store: LookupStore = {
      claim: (key) => inner.claim(key),
      complete: (key, status, email, raw) => inner.complete(key, status, email, raw),
      abandon: (key) => inner.abandon(key),
      budget: (bucket, op) => {
        ops.push(`${bucket}:${op}`);
        if (throwBudget && bucket === "verification")
          return Promise.reject(new Error("budget down"));
        return inner.budget(bucket, op);
      },
    };
    const http = mockFetch(() => ({ status: 500, body: {} }));
    const failed = await findWithHunter(lookup({ domain: "thrown.test" }), {
      env: env(),
      store,
      fetchImpl: http.fetchImpl,
    });
    expect(failed).toEqual({ status: "error", email: null });
    expect(http.calls).toHaveLength(0);
    expect(ops).toContain("search:reserve");
    expect(ops).toContain("search:release");
    throwBudget = false;
    const ok = mockFetch(() => ({
      status: 200,
      body: domainBody([
        {
          value: "ada@thrown.test",
          type: "personal",
          confidence: 15,
          verification: { status: "valid" },
        },
      ]),
    }));
    const found = await findWithHunter(lookup({ domain: "thrown.test" }), {
      env: env(),
      store,
      fetchImpl: ok.fetchImpl,
    });
    expect(found.status).toBe("found");
    expect(ok.calls).toHaveLength(1);
  });

  it("exhausts verifications when Domain Search reports fewer than the headroom remaining", async () => {
    const http = mockFetch((url) => {
      const domain = new URL(url).searchParams.get("domain");
      if (domain === "low-quota.test") {
        return {
          status: 200,
          body: {
            data: {
              domain,
              emails: [
                {
                  value: "ada@low-quota.test",
                  type: "personal",
                  confidence: 80,
                  department: "marketing",
                  verification: { status: "valid" },
                },
              ],
              requests: { verifications: { available: 3 } },
            },
          },
        };
      }
      return {
        status: 200,
        body: domainBody([
          {
            value: "ada@next-quota.test",
            type: "personal",
            confidence: 80,
            verification: { status: "valid" },
          },
        ]),
      };
    });
    const store = memoryLookupStore();
    const found = await findWithHunter(lookup({ domain: "low-quota.test" }), {
      env: env(),
      store,
      fetchImpl: http.fetchImpl,
    });
    const blocked = await findWithHunter(lookup({ domain: "next-quota.test" }), {
      env: env(),
      store,
      fetchImpl: http.fetchImpl,
    });
    expect(found).toMatchObject({ status: "found", email: "ada@low-quota.test" });
    expect(blocked.status).toBe("unavailable");
    expect(http.calls).toHaveLength(1);
  });

  it("refuses the real network from the test default fetch", async () => {
    const original = globalThis.fetch;
    let called = false;
    globalThis.fetch = () => {
      called = true;
      return Promise.reject(new Error("real network"));
    };
    try {
      const result = await findWithHunter(lookup(), { env: env(), store: memoryLookupStore() });
      expect(result.status).toBe("error");
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does not let the default provider call the network", async () => {
    const original = globalThis.fetch;
    let called = false;
    globalThis.fetch = () => {
      called = true;
      return Promise.reject(new Error("real network"));
    };
    try {
      delete process.env.CONTACT_PROVIDER;
      const fake = getContactProvider();
      await expect(fake.findHotelEmail(lookup())).resolves.toMatchObject({ status: "found" });
      process.env.CONTACT_PROVIDER = "hunter";
      process.env.HUNTER_API_KEY = KEY;
      const hunter = getContactProvider();
      await expect(hunter.findHotelEmail(lookup())).resolves.toMatchObject({ status: "error" });
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("keeps the Hunter key and the Hunter host out of client components", () => {
    const root = path.join(process.cwd(), "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) files.push(full);
      }
    };
    walk(root);
    const clientLeaks = files.filter((file) => {
      const source = readFileSync(file, "utf8");
      return source.includes('"use client"') && /HUNTER_API_KEY|api\.hunter\.io/.test(source);
    });
    expect(clientLeaks).toEqual([]);
    const action = readFileSync(path.join(root, "lib/credits/actions.ts"), "utf8");
    expect(action).toContain("unlockFollowUp");
    expect(action).not.toContain("firstName");
    expect(action).not.toContain("HUNTER_API_KEY");
    expect(action).not.toContain("api.hunter.io");
    const screen = readFileSync(path.join(root, "components/contacts/unlock-contact.tsx"), "utf8");
    expect(screen).toContain("CONTACT_LOOKUP_UNAVAILABLE");
    expect(CONTACT_LOOKUP_UNAVAILABLE).toBe("Contact lookup temporarily unavailable");
    expect(parseDomainSearch({ data: { emails: [] } })).toEqual([]);
    expect(parseDomainSearch({ data: {} })).toBeNull();
  });
});
