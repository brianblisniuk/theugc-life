/**
 * Hunter lookup (D180).
 *
 * Official API, retrieved 2026-10-16: https://hunter.io/api-documentation/v2
 *
 * - Domain Search: GET /v2/domain-search. A query is counted when it returns
 *   at least one result. Free-plan pagination stops at 10, so this call asks
 *   for limit=10 and does not page.
 * - Email Finder: GET /v2/email-finder. It needs a person's name. No email
 *   means no search credit.
 * - Email Verifier: GET /v2/email-verifier. Verifications are a separate
 *   quota. A 202 is still in progress and counts once, so the polls share
 *   one reservation.
 * - The key is sent as X-API-KEY. It is never a query parameter.
 * - 401 means the key was rejected. 429 means the usage limit. 403 is the
 *   short rate limit, not the monthly bucket.
 *
 * The hotel unlock path has a website domain and no person, so it uses
 * Domain Search only. Email Finder runs only for a named person when that
 * hotel has no website domain. The same cache key never calls Hunter twice.
 */

import type { ContactLookup, ContactLookupResult, ContactProviderRaw } from "./types";

export const HUNTER_ORIGIN = "https://api.hunter.io";
export const HUNTER_SEARCH_BUDGET = 50;
export const HUNTER_VERIFICATION_BUDGET = 50;
export const LOOKUP_PENDING_MS = 2 * 60 * 1000;
const LIMIT = "10";

export interface HunterEnv {
  apiKey: string | null;
  disabled: boolean;
}

export type LookupStatus = "pending" | "found" | "not_found" | "unverified";

export interface LookupHit {
  outcome: "hit";
  status: "found" | "not_found" | "unverified";
  email: string | null;
  raw: ContactProviderRaw | null;
}

export type ClaimResult = LookupHit | { outcome: "pending" } | { outcome: "claimed" };

export type BudgetResult =
  | { outcome: "reserved"; used: number }
  | { outcome: "exhausted"; used: number }
  | { outcome: "ok"; used: number };

export interface LookupStore {
  claim(cacheKey: string): Promise<ClaimResult>;
  complete(
    cacheKey: string,
    status: "found" | "not_found" | "unverified",
    email: string | null,
    raw: ContactProviderRaw,
  ): Promise<void>;
  abandon(cacheKey: string): Promise<void>;
  budget(
    bucket: "search" | "verification",
    op: "reserve" | "release" | "exhaust",
  ): Promise<BudgetResult>;
}

interface MemoryRow {
  status: LookupStatus;
  email: string | null;
  raw: ContactProviderRaw | null;
  updatedAt: number;
}

interface MemoryMonth {
  searches: number;
  verifications: number;
  searchesExhausted: boolean;
  verificationsExhausted: boolean;
}

