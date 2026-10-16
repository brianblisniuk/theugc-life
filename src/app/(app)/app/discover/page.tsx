/**
 * Discover — published canonical hotels (PRD §7.2, D013, D058, D062).
 *
 * Search is a keyword. It becomes a chip. It is not sent to a model.
 * Premium contacts are never selected. The map shows this page's pins only.
 * A locked premium sort keeps the name-ordered page and explains the lock.
 */
import Link from "next/link";
import type { Metadata } from "next";

import { AnalyticsPageView } from "@/components/analytics-page-view";
import { DiscoverFilters } from "@/components/hotels/discover-filters";
import { DiscoverFrame, MapToggle, SyncRow } from "@/components/hotels/discover-sync";
import { DiscoverMap } from "@/components/hotels/hotel-map";
import { HotelRow } from "@/components/hotels/hotel-row";
import { resolveSession } from "@/lib/auth/guards";
import {
  buildDiscoverHref,
  hasActiveFilters,
  hotelTypeLabel,
  parseDiscoverQuery,
  type RawSearchParams,
} from "@/lib/hotels/filters";
import { isPublishedStarRating } from "@/lib/hotels/publication";
import {
  getPublicCardSignals,
  listDiscoverCatalog,
  loadSessionCreatorBadges,
  searchHotels,
  type HotelSearchResult,
} from "@/lib/hotels/queries";
import { searchRankedHotels, type MetricLine, type RankedDiscover } from "@/lib/metrics/discover-rank";
import { METRIC_LAYERS, ORDER_BELOW_FLOOR_COPY, THRESHOLD_RULES } from "@/lib/metrics/contract";
import { discoverListOutcome } from "@/lib/surfaces/list-outcome";
import {
  DISCOVER_EMPTY_BODY,
  DISCOVER_EMPTY_TITLE,
  DISCOVER_ERROR_BODY,
  DISCOVER_ERROR_TITLE,
  DISCOVER_LEDE,
  DISCOVER_NO_RESULTS_BODY,
  DISCOVER_NO_RESULTS_TITLE,
  DISCOVER_TITLE,
  LOCKED_SORT_NOTE,
  RESPONSE_INSIGHTS_PLAN,
  RESPONSE_INSIGHTS_TITLE,
  RESPONSE_INSIGHTS_USE,
  VIEW_PLANS,
} from "@/lib/screens/copy";
import { discoverFilterChips } from "@/lib/screens/discover-chips";
import { discoverSortGate } from "@/lib/screens/discover-sort";

export const metadata: Metadata = { title: "Discover" };

function rankLineFor(
  lines: ReadonlyMap<string, MetricLine> | null,
  title: string | null,
  hotelId: string,
) {
  if (!lines || !title) return null;
  const line = lines.get(hotelId);
  return line
    ? { rank: line.rank, title, valueLabel: line.valueLabel, sampleBasis: line.sampleBasis }
    : null;
}

function ResultsSummary({ result }: { result: HotelSearchResult }) {
  const shown = result.hotels.length;
  const firstIndex = (result.page - 1) * result.pageSize + 1;
  const lastIndex = firstIndex + shown - 1;
  return (
    <p role="status" aria-live="polite">
      {result.total === null
        ? `Showing ${shown} hotel${shown === 1 ? "" : "s"}`
        : `Showing ${firstIndex}\u2013${lastIndex} of ${result.total} hotel${
            result.total === 1 ? "" : "s"
          }`}
    </p>
  );
}

