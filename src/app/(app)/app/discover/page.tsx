/**
 * Discover — published canonical hotels (PRD §7.2, D013, D058, D062).
 *
 * Search runs server-side against hotels that meet the column-visible
 * publishability predicate. Premium contacts are never selected. Public
 * intelligence is rendered only when the public projection disclosed it.
 * The viewer's pipeline and trip badges come from their own rows.
 *
 * The map shows the hotels on this filtered page (D079). A missing Maps key
 * leaves the slot empty, with no error. Pins are public locations only.
 */
import Link from "next/link";
import type { Metadata } from "next";

import { AnalyticsPageView } from "@/components/analytics-page-view";
import { EmptyState } from "@/components/empty-state";
import { DiscoverFilters } from "@/components/hotels/discover-filters";
import { HotelCard } from "@/components/hotels/hotel-card";
import { HotelMap } from "@/components/hotels/hotel-map";
import { resolveSession } from "@/lib/auth/guards";
import {
  buildDiscoverHref,
  hasActiveFilters,
  parseDiscoverQuery,
  type RawSearchParams,
} from "@/lib/hotels/filters";
import {
  getPublicCardSignals,
  listDiscoverCatalog,
  loadSessionCreatorBadges,
  searchHotels,
  type HotelSearchResult,
} from "@/lib/hotels/queries";

export const metadata: Metadata = { title: "Discover" };

function ResultsSummary({ result }: { result: HotelSearchResult }) {
  const shown = result.hotels.length;
  const firstIndex = (result.page - 1) * result.pageSize + 1;
  const lastIndex = firstIndex + shown - 1;
  return (
    <p className="text-sm text-muted" role="status" aria-live="polite">
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
  let failed = false;
  try {
    result = await searchHotels(query);
  } catch {
    failed = true;
  }

  const hotelIds = result?.hotels.map((hotel) => hotel.id) ?? [];
  const signals = hotelIds.length > 0 ? await getPublicCardSignals(hotelIds) : new Map();
  const session = hotelIds.length > 0 ? await resolveSession() : null;
  const badges =
    session?.status === "authenticated"
      ? await loadSessionCreatorBadges(hotelIds, session.session.userId)
      : { status: "unknown" as const };

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
      <div className="space-y-6">
        <AnalyticsPageView event="discover_viewed" />

        <header className="space-y-1">
          <h1 className="text-2xl font-semibold text-text">Discover</h1>
          <p className="max-w-prose text-sm text-muted">
            Published hotels, by destination. Creator activity appears only when the public record
            is strong enough to show.
          </p>
        </header>

        <DiscoverFilters
          query={query}
          showClear={filtersActive}
          destinations={catalog.status === "ok" ? catalog.destinations : []}
          countries={catalog.status === "ok" ? catalog.countries : []}
          catalogFailed={catalog.status === "error"}
        />

        {failed ? (
          <EmptyState
            title="We couldn’t load hotels just now"
            description="Something went wrong fetching results. Try again, or adjust your filters."
          >
            <Link
              href={buildDiscoverHref(query)}
              className="inline-flex bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
            >
              Try again
            </Link>
          </EmptyState>
        ) : result && result.hotels.length > 0 ? (
          <div className="space-y-3">
            <h2 className="sr-only">Hotel results</h2>
            <ResultsSummary result={result} />
            <ul className="divide-y divide-border border-y border-border">
              {result.hotels.map((hotel) => (
                <li key={hotel.id}>
                  <HotelCard
                    hotel={hotel}
                    signal={signals?.get(hotel.id) ?? null}
                    badge={
                      badges.status === "known" ? (badges.byHotel.get(hotel.id) ?? null) : null
                    }
                  />
                </li>
              ))}
            </ul>

            {(query.page > 1 || result.hasMore) && (
              <nav aria-label="Pagination" className="flex items-center justify-between gap-3 pt-2">
                {query.page > 1 ? (
                  <Link
                    href={buildDiscoverHref({ ...query, page: query.page - 1 })}
                    className="border border-border px-3 py-1.5 text-sm text-text hover:bg-surface"
                  >
                    Previous
                  </Link>
                ) : (
                  <span />
                )}
                <span className="text-sm text-muted">Page {query.page}</span>
                {result.hasMore ? (
                  <Link
                    href={buildDiscoverHref({ ...query, page: query.page + 1 })}
                    className="border border-border px-3 py-1.5 text-sm text-text hover:bg-surface"
                  >
                    Next
                  </Link>
                ) : (
                  <span />
                )}
              </nav>
            )}
          </div>
        ) : query.page > 1 ? (
          <EmptyState
            title="Nothing on this page"
            description="You may have gone past the last page of results."
          >
            <Link
              href={buildDiscoverHref({ ...query, page: 1 })}
              className="inline-flex bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
            >
              Back to first page
            </Link>
          </EmptyState>
        ) : filtersActive ? (
          <EmptyState
            title="No hotels match these filters."
            description="Try a broader search or fewer filters."
          >
            <Link
              href="/app/discover"
              className="inline-flex bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
            >
              Clear filters
            </Link>
          </EmptyState>
        ) : (
          <EmptyState
            title="No published hotels yet"
            description="Hotels appear here once they are in the published catalog."
          />
        )}
      </div>
      {result && result.pins.length > 0 ? <HotelMap pins={result.pins} /> : null}
    </div>
  );
}
