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

/**
 * Stable cache key for one request.
 *
 * Credentials are deliberately NOT part of the key: the signature changes every
 * second, so including it would make every entry a miss and defeat the cache.
 */
export function cacheKey(method: string, url: string, body?: unknown): string {
  const payload = JSON.stringify({ method: method.toUpperCase(), url, body: body ?? null });
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

export function cacheFilePath(key: string, root?: string): string {
  return root
    ? join(root, HOTELBEDS_CACHE_DIR, `${key}.json`)
    : artifactPath(HOTELBEDS_CACHE_DIR, `${key}.json`);
}

export function readCache(key: string, root?: string): CachedResponse | null {
  const path = cacheFilePath(key, root);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CachedResponse;
  } catch {
    // A corrupt entry is a miss, never a crash — but it must not be silently
    // treated as "no data for this destination" either; the caller re-requests.
    return null;
  }
}

export function writeCache(key: string, value: CachedResponse, root?: string): string {
  const path = cacheFilePath(key, root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}
