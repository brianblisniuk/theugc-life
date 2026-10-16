/**
 * Hunter is mocked. These tests never call api.hunter.io.
 * The fake provider remains the default for local and CI.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CONTACT_LOOKUP_UNAVAILABLE } from "@/lib/credits/config";
import {
  HUNTER_ORIGIN,
  HUNTER_SEARCH_BUDGET,
  chooseHotelEmail,
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
    expect(watched.ops).toEqual(["search:reserve"]);
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
      const domain = new URL(url).searchParams.get("domain") ?? "hotel.test";
      return {
        status: 200,
        body: domainBody([
          {
            value: `ada@${domain}`,
            type: "personal",
            confidence: 70,
            verification: { status: "valid" },
          },
        ]),
      };
    });
    const store = memoryLookupStore();
    for (let i = 0; i < HUNTER_SEARCH_BUDGET; i += 1) {
      const result = await findWithHunter(lookup({ domain: `hotel-${i}.test` }), {
        env: env(),
        store,
        fetchImpl: http.fetchImpl,
      });
      expect(result.status).toBe("found");
    }
    const blocked = await findWithHunter(lookup({ domain: "hotel-extra.test" }), {
      env: env(),
      store,
      fetchImpl: http.fetchImpl,
    });
    expect(blocked).toEqual({ status: "unavailable", email: null });
    expect(http.calls).toHaveLength(HUNTER_SEARCH_BUDGET);
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
    expect(watched.ops).toEqual(["search:reserve", "verification:reserve"]);
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
    expect(ready.status).toBe("found");
    expect(watched.ops).toContain("verification:exhaust");
    expect(watched.ops.filter((op) => op === "search:reserve")).toHaveLength(3);
    expect(http.calls.filter((call) => call.url.includes("email-verifier"))).toHaveLength(1);
    expect(unlockFollowUp(failed).kind).toBe("stop");
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
