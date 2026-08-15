/**
 * Hotelbeds ProviderTransport — the real one.
 *
 * Plugs the budget-guarded, cached, paced client into the generic evaluation
 * pipeline. Two responsibilities, kept apart:
 *
 *  - **destination resolution** — read country/destination master data and find
 *    the provider codes that represent our canonical destination. Bali is the
 *    case that punishes assumption: it may need a UNION of several destination
 *    codes, and querying one famous town is not "Bali".
 *  - **paged hotel retrieval** — walk the `from`/`to` window for one destination
 *    code until the provider stops returning rows.
 *
 * Both are real implementations. Neither has been executed against the live API,
 * because `api.test.hotelbeds.com` is blocked from this environment — that is
 * recorded as `liveValidationStatus: "blocked"`, not papered over.
 */
import { buildClassificationMaster } from "../classification";
import type { ProviderTransport } from "../execute";
import { paginateAll, type PageResult } from "../paginate";
import type { ClassificationMaster, PaginationEvidence } from "../types";
import { HotelbedsClient } from "./client";

/** Documented maximum rows per hotels page. */
export const MAX_PAGE_SIZE = 1000;

const HOTELS_PATH = "/hotel-content-api/1.0/hotels";
const DESTINATIONS_PATH = "/hotel-content-api/1.0/locations/destinations";
const CATEGORIES_PATH = "/hotel-content-api/1.0/types/categories";

/** One destination as returned by the locations master data. */
export interface HotelbedsDestination {
  code: string;
  name: string;
  countryCode: string;
  /** Number of zones supplied, when the provider includes them. */
  zones: number | null;
}

interface DestinationsResponseShape {
  destinations?: {
    code?: string;
    name?: { content?: string } | string;
    countryCode?: string;
    zones?: unknown[];
  }[];
  total?: number;
}

function destinationName(name: { content?: string } | string | undefined): string {
  if (typeof name === "string") return name;
  return name?.content ?? "";
}

/**
 * Fetch destination master data for one country, EXHAUSTIVELY.
 *
 * The previous implementation made a single `from=1&to=1000` request and
 * returned. Under D061 that cannot silently mean "all destinations": a country
 * with 1001 destinations would lose one, and nothing in the output would say so.
 *
 * Uses the shared paginator so exhaustion evidence, cursor-loop detection,
 * provider-total disagreement and budget interruption are handled the same way
 * as everywhere else rather than by a weaker parallel implementation.
 */
export async function fetchDestinations(
  client: HotelbedsClient,
  countryCode: string,
  pageSize = MAX_PAGE_SIZE,
): Promise<{
  destinations: HotelbedsDestination[];
  total: number | null;
  evidence: PaginationEvidence;
  interrupted: boolean;
}> {
  let interrupted = false;

  const { records, evidence } = await paginateAll<HotelbedsDestination>(
    async (cursor) => {
      const from = cursor === null ? 1 : Number(cursor);
      const to = from + pageSize - 1;

      const response = await client.request(DESTINATIONS_PATH, {
        fields: "all",
        language: "ENG",
        countryCodes: countryCode,
        from,
        to,
      });

      const body = response.body as DestinationsResponseShape;
      const rows = (body.destinations ?? []).flatMap((d) => {
        if (!d.code) return [];
        return [
          {
            code: d.code,
            name: destinationName(d.name),
            countryCode: d.countryCode ?? countryCode,
            zones: Array.isArray(d.zones) ? d.zones.length : null,
          },
        ];
      });

      const total = body.total ?? null;
      const retrieved = from - 1 + rows.length;
      // Keep going while the provider is still filling pages, or while its own
      // total says there is more. A full page is never assumed to be the end.
      const done =
        rows.length === 0 || (rows.length < pageSize && (total === null || retrieved >= total));

      return {
        records: rows,
        nextCursor: done ? null : String(from + rows.length),
        reportedTotal: total,
      };
    },
    { method: "from/to window over the destinations operation" },
  );

  // A budget or quota stop surfaces as a thrown error from the client, so
  // reaching here without proven exhaustion means the walk ended early.
  if (!evidence.exhaustionProven) interrupted = true;

  return { destinations: records, total: evidence.reportedTotal, evidence, interrupted };
}

/**
 * Fetch the Hotelbeds categories master.
 *
 * The documented architecture: the hotels operation returns CODES and the
 * descriptive/master operations explain them. Without this join every category
 * code would normalize to `unresolved_no_master_entry`, and a provider supplying
 * perfectly good classification evidence would look like it supplied none.
 *
 * Documentation puts the universe at roughly 60 categories, so one page is
 * normally enough — but the count is VERIFIED rather than assumed, and the walk
 * continues if the provider says there is more.
 */
