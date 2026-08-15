/**
 * Hotelbeds HTTP client: budget-guarded, paced, cached, credential-safe.
 *
 * Every provider request in this evaluation goes through `request()`. It is the
 * single choke point where the 50/day quota is protected, so there is no path
 * that issues a request without reserving budget first.
 *
 * Order of operations, and why:
 *
 *  1. **Cache first.** A cached response costs nothing and must not consume
 *     budget — that is the entire reason the cache exists.
 *  2. **Reserve budget, pacing as needed.** Reserving BEFORE the request means
 *     the ceiling cannot be exceeded by one last page.
 *  3. **Classify the response.** 401/403 and quota errors are terminal; only a
 *     narrow set of transient statuses earns a single retry, and that retry
 *     costs budget because the provider counts it too.
 *  4. **Cache successes.** So the next run resumes instead of re-spending.
 */
import {
  AuthenticationFailedError,
  DailyQuotaError,
  EgressBlockedError,
  isTransientStatus,
  RequestBudget,
  terminalReasonFor,
} from "./budget";
import { cacheKey, readCache, writeCache, type CachedResponse } from "./cache";
import { buildAuthHeaders, redactHeaders, type HotelbedsCredentials } from "./signature";

export interface HotelbedsClientOptions {
  baseUrl: string;
  credentials: HotelbedsCredentials;
  budget: RequestBudget;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for signature timestamps (seconds). */
  nowSeconds?: () => number;
  /** Cache root override, for tests. */
  cacheRoot?: string;
  /** When false, a cached entry is ignored and a fresh request is made. */
  useCache?: boolean;
  /** Diagnostic sink. Receives only redacted material. */
  log?: (message: string) => void;
}

export interface HotelbedsResponse {
  status: number;
  body: unknown;
  fromCache: boolean;
}

/** One bounded retry for a genuinely transient failure. */
const MAX_ATTEMPTS_PER_REQUEST = 2;

export class HotelbedsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly nowSeconds: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly options: HotelbedsClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.log = options.log ?? (() => {});
  }

  /**
   * Issue one authenticated GET against the Hotelbeds API.
   *
   * `path` is appended to the configured base URL. Query parameters are passed
   * separately so the cache key is built from a canonical URL.
   */
  async request(
    path: string,
    query: Record<string, string | number> = {},
  ): Promise<HotelbedsResponse> {
    const url = this.buildUrl(path, query);
    const key = cacheKey("GET", url);

    if (this.options.useCache !== false) {
      const cached = readCache(key, this.options.cacheRoot);
      if (cached) {
        this.options.budget.recordCacheHit();
        this.log(`cache hit: ${cached.requestSummary}`);
        return { status: cached.status, body: cached.body, fromCache: true };
      }
    }

    let lastError: unknown = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_REQUEST; attempt += 1) {
      // Throws when the budget is spent — before any network activity.
      await this.options.budget.reserve(attempt > 1);

      const headers = buildAuthHeaders(this.options.credentials, this.nowSeconds());
      this.log(`GET ${url} headers=${JSON.stringify(redactHeaders(headers))}`);

      let response: Response;
      try {
        response = await this.fetchImpl(url, { method: "GET", headers });
      } catch (error) {
        // A network/egress failure is not a provider rejection. It still cost an
        // attempt, so it is recorded, but it is not retried blindly forever.
        this.options.budget.recordFailure();
        lastError = error;
        if (attempt >= MAX_ATTEMPTS_PER_REQUEST) break;
        continue;
      }

      // A local egress denial is NOT a provider response. Detect it before any
      // status-based classification, or a proxy 403 would be reported as an
      // authentication failure against a credential that was never tested.
      const denyReason = response.headers.get("x-deny-reason");
      if (denyReason) {
        this.options.budget.recordFailure();
        this.options.budget.stop("egress_blocked");
        throw new EgressBlockedError(new URL(url).host, denyReason);
      }

      // From here the response genuinely came from the provider, so the request
      // consumed provider quota.
      this.options.budget.recordProviderReached();

      const terminal = terminalReasonFor(response.status);
      if (terminal === "authentication_failed") {
        this.options.budget.recordFailure();
        this.options.budget.stop(terminal);
        throw new AuthenticationFailedError(response.status);
      }
      if (terminal === "blocked_by_daily_quota") {
        this.options.budget.recordFailure();
        this.options.budget.stop(terminal);
        throw new DailyQuotaError(response.status);
      }

      if (response.ok) {
        const body: unknown = await response.json();
        this.options.budget.recordSuccess();
        const entry: CachedResponse = {
          status: response.status,
          body,
          requestKey: key,
          requestSummary: `GET ${url}`,
        };
        writeCache(key, entry, this.options.cacheRoot);
        return { status: response.status, body, fromCache: false };
      }

      this.options.budget.recordFailure();

      if (!isTransientStatus(response.status) || attempt >= MAX_ATTEMPTS_PER_REQUEST) {
        throw new Error(`Hotelbeds request failed with HTTP ${response.status} for ${url}`);
      }
      // Loop for exactly one bounded retry on a transient status.
    }

    throw new Error(
      `Hotelbeds request failed after ${MAX_ATTEMPTS_PER_REQUEST} attempts for ${url}` +
        (lastError instanceof Error ? `: ${lastError.message}` : ""),
    );
  }

  private buildUrl(path: string, query: Record<string, string | number>): string {
    const base = this.options.baseUrl.replace(/\/$/, "");
    const suffix = path.startsWith("/") ? path : `/${path}`;
    const entries = Object.entries(query).map(([k, v]) => [k, String(v)] as [string, string]);
    // Sorted so the cache key is stable regardless of caller ordering.
    entries.sort(([a], [b]) => a.localeCompare(b));
    const search = new URLSearchParams(entries).toString();
    return search ? `${base}${suffix}?${search}` : `${base}${suffix}`;
  }
}
