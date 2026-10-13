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
import { PageHeader } from "@/components/shell/page-header";
import { listCrumbs, pitchHref, tripHotelHref } from "@/lib/shell/navigation";
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

function pipelinePageParam(raw: string | null): number {
  if (!raw || !/^\d+$/.test(raw)) return 1;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return 1;
  return parsed;
}

function workspaceHref(
  tripId: string,
  params: { q?: string | null; pipeline?: string | null; pipelinePage?: number },
): string {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.pipeline) search.set("pipeline", params.pipeline);
  if (params.pipelinePage && params.pipelinePage > 1) {
    search.set("pipeline_page", String(params.pipelinePage));
  }
  const qs = search.toString();
  return qs ? `/app/trips/${tripId}?${qs}` : `/app/trips/${tripId}`;
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
  const hotelQuery = sanitizeSearchTerm(first(raw.q));
  const pipelineQuery = sanitizeSearchTerm(first(raw.pipeline));
  const pipelinePage = pipelinePageParam(first(raw.pipeline_page));

  const [summary, shortlist, pipeline, destinations] = await Promise.all([
    getTripSummary(trip.id),
    listShortlist(trip.id),
    listLinkablePipelineItems({ query: pipelineQuery, page: pipelinePage }),
    listDestinations(),
  ]);

  const discoverHref = buildDiscoverHref({ destination: trip.destinationSlug });
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
      <PageHeader
        title={title}
        description={`${trip.destinationName} · ${trip.startDate} – ${trip.endDate} · ${tripStatusLabel(trip.status)} · ${trip.visibility === "private" ? "Private" : "Public"}`}
        crumbs={listCrumbs(title, { href: "/app/trips", label: "Trips" })}
        back={{ href: "/app/trips", label: "Trips" }}
      />
      <header className="space-y-2">
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
            {shortlist.hotels.map((hotel) => {
              const href = tripHotelHref(trip.id, hotel.id);
              const pitch = pitchHref(hotel.id, trip.id);
              return (
                <li
                  key={hotel.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-app)] border border-border bg-surface px-4 py-3"
                >
                  {href ? (
                    <Link href={href} className="text-sm font-medium text-text">
                      {hotel.name}
                    </Link>
                  ) : (
                    <span className="text-sm font-medium text-text">{hotel.name}</span>
                  )}
                  <span className="flex items-center gap-3">
                    {pitch ? (
                      <Link href={pitch} className="text-sm text-text underline">
                        Pitch
                      </Link>
                    ) : null}
                    <ShortlistRemoveButton tripId={trip.id} hotelId={hotel.id} />
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        <form
          action={`/app/trips/${trip.id}`}
          method="get"
          className="flex flex-wrap gap-2"
          role="search"
        >
          {pipelineQuery ? <input type="hidden" name="pipeline" value={pipelineQuery} /> : null}
          {pipeline.status === "ok" && pipeline.page > 1 ? (
            <input type="hidden" name="pipeline_page" value={String(pipeline.page)} />
          ) : null}
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
        <form
          action={`/app/trips/${trip.id}`}
          method="get"
          className="flex flex-wrap gap-2"
          role="search"
        >
          {hotelQuery ? <input type="hidden" name="q" value={hotelQuery} /> : null}
          <label className="sr-only" htmlFor="pipeline-q">
            Find a pipeline hotel
          </label>
          <input
            id="pipeline-q"
            name="pipeline"
            type="search"
            defaultValue={pipelineQuery ?? ""}
            placeholder="Find a pipeline hotel"
            className="min-w-0 flex-1 rounded-[var(--radius-app)] border border-border bg-background px-3 py-2 text-sm text-text"
          />
          <button
            type="submit"
            className="rounded-[var(--radius-app)] border border-border px-4 py-2 text-sm font-medium text-text"
          >
            Find
          </button>
        </form>
        {pipeline.status === "error" ? (
          <p className="text-sm text-muted">We couldn’t load your pipeline. Reload to try again.</p>
        ) : pipeline.items.length === 0 ? (
          <p className="text-sm text-muted">
            {pipeline.query
              ? "No pipeline hotels matched that search."
              : pipeline.page > 1
                ? "No more pipeline items on this page."
                : "You don’t have pipeline items to link yet. Save a hotel from Discover first."}
          </p>
        ) : (
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
        )}
        {pipeline.status === "ok" && (pipeline.hasPrevious || pipeline.hasNext) ? (
          <p className="flex flex-wrap items-center gap-3 text-sm text-muted">
            <span>Page {pipeline.page}</span>
            {pipeline.hasPrevious ? (
              <Link
                href={workspaceHref(trip.id, {
                  q: hotelQuery,
                  pipeline: pipeline.query,
                  pipelinePage: pipeline.page - 1,
                })}
                className="underline hover:text-text"
              >
                Newer
              </Link>
            ) : null}
            {pipeline.hasNext ? (
              <Link
                href={workspaceHref(trip.id, {
                  q: hotelQuery,
                  pipeline: pipeline.query,
                  pipelinePage: pipeline.page + 1,
                })}
                className="underline hover:text-text"
              >
                Older
              </Link>
            ) : null}
          </p>
        ) : null}
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