export async function fetchHotelbedsCategoryMaster(
  client: HotelbedsClient,
  pageSize = MAX_PAGE_SIZE,
): Promise<{
  classifications: Map<string, ClassificationMaster>;
  rawCount: number;
  uniqueCodes: number;
  duplicateCodes: string[];
  evidence: PaginationEvidence;
}> {
  const { records, evidence } = await paginateAll<Record<string, unknown>>(
    async (cursor) => {
      const from = cursor === null ? 1 : Number(cursor);
      const to = from + pageSize - 1;

      const response = await client.request(CATEGORIES_PATH, {
        fields: "all",
        language: "ENG",
        from,
        to,
      });

      const body = response.body as {
        categories?: Record<string, unknown>[];
        total?: number;
      };
      const rows = body.categories ?? [];
      const total = body.total ?? null;
      const retrieved = from - 1 + rows.length;
      const done =
        rows.length === 0 || (rows.length < pageSize && (total === null || retrieved >= total));

      return {
        records: rows,
        nextCursor: done ? null : String(from + rows.length),
        reportedTotal: total,
      };
    },
    { method: "from/to window over the categories master" },
  );

  const classifications = buildClassificationMaster(records, {
    code: "code",
    simpleCode: "simpleCode",
    accommodationType: "accommodationType",
    group: "group",
    description: "description.content",
  });

  // Duplicate codes would silently overwrite one another in the map; surfacing
  // them is source-quality evidence rather than a detail to swallow.
  const seen = new Set<string>();
  const duplicateCodes: string[] = [];
  for (const row of records) {
    const code = typeof row.code === "string" ? row.code : String(row.code ?? "");
    if (!code) continue;
    if (seen.has(code)) duplicateCodes.push(code);
    seen.add(code);
  }

  return {
    classifications,
    rawCount: records.length,
    uniqueCodes: classifications.size,
    duplicateCodes,
    evidence,
  };
}

interface HotelsResponseShape {
  hotels?: unknown[];
  total?: number;
  from?: number;
  to?: number;
}

/**
 * Build a transport that enumerates one or more Hotelbeds destination codes.
 *
 * The generic pipeline calls `fetchPage(entityId, cursor)` per geography entity,
 * where `entityId` is a Hotelbeds destination code and the cursor encodes the
 * `from` offset of the next window.
 */
export function createHotelbedsTransport(
  client: HotelbedsClient,
  pageSize: number = MAX_PAGE_SIZE,
): ProviderTransport {
  return {
    async fetchPage(entityId: string, cursor: string | null): Promise<PageResult<unknown>> {
      const from = cursor === null ? 1 : Number(cursor);
      const to = from + pageSize - 1;

      const response = await client.request(HOTELS_PATH, {
        fields: "all",
        language: "ENG",
        destinationCode: entityId,
        from,
        to,
      });

      const body = response.body as HotelsResponseShape;
      const hotels = body.hotels ?? [];
      const total = body.total ?? null;

      // Termination: the provider returned fewer rows than the window, or we
      // have reached its declared total. Anything else advances the window.
      const retrievedSoFar = from - 1 + hotels.length;
      const done =
        hotels.length === 0 ||
        hotels.length < pageSize ||
        (total !== null && retrievedSoFar >= total);

      return {
        records: hotels,
        nextCursor: done ? null : String(from + hotels.length),
        reportedTotal: total,
      };
    },
  };
}

/**
 * Minimal authenticated diagnostic call.
 *
 * Answers two questions for the smallest possible quota cost: are the
 * credentials valid, and is the API reachable? It hits a small types/reference
 * endpoint rather than hotel content, and never touches availability or booking.
 *
 * **It deliberately BYPASSES the response cache.** A cached 200 from yesterday
 * cannot prove today's credentials still work — a key can be revoked or rotated
 * at any time — so reporting `valid` from a cached body would be asserting a
 * current fact from stale evidence. The probe therefore costs exactly one
 * provider request, and that is the correct price for a current answer.
 */
export type CredentialVerdict = "valid" | "invalid" | "untested";

export async function probeCredentials(client: HotelbedsClient): Promise<{
  credentials: CredentialVerdict;
  reachable: boolean;
  status: number | null;
  detail: string;
}> {
  try {
    const response = await client.request(
      "/hotel-content-api/1.0/types/categories",
      { fields: "all", language: "ENG", from: 1, to: 1 },
      // Never answer "are the credentials valid TODAY" from cache.
      { bypassCache: true },
    );
    return {
      credentials: "valid",
      reachable: true,
      status: response.status,
      detail: "Authenticated request succeeded (live, cache bypassed).",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : "";

    // Three genuinely different outcomes, and collapsing them would be a lie in
    // either direction: a blocked network says nothing about the credential,
    // while a provider 401/403 says everything.
    if (name === "EgressBlockedError") {
      return { credentials: "untested", reachable: false, status: null, detail: message };
    }
    if (name === "AuthenticationFailedError") {
      return { credentials: "invalid", reachable: true, status: null, detail: message };
    }
    return { credentials: "untested", reachable: false, status: null, detail: message };
  }
}
