/**
 * On-disk cache for Hotelbeds static-content responses.
 *
 * Under a 50-requests-per-day evaluation quota, caching is not an optimisation —
 * it is what makes the evaluation repeatable at all. A rerun that re-fetches
 * discovery requests it already has would consume a day of capacity to learn
 * nothing new.
 *
 * The cache is keyed on the FULL request identity (method, path, query,
 * body) so a different query can never silently reuse another's response. It
 * lives under the gitignored artifact root; provider payloads never enter git.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { artifactPath } from "../artifacts";

export const HOTELBEDS_CACHE_DIR = "hotelbeds";

export interface CachedResponse {
  status: number;
  body: unknown;
  /** Request identity this entry answers, for auditability. */
  requestKey: string;
  /** Human-readable description of the request. Never includes credentials. */
  requestSummary: string;
}

/** Everything that makes two requests genuinely the same request. */
export interface CacheIdentity {
  provider: string;
  /** Environment/base URL: test and production are different worlds. */
  baseUrl: string;
  /** Non-secret credential fingerprint — never the key itself. */
  accountFingerprint: string;
  method: string;
  url: string;
  body?: unknown;
}

/**
 * Stable cache key for one request.
 *
 * Includes the ACCOUNT fingerprint and base URL, because Hotelbeds responses can
 * differ by account portfolio and by environment. Without them a future key
 * would silently read another account's cached inventory and report it as its
 * own — a wrong answer that looks exactly like a right one.
 *
 * The raw API key is never part of this: only its irreversible fingerprint. The
 * per-request signature is excluded too, since it changes every second and would
 * make every lookup a miss.
 */
export function cacheKey(identity: CacheIdentity): string {
  const payload = JSON.stringify({
    provider: identity.provider,
    baseUrl: identity.baseUrl,
    account: identity.accountFingerprint,
    method: identity.method.toUpperCase(),
    url: identity.url,
    body: identity.body ?? null,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

/** Cache entries are additionally namespaced by account on disk, for clarity. */
export function cacheFilePath(key: string, accountFingerprint: string, root?: string): string {
  return root
    ? join(root, HOTELBEDS_CACHE_DIR, accountFingerprint, `${key}.json`)
    : artifactPath(HOTELBEDS_CACHE_DIR, accountFingerprint, `${key}.json`);
}

export function readCache(
  key: string,
  accountFingerprint: string,
  root?: string,
): CachedResponse | null {
  const path = cacheFilePath(key, accountFingerprint, root);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CachedResponse;
  } catch {
    // A corrupt entry is a miss, never a crash — but it must not be silently
    // treated as "no data for this destination" either; the caller re-requests.
    return null;
  }
}

export function writeCache(
  key: string,
  accountFingerprint: string,
  value: CachedResponse,
  root?: string,
): string {
  const path = cacheFilePath(key, accountFingerprint, root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}