export function memoryLookupStore(now: () => number = Date.now): LookupStore {
  const rows = new Map<string, MemoryRow>();
  const months = new Map<string, MemoryMonth>();

  function month(): MemoryMonth {
    const key = new Date(now()).toISOString().slice(0, 7);
    const existing = months.get(key);
    if (existing) return existing;
    const created: MemoryMonth = {
      searches: 0,
      verifications: 0,
      searchesExhausted: false,
      verificationsExhausted: false,
    };
    months.set(key, created);
    return created;
  }

  return {
    claim(cacheKey) {
      const row = rows.get(cacheKey);
      if (
        row &&
        (row.status === "found" || row.status === "not_found" || row.status === "unverified")
      ) {
        return Promise.resolve({
          outcome: "hit",
          status: row.status,
          email: row.email,
          raw: row.raw,
        });
      }
      if (row?.status === "pending" && now() - row.updatedAt < LOOKUP_PENDING_MS) {
        return Promise.resolve({ outcome: "pending" });
      }
      rows.set(cacheKey, { status: "pending", email: null, raw: null, updatedAt: now() });
      return Promise.resolve({ outcome: "claimed" });
    },
    complete(cacheKey, status, email, raw) {
      const row = rows.get(cacheKey);
      if (!row || (row.status !== "pending" && row.status !== "unverified"))
        return Promise.resolve();
      rows.set(cacheKey, {
        status,
        email: status === "not_found" ? null : email,
        raw,
        updatedAt: now(),
      });
      return Promise.resolve();
    },
    abandon(cacheKey) {
      const row = rows.get(cacheKey);
      if (row?.status === "pending") rows.delete(cacheKey);
      return Promise.resolve();
    },
    budget(bucket, op) {
      const row = month();
      const search = bucket === "search";
      const used = search ? row.searches : row.verifications;
      const exhausted = search ? row.searchesExhausted : row.verificationsExhausted;
      if (op === "exhaust") {
        if (search) row.searchesExhausted = true;
        else row.verificationsExhausted = true;
        return Promise.resolve({ outcome: "ok", used });
      }
      if (op === "release") {
        if (used > 0 && !exhausted) {
          if (search) row.searches -= 1;
          else row.verifications -= 1;
        }
        return Promise.resolve({ outcome: "ok", used: search ? row.searches : row.verifications });
      }
      const cap = search ? HUNTER_SEARCH_BUDGET : HUNTER_VERIFICATION_BUDGET;
      if (exhausted || used >= cap) return Promise.resolve({ outcome: "exhausted", used });
      if (search) row.searches += 1;
      else row.verifications += 1;
      return Promise.resolve({ outcome: "reserved", used: used + 1 });
    },
  };
}

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const ROLE_DEPARTMENTS = new Set([
  "marketing",
  "communication",
  "executive",
  "management",
  "sales",
]);
const ROLE_POSITION =
  /\b(partnerships?|marketing|press|pr|media|social|communications?|management)\b/i;
const GENERIC_LOCALS = new Set([
  "partnerships",
  "partnership",
  "marketing",
  "press",
  "pr",
  "media",
  "social",
  "collaborations",
  "collab",
  "hello",
  "contact",
  "info",
  "reservations",
]);

export interface HunterCandidate {
  email: string;
  confidence: number;
  type: "personal" | "generic";
  department: string | null;
  position: string | null;
  verification: "valid" | "accept_all" | "unknown" | "invalid" | null;
  decisionMaker: boolean;
}

export function cleanEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > 320 || !EMAIL.test(email)) return null;
  return email;
}

function shortText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0 || text.length > 80) return null;
  return text;
}

function verificationOf(value: unknown): HunterCandidate["verification"] {
  if (value === "valid" || value === "accept_all" || value === "unknown" || value === "invalid") {
    return value;
  }
  return null;
}

function confidenceOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function rankScore(candidate: HunterCandidate): number {
  const local = candidate.email.split("@")[0] ?? "";
  let score = candidate.confidence;
  if (candidate.decisionMaker) score += 1000;
  if (candidate.type === "personal") score += 400;
  if (candidate.department && ROLE_DEPARTMENTS.has(candidate.department)) score += 250;
  if (candidate.position && ROLE_POSITION.test(candidate.position)) score += 250;
  if (candidate.type === "generic" && GENERIC_LOCALS.has(local)) score += 120;
  if (candidate.verification === "valid") score += 80;
  if (candidate.verification === "accept_all") score += 30;
  return score;
}

/** Best named role, then a generic route. An invalid verification is skipped. */
export function chooseHotelEmail(candidates: readonly HunterCandidate[]): HunterCandidate | null {
  const usable = candidates.filter((candidate) => candidate.verification !== "invalid");
  usable.sort((a, b) => {
    const delta = rankScore(b) - rankScore(a);
    if (delta !== 0) return delta;
    return a.email < b.email ? -1 : a.email > b.email ? 1 : 0;
  });
  return usable[0] ?? null;
}

export function normalizeLookupDomain(domain: string | null | undefined): string | null {
  if (!domain) return null;
  let host = domain.trim().toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);
  if (host.length === 0 || host.length > 253 || !host.includes(".")) return null;
  if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".")) return null;
  return host;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function lookupCacheKey(
  input: ContactLookup,
): { key: string; kind: "domain" | "person" } | null {
  const domain = normalizeLookupDomain(input.domain);
  if (domain) return { key: `domain:${domain}`, kind: "domain" };
  const first = slug(input.firstName ?? "");
  const last = slug(input.lastName ?? "");
  const company = slug(input.name);
  if (first.length === 0 || last.length === 0 || company.length === 0) return null;
  const key = `person:${company}:${first}:${last}`;
  if (!/^[a-z0-9:.-]{3,300}$/.test(key)) return null;
  return { key, kind: "person" };
}

