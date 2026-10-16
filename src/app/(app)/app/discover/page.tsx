/**
 * Discover — published canonical hotels (PRD §7.2, D013, D058, D062).
 *
 * Search is a keyword. It becomes a chip. It is not sent to a model.
 * Premium contacts are never selected. The map shows this page's pins only.
 * A locked premium sort keeps the name-ordered page and explains the lock.
 * Reply figures come from the same metric read as Hotel Detail. A short
 * sample is Insufficient data, never 0%.
 */
import Link from "next/link";
import type { Metadata } from "next";

import { AnalyticsPageView } from "@/components/analytics-page-view";
import { DiscoverFilters, DiscoverSort } from "@/components/hotels/discover-filters";
import { DiscoverFrame, SyncRow } from "@/components/hotels/discover-sync";
import { DiscoverMap } from "@/components/hotels/hotel-map";
import { HotelRow } from "@/components/hotels/hotel-row";
import { ButtonLink } from "@/components/ui/button";
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
import {
  searchRankedHotels,
  type MetricLine,
  type RankedDiscover,
} from "@/lib/metrics/discover-rank";
import { loadPageMetricSignals } from "@/lib/metrics/page-signals";
import { METRIC_LAYERS, ORDER_BELOW_FLOOR_COPY, THRESHOLD_RULES } from "@/lib/metrics/contract";
import { discoverListOutcome } from "@/lib/surfaces/list-outcome";
import {
  DISCOVER_EMPTY_BODY,
  DISCOVER_EMPTY_TITLE,
  DISCOVER_ERROR_BODY,
  DISCOVER_ERROR_TITLE,
  DISCOVER_FREE_NOTE,
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
import { discoverFigures } from "@/lib/screens/discover-figures";
import { discoverSortGate } from "@/lib/screens/discover-sort";
import {
  hotelFromDiscoverHref,
  parseDiscoverTrip,
  withDiscoverTrip,
} from "@/lib/screens/discover-return";

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
    <p className="s1-muted" role="status" aria-live="polite">
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
  const tripId = parseDiscoverTrip(raw.trip);
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
  const catalogHref = withDiscoverTrip(
    buildDiscoverHref({ ...query, rank: null, page: 1 }),
    tripId,
  );
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
  const metrics = hotelIds.length > 0 ? await loadPageMetricSignals(hotelIds) : new Map();
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
  const discoverHref = withDiscoverTrip(buildDiscoverHref(query), tripId);
  const placeLabel = destinationName ?? countryName ?? "Published hotels";
  const matchCount = result?.total ?? result?.hotels.length ?? 0;

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
      const href = hotelFromDiscoverHref(hotel.id, discoverHref) ?? `/app/hotels/${hotel.id}`;
      meta[hotel.id] = {
        name: hotel.name,
        line: [place, stars].filter(Boolean).join(" · "),
        href,
      };
    }
  }

  const pageCount =
    result?.total !== null && result?.total !== undefined && result.pageSize > 0
      ? Math.max(1, Math.ceil(result.total / result.pageSize))
      : null;

  return (
    <DiscoverFrame layout="studio" map={null}>
      <AnalyticsPageView event="discover_viewed" />
      <header className="s1-pagehead">
        <div>
          <div className="s1-eyebrow">DISCOVER / CREATOR WORKSPACE</div>
          <h1>{DISCOVER_TITLE}</h1>
          <p className="s1-lede">{DISCOVER_LEDE}</p>
        </div>
        <div className="s1-actions">
          {tripId ? (
            <ButtonLink href={`/app/trips/${tripId}`} variant="primary">
              View trip
            </ButtonLink>
          ) : (
            <ButtonLink href="/app/trips" variant="primary">
              My Trips
            </ButtonLink>
          )}
        </div>
      </header>

      {filtersActive || tripId ? (
        <div className="s1-context">
          <div>
            <strong>
              {destinationName ? `Continue exploring ${destinationName}` : "Continue this search"}
            </strong>
            <p>
              Destination, filters, trip, and this page stay in the address. Hotel Detail returns
              here.
            </p>
          </div>
          <ButtonLink href={discoverHref} size="small">
            Resume this search
          </ButtonLink>
        </div>
      ) : null}

      <section className="s1-panel s1-map">
        <div className="s1-panel-head">
          <div>
            <div className="s1-eyebrow">01 / DISCOVER ON THE MAP</div>
            <h2>
              {placeLabel}
              {showList && result
                ? ` · ${matchCount} matching hotel${matchCount === 1 ? "" : "s"}`
                : ""}
            </h2>
            <p>Area clusters represent hotels, not a collaboration score.</p>
          </div>
          {tripId ? <span className="v12-badge v12-badge-green">Trip linked</span> : null}
        </div>
        <DiscoverMap
          pins={showList && result ? result.pins : []}
          meta={meta}
          listFailed={gate === "error"}
        />
        <div className="s1-chips" aria-label="Filters">
          {chips.map((chip) => (
            <Link
              key={chip.key}
              className="v12-chip"
              href={withDiscoverTrip(chip.removeHref, tripId)}
            >
              {chip.label}
            </Link>
          ))}
          <Link
            className="v12-chip"
            href={withDiscoverTrip(
              buildDiscoverHref({ ...query, rank: "creator_activity", page: 1 }),
              tripId,
            )}
            aria-current={query.rank === "creator_activity" ? "true" : undefined}
          >
            Creator activity
          </Link>
          <Link
            className="v12-chip"
            href={withDiscoverTrip(
              buildDiscoverHref({ ...query, rank: "response_rate", page: 1 }),
              tripId,
            )}
            aria-current={query.rank === "response_rate" ? "true" : undefined}
          >
            Reply rate · Pro
          </Link>
          <Link
            className="v12-chip"
            href={withDiscoverTrip(
              buildDiscoverHref({ ...query, rank: "response_time", page: 1 }),
              tripId,
            )}
            aria-current={query.rank === "response_time" ? "true" : undefined}
          >
            Faster replies · Pro
          </Link>
        </div>
      </section>

      <DiscoverFilters
        query={query}
        destinations={catalog.status === "ok" ? catalog.destinations : []}
        countries={catalog.status === "ok" ? catalog.countries : []}
        catalogFailed={catalog.status === "error"}
        tripId={tripId}
      />

      {chips.length > 0 ? (
        <div className="s1-chips" aria-label="Active filters">
          {chips.map((chip) => (
            <span key={chip.key} className="v12-chip">
              {chip.label}
              <Link
                href={withDiscoverTrip(chip.removeHref, tripId)}
                aria-label={`Remove ${chip.label}`}
              >
                ×
              </Link>
            </span>
          ))}
          <Link className="v12-btn v12-btn-ghost" href={withDiscoverTrip("/app/discover", tripId)}>
            Clear all
          </Link>
        </div>
      ) : null}

      <div className="ux-list-results">
        <div className="s1-subhead">
          <div>
            <h2>Hotels to explore</h2>
            {showList && listOutcome === "items" && result ? (
              <ResultsSummary result={result} />
            ) : null}
          </div>
          <DiscoverSort query={query} tripId={tripId} />
        </div>

        {gate === "locked" && query.rank && METRIC_LAYERS[query.rank] === "premium" ? (
          <div className="v12-state v12-state-locked" id="sort-lock">
            <h2>{RESPONSE_INSIGHTS_TITLE}</h2>
            <p>{RESPONSE_INSIGHTS_USE}</p>
            <p>
              {RESPONSE_INSIGHTS_PLAN} {LOCKED_SORT_NOTE}
            </p>
            <Link className="v12-btn v12-btn-primary" href="/app/billing">
              {VIEW_PLANS}
            </Link>
          </div>
        ) : null}

        {gate === "below_floor" && ranked?.kind === "below_floor" ? (
          <div className="v12-state" role="status">
            <h2>Insufficient data</h2>
            <p>{ORDER_BELOW_FLOOR_COPY}</p>
            <p>{ranked.thresholdRule}</p>
            <Link className="v12-btn v12-btn-primary" href={catalogHref}>
              Show the catalog order
            </Link>
          </div>
        ) : null}

        {gate === "error" || listOutcome === "error" ? (
          <div className="v12-state v12-state-danger" role="alert">
            <h2>{DISCOVER_ERROR_TITLE}</h2>
            <p>{DISCOVER_ERROR_BODY}</p>
            <Link className="v12-btn v12-btn-primary" href={discoverHref}>
              Retry
            </Link>
          </div>
        ) : null}

        {showList && listOutcome === "items" && result ? (
          <div>
            {query.rank && ranked?.kind === "list" ? (
              <p className="s1-muted">
                {ranked.title}. One metric, not a score. {THRESHOLD_RULES[query.rank]}
              </p>
            ) : null}
            <h2 className="sr-only">Hotel results</h2>
            <ul className="s1-rows s1-list">
              {result.hotels.map((hotel) => (
                <SyncRow key={hotel.id} id={hotel.id}>
                  <HotelRow
                    hotel={hotel}
                    signal={signals?.get(hotel.id) ?? null}
                    badge={
                      badges.status === "known" ? (badges.byHotel.get(hotel.id) ?? null) : null
                    }
                    rankLine={rankLineFor(rankLines, rankTitle, hotel.id)}
                    href={meta[hotel.id]?.href ?? `/app/hotels/${hotel.id}`}
                    figures={discoverFigures(metrics.get(hotel.id))}
                  />
                </SyncRow>
              ))}
            </ul>
            {(query.page > 1 || result.hasMore) && (
              <nav className="ux-page-links" aria-label="Pagination">
                {query.page > 1 ? (
                  <Link
                    className="v12-btn"
                    href={withDiscoverTrip(
                      buildDiscoverHref({ ...query, page: query.page - 1 }),
                      tripId,
                    )}
                  >
                    Previous
                  </Link>
                ) : (
                  <span className="v12-btn" aria-disabled="true">
                    Previous
                  </span>
                )}
                <span>
                  Page {query.page}
                  {pageCount ? ` of ${pageCount}` : ""}
                </span>
                {result.hasMore ? (
                  <Link
                    className="v12-btn"
                    href={withDiscoverTrip(
                      buildDiscoverHref({ ...query, page: query.page + 1 }),
                      tripId,
                    )}
                  >
                    Next
                  </Link>
                ) : (
                  <span className="v12-btn" aria-disabled="true">
                    Next
                  </span>
                )}
              </nav>
            )}
          </div>
        ) : null}

        {showList && listOutcome === "past_end" ? (
          <div className="v12-state">
            <h2>Nothing on this page</h2>
            <p>You may have gone past the last page of results.</p>
            <Link
              className="v12-btn v12-btn-primary"
              href={withDiscoverTrip(buildDiscoverHref({ ...query, page: 1 }), tripId)}
            >
              Back to first page
            </Link>
          </div>
        ) : null}

        {showList && listOutcome === "filtered_empty" ? (
          <div className="v12-state">
            <h2>{DISCOVER_NO_RESULTS_TITLE}</h2>
            <p>{DISCOVER_NO_RESULTS_BODY}</p>
            <Link
              className="v12-btn v12-btn-primary"
              href={withDiscoverTrip("/app/discover", tripId)}
            >
              Clear filters
            </Link>
          </div>
        ) : null}

        {showList && listOutcome === "empty" ? (
          <div className="v12-state">
            <h2>{DISCOVER_EMPTY_TITLE}</h2>
            <p>{DISCOVER_EMPTY_BODY}</p>
          </div>
        ) : null}
      </div>
      <p className="s1-callout">
        <strong>Free vs Pro / Max.</strong> {DISCOVER_FREE_NOTE}
      </p>
    </DiscoverFrame>
  );
}
