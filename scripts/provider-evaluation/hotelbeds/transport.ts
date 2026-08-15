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
import type { PageResult } from "../paginate";
import type { ProviderTransport } from "../execute";
import { HotelbedsClient } from "./client";

/** Documented maximum rows per hotels page. */
export const MAX_PAGE_SIZE = 1000;

const HOTELS_PATH = "/hotel-content-api/1.0/hotels";
const DESTINATIONS_PATH = "/hotel-content-api/1.0/locations/destinations";

/** One destination as returned by the locations master data. */
export interface HotelbedsDestination {
  code: string;
  name: string;
  countryCode: string;
}

interface DestinationsResponseShape {
  destinations?: {
    code?: string;
    name?: { content?: string } | string;
    countryCode?: string;
  }[];
  total?: number;
}

function destinationName(name: { content?: string } | string | undefined): string {
  if (typeof name === "string") return name;
  return name?.content ?? "";
}

/**
 * Fetch destination master data for one country.
 *
 * Deliberately a separate, explicit step: destination codes are EVIDENCE and
 * must be recorded with the method that produced them, never hard-coded from
 * memory.
 */
export async function fetchDestinations(
  client: HotelbedsClient,
  countryCode: string,
  from = 1,
  to = 1000,
): Promise<{ destinations: HotelbedsDestination[]; total: number | null }> {
  const response = await client.request(DESTINATIONS_PATH, {
    fields: "all",
    language: "ENG",
    countryCodes: countryCode,
    from,
    to,
  });

  const body = response.body as DestinationsResponseShape;
  const destinations = (body.destinations ?? []).flatMap((d) => {
    const code = d.code;
    if (!code) return [];
    return [
      {
        code,
        name: destinationName(d.name),
        countryCode: d.countryCode ?? countryCode,
      },
    ];
  });

  return { destinations, total: body.total ?? null };
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
 * Used to answer two questions for the smallest possible quota cost:
 * are the credentials valid, and is the API reachable? It deliberately hits a
 * small types/reference endpoint rather than hotel content, and never touches
 * availability or booking.
 */
export type CredentialVerdict = "valid" | "invalid" | "untested";

export async function probeCredentials(client: HotelbedsClient): Promise<{
  credentials: CredentialVerdict;
  reachable: boolean;
  status: number | null;
  detail: string;
}> {
  try {
    const response = await client.request("/hotel-content-api/1.0/types/categories", {
      fields: "all",
      language: "ENG",
      from: 1,
      to: 1,
    });
    return {
      credentials: "valid",
      reachable: true,
      status: response.status,
      detail: response.fromCache
        ? "Served from cache; no request consumed."
        : "Authenticated request succeeded.",
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