export default async function DiscoverPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const raw = await searchParams;
  const query = parseDiscoverQuery(raw);
  const filtersActive = hasActiveFilters(query);
  const catalog = await listDiscoverCatalog();

  let result: HotelSearchResult | null = null;
  let ranked: RankedDiscover | null = null;
  let failed = false;
  try {
    if (query.rank) {
      ranked = await searchRankedHotels(query);
      if (ranked.kind === "list") result = ranked.result;
      if (ranked.kind === "locked") {
        result = await searchHotels({ ...query, rank: null });
      }
    } else {
      result = await searchHotels(query);
    }
  } catch {
    failed = true;
    result = null;
  }

  const gate = discoverSortGate({
    rank: query.rank,
    rankedKind: ranked?.kind ?? null,
    failed,
  });
  const catalogHref = buildDiscoverHref({ ...query, rank: null, page: 1 });
  const listOutcome = discoverListOutcome({
    failed: gate === "error" || (gate !== "below_floor" && gate !== "locked" && result === null),
    count: result?.hotels.length ?? 0,
    filtered: filtersActive,
    page: query.page,
  });

  const showList = gate === "ranked" || gate === "catalog" || gate === "locked";
  const rankLines = ranked?.kind === "list" ? ranked.lines : null;
  const rankTitle = ranked?.kind === "list" ? ranked.title : null;
  const hotelIds = showList && result ? result.hotels.map((hotel) => hotel.id) : [];
  const signals = hotelIds.length > 0 ? await getPublicCardSignals(hotelIds) : new Map();
  const session = hotelIds.length > 0 ? await resolveSession() : null;
  const badges =
    session?.status === "authenticated"
      ? await loadSessionCreatorBadges(hotelIds, session.session.userId)
      : { status: "unknown" as const };

  const destinationName =
    catalog.status === "ok"
      ? (catalog.destinations.find((destination) => destination.slug === query.destination)?.name ??
        null)
      : null;
  const countryName =
    catalog.status === "ok"
      ? (catalog.countries.find((country) => country.code === query.country)?.name ?? null)
      : null;
  const chips = discoverFilterChips(query, { destinationName, countryName });

  const meta: Record<string, { name: string; line: string; href: string }> = {};
  if (result) {
    for (const hotel of result.hotels) {
      const place = [hotel.destination?.name, hotel.countryCode, hotelTypeLabel(hotel.hotelType)]
        .filter(Boolean)
        .join(" · ");
      const stars =
        hotel.starRating !== null && isPublishedStarRating(hotel.starRating)
          ? `${hotel.starRating}-star classification`
          : null;
      meta[hotel.id] = {
        name: hotel.name,
        line: [place, stars].filter(Boolean).join(" · "),
        href: `/app/hotels/${hotel.id}`,
      };
    }
  }

  const pageCount =
    result?.total !== null && result?.total !== undefined && result.pageSize > 0
      ? Math.max(1, Math.ceil(result.total / result.pageSize))
      : null;

  return (
    <DiscoverFrame
      map={
        <DiscoverMap
          pins={showList && result ? result.pins : []}
          meta={meta}
          listFailed={gate === "error"}
        />
      }
    >
      <AnalyticsPageView event="discover_viewed" />
      <div className="ux-results">
        <div className="ux-stack-sm">
          <h1 className="ux-h1">{DISCOVER_TITLE}</h1>
          <p className="ux-lede">{DISCOVER_LEDE}</p>
        </div>
        <MapToggle />
      </div>

      <DiscoverFilters
        query={query}
        destinations={catalog.status === "ok" ? catalog.destinations : []}
        countries={catalog.status === "ok" ? catalog.countries : []}
        catalogFailed={catalog.status === "error"}
      />

      {chips.length > 0 ? (
        <div className="ux-chips" aria-label="Active filters">
          {chips.map((chip) => (
            <span key={chip.key} className="ux-chip">
              {chip.label}
              <Link href={chip.removeHref} aria-label={`Remove ${chip.label}`}>
                ×
              </Link>
            </span>
          ))}
          <Link className="ux-btn ux-btn-quiet" href="/app/discover">
            Clear all
          </Link>
        </div>
      ) : null}

      <div className="ux-list-results ux-stack">
        {gate === "locked" && query.rank && METRIC_LAYERS[query.rank] === "premium" ? (
          <div className="ux-lock" id="sort-lock">
            <h2 className="ux-name">{RESPONSE_INSIGHTS_TITLE}</h2>
            <p>{RESPONSE_INSIGHTS_USE}</p>
            <p className="ux-meta">
              {RESPONSE_INSIGHTS_PLAN} {LOCKED_SORT_NOTE}
            </p>
            <Link className="ux-btn" href="/app/billing">
              {VIEW_PLANS}
            </Link>
          </div>
        ) : null}

        {gate === "below_floor" && ranked?.kind === "below_floor" ? (
          <div className="ux-stack" role="status">
            <h2 className="ux-name">Not enough data</h2>
            <p>{ORDER_BELOW_FLOOR_COPY}</p>
            <p className="ux-meta">{ranked.thresholdRule}</p>
            <Link className="ux-btn ux-btn-primary" href={catalogHref}>
              Show the catalog order
            </Link>
          </div>
        ) : null}

        {gate === "error" || listOutcome === "error" ? (
          <div className="ux-stack" role="alert">
            <h2 className="ux-name">{DISCOVER_ERROR_TITLE}</h2>
            <p>{DISCOVER_ERROR_BODY}</p>
            <Link className="ux-btn ux-btn-primary" href={buildDiscoverHref(query)}>
              Retry
            </Link>
          </div>
        ) : null}

        {showList && listOutcome === "items" && result ? (
          <div className="ux-stack">
            <ResultsSummary result={result} />
            {query.rank && ranked?.kind === "list" ? (
              <p className="ux-meta">
                {ranked.title}. One metric, not a score. {THRESHOLD_RULES[query.rank]}
              </p>
            ) : null}
            <h2 className="sr-only">Hotel results</h2>
            <ul className="ux-rows">
              {result.hotels.map((hotel) => (
                <SyncRow key={hotel.id} id={hotel.id}>
                  <HotelRow
                    hotel={hotel}
                    signal={signals?.get(hotel.id) ?? null}
                    badge={badges.status === "known" ? (badges.byHotel.get(hotel.id) ?? null) : null}
                    rankLine={rankLineFor(rankLines, rankTitle, hotel.id)}
                  />
                </SyncRow>
              ))}
            </ul>
            {(query.page > 1 || result.hasMore) && (
              <nav className="ux-page-links" aria-label="Pagination">
                {query.page > 1 ? (
                  <Link className="ux-btn" href={buildDiscoverHref({ ...query, page: query.page - 1 })}>
                    Previous
                  </Link>
                ) : (
                  <span className="ux-btn" aria-disabled="true">
                    Previous
                  </span>
                )}
                <span>
                  Page {query.page}
                  {pageCount ? ` of ${pageCount}` : ""}
                </span>
                {result.hasMore ? (
                  <Link className="ux-btn" href={buildDiscoverHref({ ...query, page: query.page + 1 })}>
                    Next
                  </Link>
                ) : (
                  <span className="ux-btn" aria-disabled="true">
                    Next
                  </span>
                )}
              </nav>
            )}
          </div>
        ) : null}

        {showList && listOutcome === "past_end" ? (
          <div className="ux-stack">
            <h2 className="ux-name">Nothing on this page</h2>
            <p className="ux-meta">You may have gone past the last page of results.</p>
            <Link className="ux-btn ux-btn-primary" href={buildDiscoverHref({ ...query, page: 1 })}>
              Back to first page
            </Link>
          </div>
        ) : null}

        {showList && listOutcome === "filtered_empty" ? (
          <div className="ux-stack">
            <h2 className="ux-name">{DISCOVER_NO_RESULTS_TITLE}</h2>
            <p>{DISCOVER_NO_RESULTS_BODY}</p>
            <Link className="ux-btn ux-btn-primary" href="/app/discover">
              Clear filters
            </Link>
          </div>
        ) : null}

        {showList && listOutcome === "empty" ? (
          <div className="ux-stack">
            <h2 className="ux-name">{DISCOVER_EMPTY_TITLE}</h2>
            <p>{DISCOVER_EMPTY_BODY}</p>
          </div>
        ) : null}
      </div>
    </DiscoverFrame>
  );
}
