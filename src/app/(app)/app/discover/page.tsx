/**
 * Discover — authenticated hotel search (PRD §7.2, §22; ROUTES.md §10).
 *
 * Search and filtering run server-side against the canonical hotel records;
 * results are bounded and paginated, so the browser never receives the whole
 * dataset. Premium contact data is never queried or rendered here.
 *
 * Map view is intentionally deferred: the canonical dataset currently has no
 * coordinates, and inventing or geocoding them is out of scope for this slice.
 * The PRD map requirement stands — this is sequencing only.
 */
import Link from "next/link";
import type { Metadata } from "next";

import { AnalyticsPageView } from "@/components/analytics-page-view";
import { EmptyState } from "@/components/empty-state";
import { DiscoverFilters } from "@/components/hotels/discover-filters";
import { HotelCard } from "@/components/hotels/hotel-card";
import {
  buildDiscoverHref,
  hasActiveFilters,
  parseDiscoverQuery,
  type RawSearchParams,
} from "@/lib/hotels/filters";
import { searchHotels, type HotelSearchResult } from "@/lib/hotels/queries";

export const metadata: Metadata = { title: "Discover" };

function ResultsSummary({ result }: { result: HotelSearchResult }) {
  const total = result.total;
  const shown = result.hotels.length;
  return (
    <p className="text-sm text-muted" role="status" aria-live="polite">
      {total === null
        ? `Showing ${shown} hotel${shown === 1 ? "" : "s"}`
        : `Showing ${shown} of ${total} hotel${total === 1 ? "" : "s"}`}
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

  let result: HotelSearchResult | null = null;
  let failed = false;
  try {
    result = await searchHotels(query);
  } catch {
    // Recoverable: keep the page usable and let the creator retry/adjust.
    failed = true;
  }

  return (
    <div className="space-y-6">
      <AnalyticsPageView event="discover_viewed" />

      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-text">Discover</h1>
        <p className="max-w-prose text-sm text-muted">
          Find editorially verified hotels worth pitching, then open a hotel to see contact and
          collaboration details.
        </p>
      </header>

      <DiscoverFilters query={query} showClear={filtersActive} />

      {failed ? (
        <EmptyState
          title="We couldn’t load hotels just now"
          description="Something went wrong fetching results. Try again, or adjust your filters."
        >
          <Link
            href={buildDiscoverHref(query)}
            className="inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
          >
            Try again
          </Link>
        </EmptyState>
      ) : result && result.hotels.length > 0 ? (
        <div className="space-y-4">
          <ResultsSummary result={result} />
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {result.hotels.map((hotel) => (
              <li key={hotel.id}>
                <HotelCard hotel={hotel} />
              </li>
            ))}
          </ul>

          {(query.page > 1 || result.hasMore) && (
            <nav aria-label="Pagination" className="flex items-center justify-between gap-3 pt-2">
              {query.page > 1 ? (
                <Link
                  href={buildDiscoverHref({ ...query, page: query.page - 1 })}
                  className="rounded-[var(--radius-app)] border border-border px-3 py-1.5 text-sm text-text hover:bg-surface"
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
                  className="rounded-[var(--radius-app)] border border-border px-3 py-1.5 text-sm text-text hover:bg-surface"
                >
                  Next
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </div>
      ) : filtersActive ? (
        <EmptyState
          title="No hotels match these filters."
          description="Try a broader search term or fewer filters."
        >
          <Link
            href="/app/discover"
            className="inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
          >
            Clear filters
          </Link>
        </EmptyState>
      ) : (
        <EmptyState
          title="No hotels available yet"
          description="Editorially verified hotels will appear here as destinations are published."
        />
      )}
    </div>
  );
}
