/**
 * Per-address limit for the public share page.
 *
 * The limit runs before the token lookup, so a rejected request does not
 * reveal whether the token exists. The map is process-local. It is a bound
 * on guessing, not a view counter.
 */
const WINDOW_MS = 60_000;
const LIMIT = 30;

interface Bucket {
  start: number;
  count: number;
}

const buckets = new Map<string, Bucket>();

export function resetShareLinkRateLimit(): void {
  buckets.clear();
}

/** Netlify's platform address. A caller-supplied forwarded-for hop is not a key. */
export function shareLinkClientKey(platformIp: string | null): string {
  const ip = platformIp?.trim() ?? "";
  if (!ip) return "unknown";
  return ip.slice(0, 200);
}

export function consumeShareLinkRequest(
  key: string,
  now = Date.now(),
): { allowed: boolean; retryAfterSeconds: number } {
  const safeKey = key.slice(0, 200) || "unknown";
  if (buckets.size >= 5000) {
    for (const [stored, bucket] of buckets) {
      if (now - bucket.start >= WINDOW_MS) buckets.delete(stored);
    }
  }
  const current = buckets.get(safeKey);
  if (!current || now - current.start >= WINDOW_MS) {
    if (!buckets.has(safeKey) && buckets.size >= 5000) {
      return { allowed: false, retryAfterSeconds: Math.ceil(WINDOW_MS / 1000) };
    }
    buckets.set(safeKey, { start: now, count: 1 });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (current.count >= LIMIT) {
    const retryAfterSeconds = Math.max(1, Math.ceil((WINDOW_MS - (now - current.start)) / 1000));
    return { allowed: false, retryAfterSeconds };
  }
  current.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}
