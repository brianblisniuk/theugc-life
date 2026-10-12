/**
 * Trip workspace (PRD §7.5, ROUTES.md `/app/trips/[id]`).
 *
 * A missing trip and another creator's trip are the same response: not found.
 * The summary is derived from pipeline and collaboration rows linked by
 * trip_id. Unknown is not shown as zero. A failed summary read is an error,
 * not a row of unknowns.
 */
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/empty-state";
import {
  PipelineLinkButton,
  ShortlistAddButton,
  ShortlistRemoveButton,
  TripDeleteForm,
  TripEditForm,
} from "@/components/trips/trip-forms";
import { buildDiscoverHref, parseDiscoverQuery, sanitizeSearchTerm } from "@/lib/hotels/filters";
import { searchHotels } from "@/lib/hotels/queries";
import { pipelineStatusLabel } from "@/lib/pipeline/types";
import { formatTripMetric, TRIP_METRIC_LABELS } from "@/lib/trips/display";
import {
  getTrip,
  getTripSummary,
  listDestinations,
  listLinkablePipelineItems,
  listShortlist,
} from "@/lib/trips/queries";
import { tripStatusLabel, type TripMetrics } from "@/lib/trips/types";

export const metadata: Metadata = { title: "Trip" };

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function Summary({ metrics }: { metrics: TripMetrics }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {TRIP_METRIC_LABELS.map(([key, label]) => (
        <div key={key} className="rounded-[var(--radius-app)] border border-border bg-surface p-4">
          <dt className="text-xs font-medium text-muted">{label}</dt>
          <dd className="mt-1 text-lg font-semibold text-text">{formatTripMetric(metrics[key])}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function TripWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const raw = await searchParams;
  const loaded = await getTrip(id);
  if (loaded.status === "error") {
    return (
      <EmptyState
        title="We couldn’t load this trip"
        description="Something went wrong on our side. Reload the page to try again."
      />
    );
  }
  if (!loaded.trip) notFound();
  const trip = loaded.trip;

  const [summary, shortlist, pipeline, destinations] = await Promise.all([
    getTripSummary(trip.id),
    listShortlist(trip.id),
    listLinkablePipelineItems(),
    listDestinations(),
  ]);

  const discoverHref = buildDiscoverHref({ destination: trip.destinationSlug });
  const hotelQuery = sanitizeSearchTerm(first(raw.q));
  let hotelMatches: { id: string; name: string }[] = [];
  let hotelSearchFailed = false;
  if (hotelQuery) {
    try {
      const result = await searchHotels(
        parseDiscoverQuery({ q: hotelQuery, destination: trip.destinationSlug, pageSize: "8" }),
      );
      hotelMatches = result.hotels.map((hotel) => ({ id: hotel.id, name: hotel.name }));
    } catch {
      hotelSearchFailed = true;
    }
  }

  const title = trip.name ?? trip.destinationName;

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <p className="text-sm text-muted">
          <Link href="/app/trips" className="underline hover:text-text">
            Trips
          </Link>
        </p>
        <h1 className="text-2xl font-semibold text-text">{title}</h1>
        <p className="text-sm text-muted">
          {trip.destinationName} · {trip.startDate} – {trip.endDate} ·{" "}
          {tripStatusLabel(trip.status)} · {trip.visibility === "private" ? "Private" : "Public"}
        </p>
        <Link
          href={discoverHref}
          className="inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
        >
          Discover hotels in {trip.destinationName}
        </Link>
      </header>

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-text">This trip</h2>
        {summary.status === "error" ? (
          <EmptyState
            title="We couldn’t load the summary"
            description="Something went wrong reading pipeline and collaboration state. Reload to try again."
          />
        ) : summary.status === "not_found" ? (
          <EmptyState
            title="We couldn’t load the summary"
            description="This trip isn’t available."
          />
        ) : (
          <>
            <Summary metrics={summary.metrics} />
            {summary.metrics.targetHotels === null ? (
              <p className="text-sm text-muted">
                Unknown means no pipeline items are linked to this trip yet. It is not a count of
                zero.
              </p>
            ) : null}
          </>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-text">Shortlist</h2>
        {shortlist.status === "error" ? (
          <p className="text-sm text-muted">We couldn’t load the shortlist. Reload to try again.</p>
        ) : shortlist.hotels.length === 0 ? (
          <p className="text-sm text-muted">No hotels shortlisted yet.</p>
        ) : (
          <ul className="space-y-2">
            {shortlist.hotels.map((hotel) => (
              <li
                key={hotel.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-app)] border border-border bg-surface px-4 py-3"
              >
                <Link href={`/app/hotels/${hotel.id}`} className="text-sm font-medium text-text">
                  {hotel.name}
                </Link>
                <ShortlistRemoveButton tripId={trip.id} hotelId={hotel.id} />
              </li>
            ))}
          </ul>
        )}

        <form
          action={`/app/trips/${trip.id}`}
          method="get"
          className="flex flex-wrap gap-2"
          role="search"
        >
          <label className="sr-only" htmlFor="shortlist-q">
            Search hotels in {trip.destinationName}
          </label>
          <input
            id="shortlist-q"
            name="q"
            type="search"
            defaultValue={hotelQuery ?? ""}
            placeholder={`Search hotels in ${trip.destinationName}`}
            className="min-w-0 flex-1 rounded-[var(--radius-app)] border border-border bg-background px-3 py-2 text-sm text-text"
          />
          <button
            type="submit"
            className="rounded-[var(--radius-app)] border border-border px-4 py-2 text-sm font-medium text-text"
          >
            Search
          </button>
        </form>
        {hotelSearchFailed ? (
          <p className="text-sm text-muted">We couldn’t search hotels. Try again.</p>
        ) : hotelQuery && hotelMatches.length === 0 ? (
          <p className="text-sm text-muted">
            No published hotels matched that search in this destination.
          </p>
        ) : (
          <ul className="space-y-2">
            {hotelMatches.map((hotel) => (
              <li
                key={hotel.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-app)] border border-border px-4 py-3"
              >
                <span className="text-sm text-text">{hotel.name}</span>
                <ShortlistAddButton tripId={trip.id} hotelId={hotel.id} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-text">Pipeline on this trip</h2>
        {pipeline.status === "error" ? (
          <p className="text-sm text-muted">We couldn’t load your pipeline. Reload to try again.</p>
        ) : pipeline.items.length === 0 ? (
          <p className="text-sm text-muted">
            You don’t have pipeline items to link yet. Save a hotel from Discover first.
          </p>
        ) : (
          <>
            <ul className="space-y-2">
              {pipeline.items.map((item) => {
                const linked = item.tripId === trip.id;
                return (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-app)] border border-border bg-surface px-4 py-3"
                  >
                    <div>
                      <p className="text-sm font-medium text-text">{item.hotelName}</p>
                      <p className="text-xs text-muted">
                        {pipelineStatusLabel(item.status)}
                        {linked
                          ? " · Linked to this trip"
                          : item.tripId
                            ? " · Linked to another trip"
                            : ""}
                      </p>
                    </div>
                    <PipelineLinkButton tripId={trip.id} pipelineItemId={item.id} linked={linked} />
                  </li>
                );
              })}
            </ul>
            {pipeline.truncated ? (
              <p className="text-sm text-muted">
                Showing the 100 most recently active pipeline items.
              </p>
            ) : null}
          </>
        )}
      </section>

      <section className="space-y-4 rounded-[var(--radius-app)] border border-border bg-surface p-4">
        <h2 className="text-base font-semibold text-text">Trip details</h2>
        {destinations.status === "error" ? (
          <p className="text-sm text-muted">
            We couldn’t load destinations. Reload to edit this trip.
          </p>
        ) : (
          <TripEditForm
            trip={{
              id: trip.id,
              name: trip.name,
              destinationId: trip.destinationId,
              startDate: trip.startDate,
              endDate: trip.endDate,
              status: trip.status,
            }}
            destinations={destinations.destinations}
          />
        )}
        <TripDeleteForm tripId={trip.id} />
      </section>
    </div>
  );
}