function unavailable(): ContactLookupResult {
  return { status: "unavailable", email: null };
}

function errorResult(): ContactLookupResult {
  return { status: "error", email: null };
}

function rawFor(
  operation: ContactProviderRaw["operation"],
  domain: string | null,
  status: "found" | "not_found",
  candidate: HunterCandidate | null,
  verification: string | null,
): ContactProviderRaw {
  return {
    provider: "hunter",
    status,
    operation,
    domain,
    confidence: candidate?.confidence ?? null,
    department: candidate?.department ?? null,
    position: candidate?.position ?? null,
    verification,
    decisionMaker: candidate?.decisionMaker ?? null,
  };
}

function notFound(
  operation: ContactProviderRaw["operation"],
  domain: string | null,
): { status: "not_found"; email: null; raw: ContactProviderRaw } {
  return {
    status: "not_found",
    email: null,
    raw: rawFor(operation, domain, "not_found", null, null),
  };
}

interface HunterResponse {
  status: number;
  body: unknown;
}

async function hunterGet(
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<HunterResponse | "timeout"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "X-API-KEY": apiKey,
      },
    });
    if (response.status >= 300 && response.status < 400)
      return { status: response.status, body: null };
    const text = await response.text();
    if (text.length === 0) return { status: response.status, body: null };
    try {
      return { status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      return { status: response.status, body: null };
    }
  } catch {
    return "timeout";
  } finally {
    clearTimeout(timer);
  }
}

function errorId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const first = errors[0];
  if (!first || typeof first !== "object") return null;
  const id = (first as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

function isQuota(status: number, body: unknown): boolean {
  if (status === 429) return true;
  const id = errorId(body);
  return id !== null && /quota|usage|too_many|insufficient_credits/i.test(id);
}

function candidateFromRecord(record: Record<string, unknown>, email: string): HunterCandidate {
  const verificationRecord = record.verification;
  const verification =
    verificationRecord && typeof verificationRecord === "object"
      ? verificationOf((verificationRecord as { status?: unknown }).status)
      : null;
  const type = record.type === "personal" ? "personal" : "generic";
  return {
    email,
    confidence: confidenceOf(record.confidence ?? record.score),
    type,
    department: shortText(record.department)?.toLowerCase() ?? null,
    position: shortText(record.position),
    verification,
    decisionMaker: record.decision_maker === true,
  };
}

export function parseDomainSearch(body: unknown): HunterCandidate[] | null {
  if (!body || typeof body !== "object") return null;
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const emails = (data as { emails?: unknown }).emails;
  if (!Array.isArray(emails)) return null;
  const parsed: HunterCandidate[] = [];
  for (const entry of emails) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const email = cleanEmail(record.value);
    if (!email) continue;
    parsed.push(candidateFromRecord(record, email));
  }
  return parsed;
}

export function parseEmailFinder(body: unknown): HunterCandidate | null | "malformed" {
  if (!body || typeof body !== "object") return "malformed";
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== "object") return "malformed";
  const record = data as Record<string, unknown>;
  const email = cleanEmail(record.email);
  if (!email) return null;
  return candidateFromRecord({ ...record, type: "personal" }, email);
}

export function parseVerifier(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const status = (data as { status?: unknown }).status;
  return typeof status === "string" ? status : null;
}

function searchUrl(kind: "domain" | "person", input: ContactLookup, domain: string | null): string {
  if (kind === "domain" && domain) {
    const url = new URL("/v2/domain-search", HUNTER_ORIGIN);
    url.searchParams.set("domain", domain);
    url.searchParams.set("limit", LIMIT);
    return url.toString();
  }
  const url = new URL("/v2/email-finder", HUNTER_ORIGIN);
  url.searchParams.set("company", input.name.trim().slice(0, 200));
  url.searchParams.set("first_name", (input.firstName ?? "").trim().slice(0, 80));
  url.searchParams.set("last_name", (input.lastName ?? "").trim().slice(0, 80));
  return url.toString();
}

