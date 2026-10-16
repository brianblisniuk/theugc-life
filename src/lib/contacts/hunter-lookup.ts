/**
 * Hunter lookup (D180).
 *
 * Official API, retrieved 2026-10-16: https://hunter.io/api-documentation/v2
 *
 * - Domain Search: GET /v2/domain-search. A query is counted when it returns
 *   at least one result. Free-plan pagination stops at 10, so this call asks
 *   for limit=10 and does not page. Each email in that response that carries
 *   a verification is also a verification credit. This lookup reserves that
 *   limit before the call and then keeps one credit per returned verification,
 *   so a later call fails closed before the free-plan ceiling of 50.
 * - Email Finder: GET /v2/email-finder. It needs a person's name. No email
 *   means no search credit.
 * - Email Verifier: GET /v2/email-verifier. A 202 is still in progress and
 *   counts once, so the polls share one reservation.
 * - The key is sent as X-API-KEY. It is never a query parameter.
 * - 401 means the key was rejected. 429, and a 403 whose error id is
 *   quota-like, exhaust that call's bucket. A 403 without that id is the
 *   short rate limit: the reservation is released and the month stays open.
 *   The same order is used for Domain Search and the Email Verifier.
 * - Verifier 451 (claimed_email) finishes the lookup as not_found with no
 *   address and does not call Hunter again.
 *
 * The hotel unlock path has a website domain and no person, so it uses
 * Domain Search only. Email Finder runs only for a named person when that
 * hotel has no website domain. The same cache key never calls Hunter twice
 * for a finished found or not_found row.
 */

import type { ContactLookup, ContactLookupResult, ContactProviderRaw } from "./types";

export const HUNTER_ORIGIN = "https://api.hunter.io";
export const HUNTER_SEARCH_BUDGET = 50;
export const HUNTER_VERIFICATION_BUDGET = 50;
export const LOOKUP_PENDING_MS = 2 * 60 * 1000;
const DOMAIN_SEARCH_LIMIT = 10;
const LIMIT = String(DOMAIN_SEARCH_LIMIT);

/**
 * Domain Search can verify every address it returns, up to `limit`.
 * Reserving this many verification credits before the call means a search
 * is not sent when the remainder cannot cover that worst case.
 */
export const HUNTER_DOMAIN_SEARCH_VERIFICATION_HEADROOM = DOMAIN_SEARCH_LIMIT;

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

/** Generic routes named in the D180 amendment. Other locals are not this tier. */
const GENERIC_LOCALS = new Set(["marketing", "pr", "sales", "info"]);

const OUTREACH_ROLE =
  /\b(?:marketing|partnerships?|public relations|pr|press|communications?|comms|social media|social|sales)\b/i;
const GUEST_ROLE = /\b(?:guest relations?|guest experience)\b/i;

export type HunterVerification =
  "valid" | "accept_all" | "unknown" | "invalid" | "webmail" | "disposable";

export interface HunterCandidate {
  email: string;
  confidence: number;
  type: "personal" | "generic";
  department: string | null;
  position: string | null;
  verification: HunterVerification | null;
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
  if (
    value === "valid" ||
    value === "accept_all" ||
    value === "unknown" ||
    value === "invalid" ||
    value === "webmail" ||
    value === "disposable"
  ) {
    return value;
  }
  return null;
}

function confidenceOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function roleText(candidate: HunterCandidate): string {
  return `${candidate.department ?? ""} ${candidate.position ?? ""}`.toLowerCase();
}

/** Executives and back-of-house roles lose to an outreach, guest, or generic route. */
function isPenalized(candidate: HunterCandidate): boolean {
  const department = candidate.department?.toLowerCase() ?? "";
  const text = roleText(candidate);
  if (department === "executive") return true;
  if (/\bmanaging director\b/.test(text)) return true;
  if (/\bgeneral manager\b/.test(text)) return true;
  if (/\bgm\b/.test(text)) return true;
  if (/\b(?:kitchen|housekeeping|housekeeper|engineering|engineers?)\b/.test(text)) return true;
  if (/\bf\s*&\s*b\b/.test(text)) return true;
  if (/\bfood\s+(?:and|&)\s+beverage\b/.test(text)) return true;
  return false;
}