function verifierUrl(email: string): string {
  const url = new URL("/v2/email-verifier", HUNTER_ORIGIN);
  url.searchParams.set("email", email);
  return url.toString();
}

function needsVerifier(candidate: HunterCandidate): boolean {
  return candidate.verification !== "valid" && candidate.verification !== "accept_all";
}

function guardedFetch(): typeof fetch {
  return () => Promise.reject(new Error("Hunter must be mocked in tests"));
}

export interface HunterDeps {
  env: HunterEnv;
  store: LookupStore;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
}

async function verifyCandidate(
  email: string,
  apiKey: string,
  deps: Required<Pick<HunterDeps, "fetchImpl" | "timeoutMs" | "delay">> & { store: LookupStore },
): Promise<{ kind: "status"; status: string } | { kind: "error" } | { kind: "unavailable" }> {
  const reserved = await deps.store.budget("verification", "reserve");
  if (reserved.outcome === "exhausted") return { kind: "unavailable" };
  let latest: HunterResponse | "timeout" = "timeout";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    latest = await hunterGet(verifierUrl(email), apiKey, deps.fetchImpl, deps.timeoutMs);
    if (latest === "timeout") break;
    if (latest.status !== 202) break;
    if (attempt < 2) await deps.delay(attempt === 0 ? 0 : 1000);
  }
  if (latest === "timeout") return { kind: "error" };
  if (latest.status === 401) {
    await deps.store.budget("verification", "release");
    return { kind: "error" };
  }
  if (isQuota(latest.status, latest.body)) {
    await deps.store.budget("verification", "exhaust");
    return { kind: "error" };
  }
  if (latest.status === 403) {
    await deps.store.budget("verification", "release");
    return { kind: "error" };
  }
  if (latest.status !== 200) return { kind: "error" };
  const status = parseVerifier(latest.body);
  if (!status) return { kind: "error" };
  return { kind: "status", status };
}

function fromHit(hit: LookupHit, domain: string | null): ContactLookupResult {
  if (hit.status === "not_found" || hit.status === "unverified" || !hit.email) {
    return {
      status: "not_found",
      email: null,
      raw: hit.raw ?? rawFor("cache", domain, "not_found", null, null),
    };
  }
  return {
    status: "found",
    email: hit.email,
    raw: hit.raw ?? rawFor("cache", domain, "found", null, "valid"),
  };
}

export async function findWithHunter(
  input: ContactLookup,
  deps: HunterDeps,
): Promise<ContactLookupResult> {
  if (deps.env.disabled || !deps.env.apiKey) return unavailable();
  const cache = lookupCacheKey(input);
  if (!cache) return notFound("none", null);

  const domain = cache.kind === "domain" ? cache.key.slice("domain:".length) : null;
  const operation = cache.kind === "domain" ? "domain_search" : "email_finder";
  const fetchImpl =
    deps.fetchImpl ??
    (process.env.NODE_ENV === "test" || process.env.CI === "true" ? guardedFetch() : fetch);
  const timeoutMs = deps.timeoutMs ?? 20_000;
  const delay = deps.delay ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const apiKey = deps.env.apiKey;

  let claimed: ClaimResult;
  try {
    claimed = await deps.store.claim(cache.key);
  } catch {
    return errorResult();
  }
  if (claimed.outcome === "pending") return unavailable();
  if (claimed.outcome === "hit" && claimed.status !== "unverified") return fromHit(claimed, domain);

  const resumeEmail = claimed.outcome === "hit" ? cleanEmail(claimed.email) : null;
  if (claimed.outcome === "hit" && !resumeEmail) return errorResult();
  const resumed = claimed.outcome === "hit" ? claimed.raw : null;

  let candidate: HunterCandidate | null = null;
  if (!resumeEmail) {
    let reserved: BudgetResult;
    try {
      reserved = await deps.store.budget("search", "reserve");
    } catch {
      return errorResult();
    }
    if (reserved.outcome === "exhausted") {
      await deps.store.abandon(cache.key).catch(() => undefined);
      return unavailable();
    }
    const response = await hunterGet(
      searchUrl(cache.kind, input, domain),
      apiKey,
      fetchImpl,
      timeoutMs,
    );
    if (response === "timeout") return errorResult();
    if (response.status === 401 || response.status === 403) {
      await deps.store.budget("search", "release").catch(() => undefined);
      await deps.store.abandon(cache.key).catch(() => undefined);
      return errorResult();
    }
    if (isQuota(response.status, response.body)) {
      await deps.store.budget("search", "exhaust").catch(() => undefined);
      await deps.store.abandon(cache.key).catch(() => undefined);
      return errorResult();
    }
    if (response.status === 451) {
      await deps.store.budget("search", "release").catch(() => undefined);
      const missed = notFound(operation, domain);
      await deps.store.complete(cache.key, "not_found", null, missed.raw);
      return missed;
    }
    if (response.status !== 200) {
      await deps.store.budget("search", "release").catch(() => undefined);
      await deps.store.abandon(cache.key).catch(() => undefined);
      return errorResult();
    }
    if (cache.kind === "domain") {
      const parsed = parseDomainSearch(response.body);
      if (!parsed) return errorResult();
      if (parsed.length === 0) {
        await deps.store.budget("search", "release").catch(() => undefined);
        const missed = notFound(operation, domain);
        await deps.store.complete(cache.key, "not_found", null, missed.raw);
        return missed;
      }
      candidate = chooseHotelEmail(parsed);
      if (!candidate) {
        const missed = notFound(operation, domain);
        await deps.store.complete(cache.key, "not_found", null, missed.raw);
        return missed;
      }
    } else {
      const parsed = parseEmailFinder(response.body);
      if (parsed === "malformed") return errorResult();
      if (!parsed) {
        await deps.store.budget("search", "release").catch(() => undefined);
        const missed = notFound(operation, domain);
        await deps.store.complete(cache.key, "not_found", null, missed.raw);
        return missed;
      }
      candidate = parsed.verification === "invalid" ? null : parsed;
      if (!candidate) {
        const missed = notFound(operation, domain);
        await deps.store.complete(cache.key, "not_found", null, missed.raw);
        return missed;
      }
    }
  } else {
    candidate = {
      email: resumeEmail,
      confidence: typeof resumed?.confidence === "number" ? resumed.confidence : 0,
      type: "generic",
      department: resumed?.department ?? null,
      position: resumed?.position ?? null,
      verification: null,
      decisionMaker: resumed?.decisionMaker === true,
    };
  }

  if (!needsVerifier(candidate)) {
    const found: ContactLookupResult = {
      status: "found",
      email: candidate.email,
      raw: rawFor(operation, domain, "found", candidate, candidate.verification),
    };
    await deps.store.complete(cache.key, "found", candidate.email, found.raw);
    return found;
  }

  const pendingRaw = rawFor(operation, domain, "not_found", candidate, candidate.verification);
  await deps.store.complete(cache.key, "unverified", candidate.email, {
    ...pendingRaw,
    status: "not_found",
  });

  let verified: Awaited<ReturnType<typeof verifyCandidate>>;
  try {
    verified = await verifyCandidate(candidate.email, apiKey, {
      fetchImpl,
      timeoutMs,
      delay,
      store: deps.store,
    });
  } catch {
    return errorResult();
  }
  if (verified.kind === "unavailable") return unavailable();
  if (verified.kind === "error") return errorResult();
  if (verified.status === "valid" || verified.status === "accept_all") {
    const found: ContactLookupResult = {
      status: "found",
      email: candidate.email,
      raw: rawFor(operation, domain, "found", candidate, verified.status),
    };
    await deps.store.complete(cache.key, "found", candidate.email, found.raw);
    return found;
  }
  const missed = notFound(operation, domain);
  await deps.store.complete(cache.key, "not_found", null, missed.raw);
  return missed;
}