/**
 * 4 outreach, 3 guest relations, 2 generic marketing@/pr@/sales@/info@,
 * 1 anything else, 0 penalized. Confidence is not part of the tier.
 */
export function outreachTier(candidate: HunterCandidate): number {
  if (isPenalized(candidate)) return 0;
  if (OUTREACH_ROLE.test(roleText(candidate))) return 4;
  if (GUEST_ROLE.test(roleText(candidate))) return 3;
  const local = candidate.email.split("@")[0] ?? "";
  if (GENERIC_LOCALS.has(local)) return 2;
  return 1;
}

/** Best outreach role, then guest relations, then a generic route. Invalid is skipped. */
export function chooseHotelEmail(candidates: readonly HunterCandidate[]): HunterCandidate | null {
  const usable = candidates.filter((candidate) => candidate.verification !== "invalid");
  usable.sort((a, b) => {
    const tier = outreachTier(b) - outreachTier(a);
    if (tier !== 0) return tier;
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
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

function onHotelDomain(email: string, domain: string | null): boolean {
  if (!domain) return false;
  const host = email.slice(email.lastIndexOf("@") + 1);
  return host === domain;
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

type HttpDisposition = "ok" | "auth" | "quota" | "rate" | "claimed" | "other";

/** Search and the verifier share this order. A quota-like 403 is quota, not a short limit. */
function httpDisposition(status: number, body: unknown): HttpDisposition {
  if (status === 200) return "ok";
  if (status === 401) return "auth";
  if (isQuota(status, body)) return "quota";
  if (status === 403) return "rate";
  if (status === 451) return "claimed";
  return "other";
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

/** Emails whose verification object Hunter already counted, including ones we will not store. */
export function domainSearchVerificationCount(body: unknown): number {
  if (!body || typeof body !== "object") return 0;
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== "object") return 0;
  const emails = (data as { emails?: unknown }).emails;
  if (!Array.isArray(emails)) return 0;
  let count = 0;
  for (const entry of emails) {
    if (!entry || typeof entry !== "object") continue;
    const verification = (entry as { verification?: unknown }).verification;
    if (!verification || typeof verification !== "object") continue;
    const status = (verification as { status?: unknown }).status;
    if (typeof status === "string" && status.length > 0) count += 1;
  }
  return count;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function verificationsAvailable(node: unknown): number | null {
  if (!node || typeof node !== "object") return null;
  const requests = (node as { requests?: unknown }).requests;
  if (!requests || typeof requests !== "object") return null;
  const verifications = (requests as { verifications?: unknown }).verifications;
  if (!verifications || typeof verifications !== "object") return null;
  return finiteNumber((verifications as { available?: unknown }).available);
}

/**
 * Hunter's account payload uses `requests.verifications.available`.
 * Domain Search does not always include it. When it does, a remainder below
 * the headroom exhausts the local bucket before the next call.
 */
export function reportedVerificationsRemaining(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const root = body as { data?: unknown; meta?: unknown };
  return (
    verificationsAvailable(root.data) ??
    verificationsAvailable(root.meta) ??
    verificationsAvailable(root)
  );
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

async function releaseBudget(
  store: LookupStore,
  bucket: "search" | "verification",
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    try {
      await store.budget(bucket, "release");
    } catch {
      // A failed release must not hide the lookup error. The cap still fails closed.
    }
  }
}

/**
 * Reserves `count` credits or undoes the ones that committed.
 * A thrown reserve did not commit (the SQL function rolls back), so it is not released.
 */
async function reserveBudget(
  store: LookupStore,
  bucket: "search" | "verification",
  count: number,
): Promise<"reserved" | "exhausted" | "thrown"> {
  for (let i = 0; i < count; i += 1) {
    try {
      const result = await store.budget(bucket, "reserve");
      if (result.outcome !== "reserved") {
        await releaseBudget(store, bucket, i);
        return "exhausted";
      }
    } catch {
      await releaseBudget(store, bucket, i);
      return "thrown";
    }
  }
  return "reserved";
}

async function abandonClaim(store: LookupStore, cacheKey: string): Promise<void> {
  try {
    await store.abandon(cacheKey);
  } catch {
    // A pending row expires after two minutes when abandon itself fails.
  }
}

type VerifyOutcome =
  | { kind: "status"; status: string }
  | { kind: "error" }
  | { kind: "unavailable" }
  | { kind: "claimed" };

async function verifyCandidate(
  email: string,
  apiKey: string,
  deps: Required<Pick<HunterDeps, "fetchImpl" | "timeoutMs" | "delay">> & { store: LookupStore },
): Promise<VerifyOutcome> {
  const reserved = await deps.store.budget("verification", "reserve");
  if (reserved.outcome === "exhausted") return { kind: "unavailable" };
  let latest: HunterResponse | "timeout" = "timeout";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    latest = await hunterGet(verifierUrl(email), apiKey, deps.fetchImpl, deps.timeoutMs);
    if (latest === "timeout") break;
    if (latest.status !== 202) break;
    if (attempt < 2) await deps.delay(attempt === 0 ? 0 : 1000);
  }
  if (latest === "timeout") {
    await deps.store.budget("verification", "release").catch(() => undefined);
    return { kind: "error" };
  }
  if (latest.status === 202) return { kind: "error" };
  const disposition = httpDisposition(latest.status, latest.body);
  if (disposition === "auth" || disposition === "rate" || disposition === "other") {
    await deps.store.budget("verification", "release").catch(() => undefined);
    return { kind: "error" };
  }
  if (disposition === "quota") {
    await deps.store.budget("verification", "exhaust").catch(() => undefined);
    return { kind: "error" };
  }
  if (disposition === "claimed") return { kind: "claimed" };
  const status = parseVerifier(latest.body);
  if (!status) {
    await deps.store.budget("verification", "release").catch(() => undefined);
    return { kind: "error" };
  }
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

function isWebmailStatus(value: string | null | undefined): value is "webmail" | "disposable" {
  return value === "webmail" || value === "disposable";
}

export async function findWithHunter(
  input: ContactLookup,
  deps: HunterDeps,
): Promise<ContactLookupResult> {
  if (deps.env.disabled || !deps.env.apiKey) return unavailable();
  const cache = lookupCacheKey(input);
  if (!cache) return notFound("none", null);
  const cacheKey = cache.key;

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

  async function storeFound(
    candidate: HunterCandidate,
    verification: string,
  ): Promise<ContactLookupResult> {
    const found: ContactLookupResult = {
      status: "found",
      email: candidate.email,
      raw: rawFor(operation, domain, "found", candidate, verification),
    };
    await deps.store.complete(cacheKey, "found", candidate.email, found.raw);
    return found;
  }

  async function storeMiss(): Promise<ContactLookupResult> {
    const missed = notFound(operation, domain);
    await deps.store.complete(cacheKey, "not_found", null, missed.raw);
    return missed;
  }

  /**
   * webmail and disposable are a found address only on the hotel host.
   * Anywhere else the lookup stays unverified, Hunter is not called again,
   * and the result is an error so contact_cache is not written.
   */
  async function settleWebmail(
    candidate: HunterCandidate,
    verification: "webmail" | "disposable",
  ): Promise<ContactLookupResult> {
    if (!onHotelDomain(candidate.email, domain)) {
      await deps.store.complete(
        cacheKey,
        "unverified",
        candidate.email,
        rawFor(operation, domain, "not_found", candidate, verification),
      );
      return errorResult();
    }
    return storeFound(candidate, verification);
  }

  if (resumeEmail && isWebmailStatus(resumed?.verification)) {
    return settleWebmail(
      {
        email: resumeEmail,
        confidence: typeof resumed?.confidence === "number" ? resumed.confidence : 0,
        type: "generic",
        department: resumed?.department ?? null,
        position: resumed?.position ?? null,
        verification: resumed.verification,
        decisionMaker: resumed?.decisionMaker === true,
      },
      resumed.verification,
    );
  }

  let candidate: HunterCandidate | null = null;
  if (!resumeEmail) {
    let searchHeld = false;
    let verificationHeld = 0;
    const releaseOpen = async () => {
      if (searchHeld) await releaseBudget(deps.store, "search", 1);
      if (verificationHeld > 0) await releaseBudget(deps.store, "verification", verificationHeld);
      searchHeld = false;
      verificationHeld = 0;
      await abandonClaim(deps.store, cache.key);
    };

    try {
      const reserved = await deps.store.budget("search", "reserve");
      if (reserved.outcome === "exhausted") {
        await abandonClaim(deps.store, cache.key);
        return unavailable();
      }
      searchHeld = true;
    } catch {
      await abandonClaim(deps.store, cache.key);
      return errorResult();
    }

    if (cache.kind === "domain") {
      const headroom = await reserveBudget(
        deps.store,
        "verification",
        HUNTER_DOMAIN_SEARCH_VERIFICATION_HEADROOM,
      );
      if (headroom === "exhausted") {
        await releaseBudget(deps.store, "search", 1);
        await abandonClaim(deps.store, cache.key);
        return unavailable();
      }
      if (headroom === "thrown") {
        await releaseBudget(deps.store, "search", 1);
        await abandonClaim(deps.store, cache.key);
        return errorResult();
      }
      verificationHeld = HUNTER_DOMAIN_SEARCH_VERIFICATION_HEADROOM;
    }

    const response = await hunterGet(
      searchUrl(cache.kind, input, domain),
      apiKey,
      fetchImpl,
      timeoutMs,
    );
    if (response === "timeout") {
      await releaseOpen();
      return errorResult();
    }
    const disposition = httpDisposition(response.status, response.body);
    if (disposition === "auth" || disposition === "rate" || disposition === "other") {
      await releaseOpen();
      return errorResult();
    }
    if (disposition === "quota") {
      await deps.store.budget("search", "exhaust").catch(() => undefined);
      await releaseBudget(deps.store, "verification", verificationHeld);
      await abandonClaim(deps.store, cache.key);
      return errorResult();
    }
    if (disposition === "claimed") {
      await releaseBudget(deps.store, "search", 1);
      await releaseBudget(deps.store, "verification", verificationHeld);
      return storeMiss();
    }
    if (cache.kind === "domain") {
      const parsed = parseDomainSearch(response.body);
      if (!parsed) {
        await releaseOpen();
        return errorResult();
      }
      const counted = domainSearchVerificationCount(response.body);
      if (counted < verificationHeld) {
        await releaseBudget(deps.store, "verification", verificationHeld - counted);
      } else if (counted > verificationHeld) {
        const extra = await reserveBudget(deps.store, "verification", counted - verificationHeld);
        if (extra !== "reserved") {
          await deps.store.budget("verification", "exhaust").catch(() => undefined);
        }
      }
      verificationHeld = 0;
      const remaining = reportedVerificationsRemaining(response.body);
      if (remaining !== null && remaining < HUNTER_DOMAIN_SEARCH_VERIFICATION_HEADROOM) {
        await deps.store.budget("verification", "exhaust").catch(() => undefined);
      }
      if (parsed.length === 0) {
        await releaseBudget(deps.store, "search", 1);
        return storeMiss();
      }
      candidate = chooseHotelEmail(parsed);
      if (!candidate) return storeMiss();
    } else {
      const parsed = parseEmailFinder(response.body);
      if (parsed === "malformed") {
        await releaseOpen();
        return errorResult();
      }
      if (!parsed) {
        await releaseBudget(deps.store, "search", 1);
        return storeMiss();
      }
      if (parsed.verification === "invalid") return storeMiss();
      candidate = parsed;
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

  if (!candidate) return storeMiss();

  if (candidate.verification === "valid" || candidate.verification === "accept_all") {
    return storeFound(candidate, candidate.verification);
  }
  if (isWebmailStatus(candidate.verification)) {
    return settleWebmail(candidate, candidate.verification);
  }

  await deps.store.complete(
    cache.key,
    "unverified",
    candidate.email,
    rawFor(operation, domain, "not_found", candidate, candidate.verification),
  );

  let verified: VerifyOutcome;
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
  if (verified.kind === "claimed") return storeMiss();
  if (verified.status === "valid" || verified.status === "accept_all") {
    return storeFound(candidate, verified.status);
  }
  if (verified.status === "invalid") return storeMiss();
  if (isWebmailStatus(verified.status)) return settleWebmail(candidate, verified.status);
  return errorResult();
}
