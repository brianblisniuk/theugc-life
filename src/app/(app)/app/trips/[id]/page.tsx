/**
 * Trip workspace. A missing trip and another creator's trip are both not found.
 * Stays are set by the creator. A Gmail suggestion is accepted or rejected
 * here and does not change pending or confirmed by itself.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  PipelineLinkButton,
  ShortlistAddButton,
  ShortlistRemoveButton,
  TripDeleteForm,
  TripEditForm,
} from "@/components/trips/trip-forms";
import { StayForm, SuggestionDecisionForm } from "@/components/trips/stay-forms";
import {
  CreateOutreachForm,
  OpenOpportunityForm,
  OpportunityDatesForm,
} from "@/components/outreach/campaign-forms";
import { Badge, SourceBadge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { buildDiscoverHref, parseDiscoverQuery, sanitizeSearchTerm } from "@/lib/hotels/filters";
import { searchHotels } from "@/lib/hotels/queries";
import { stageTone, stageWord } from "@/lib/outreach/board";
import { pitchHref, tripHotelHref } from "@/lib/shell/navigation";
import { coverNights, formatStay, monthName, nightCountsMatch } from "@/lib/trips/nights";
import {
  getTrip,
  getTripSummary,
  listDestinations,
  listLinkablePipelineItems,
  listShortlist,
  listStaySuggestions,
  listTripCampaigns,
  listTripOpportunities,
  listTrips,
  readNightCoverage,
} from "@/lib/trips/queries";
import { formatTripMetric, TRIP_METRIC_LABELS } from "@/lib/trips/display";
import { pipelineStatusLabel } from "@/lib/pipeline/types";
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
    <dl className="v12-stats">
      {TRIP_METRIC_LABELS.map(([key, label]) => (
        <div key={key} className="v12-stat">
          <dt className="v12-stat-label">{label}</dt>
          <dd className="v12-stat-num">{formatTripMetric(metrics[key])}</dd>
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
      <ErrorState
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

  const [summary, shortlist, pipeline, destinations, coverage, opportunities, campaigns, allTrips] =
    await Promise.all([
      getTripSummary(trip.id),
      listShortlist(trip.id),
      listLinkablePipelineItems({ query: pipelineQuery, page: pipelinePage }),
      listDestinations(),
      readNightCoverage(trip.id),
      listTripOpportunities(trip.id),
      listTripCampaigns(trip.id),
      listTrips(),
    ]);

  const suggestions = await listStaySuggestions({
    tripHotelIds:
      shortlist.status === "ok" ? shortlist.hotels.map((hotel) => hotel.tripHotelId) : [],
    pipelineItemIds:
      opportunities.status === "ok" ? opportunities.opportunities.map((item) => item.id) : [],
  });

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

  const title = trip.name?.trim() || trip.destinationName;
  const month = monthName(trip.startDate);
  const calendar =
    shortlist.status === "ok"
      ? coverNights(
          trip.startDate,
          trip.endDate,
          shortlist.hotels.map((hotel) => ({
            checkIn: hotel.checkIn,
            checkOut: hotel.checkOut,
            nightStatus: hotel.nightStatus,
          })),
        )
      : null;
  const calendarMatches =
    calendar !== null && coverage.status === "ok" && nightCountsMatch(calendar, coverage);
  const tripChoices =
    allTrips.status === "ok"
      ? allTrips.trips.map((item) => ({
          id: item.id,
          label: `${item.name?.trim() || item.destinationName} · ${item.startDate}`,
        }))
      : [];
  const destinationChoices =
    destinations.status === "ok"
      ? destinations.destinations.map((destination) => ({
          id: destination.id,
          name: destination.name,
        }))
      : [];

  return (
    <div className="v12-stack">
      <header className="v12-pagehead">
        <div>
          <div className="v12-eyebrow">My Trips / {trip.destinationName}</div>
          <h1>
            {title}
            {month ? ` · ${month}` : ""}
          </h1>
          <p>
            {trip.startDate}–{trip.endDate} · {tripStatusLabel(trip.status)} ·{" "}
            {trip.visibility === "private" ? "Private" : "Public"}
          </p>
        </div>
        <div className="v12-head-actions">
          <ButtonLink href={discoverHref}>Explore hotels</ButtonLink>
          {campaigns.status === "ok" && campaigns.campaigns[0] ? (
            <ButtonLink href={`/app/outreach/${campaigns.campaigns[0].id}`} variant="primary">
              Continue outreach
            </ButtonLink>
          ) : (
            <ButtonLink href="#start-outreach" variant="primary">
              Start outreach
            </ButtonLink>
          )}
        </div>
      </header>

      {coverage.status === "ok" ? (
        <div className="v12-stats">
          <div className="v12-stat">
            <div className="v12-stat-label">Travel nights</div>
            <div className="v12-stat-num">{coverage.tripNights}</div>
            <div className="v12-stat-note">
              {trip.startDate}–{trip.endDate}
            </div>
          </div>
          <div className="v12-stat v12-stat-tint">
            <div className="v12-stat-label">Confirmed</div>
            <div className="v12-stat-num">{coverage.confirmedNights}</div>
            <div className="v12-stat-note">Recorded hotel stay</div>
          </div>
          <div className="v12-stat">
            <div className="v12-stat-label">Pending</div>
            <div className="v12-stat-num">{coverage.pendingNights}</div>
            <div className="v12-stat-note">Not counted as secured</div>
          </div>
          <div className="v12-stat">
            <div className="v12-stat-label">Uncovered</div>
            <div className="v12-stat-num">{coverage.gapNights}</div>
            <div className="v12-stat-note">Still need accommodation</div>
          </div>
        </div>
      ) : (
        <ErrorState
          title="We couldn’t load night coverage"
          description="Reload to read the saved stays. This is not zero nights."
        />
      )}

      <section className="v12-card v12-card-pad">
        <div className="v12-panel-head">
          <div>
            <h2>Accommodation coverage</h2>
            <p>You set check-in and check-out, the way a booking does. Pending is not covered.</p>
          </div>
          {coverage.status === "ok" ? (
            <Badge tone="green">
              {coverage.confirmedNights} / {coverage.tripNights} confirmed
            </Badge>
          ) : null}
        </div>
        {calendarMatches && calendar ? (
          <div className="v12-nights">
            {calendar.nights.map((night) => (
              <div key={night.date} className={`v12-night v12-night-${night.mark}`}>
                <strong>{night.day}</strong>
                <span>
                  {night.mark === "gap"
                    ? "Gap"
                    : night.mark === "pending"
                      ? "Pending"
                      : "Confirmed"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <ErrorState
            title="We couldn’t draw the nights"
            description="The shortlist and the coverage read have to agree. Reload to try again."
          />
        )}
        {calendar && calendar.nights.length === 0 && calendarMatches ? (
          <p>This trip starts and ends on the same day, so it has no nights.</p>
        ) : null}
      </section>

      {suggestions.status === "error" ? (
        <ErrorState
          title="We couldn’t load date suggestions"
          description="Reload to try again. A missing list is not a decision."
        />
      ) : suggestions.suggestions.length > 0 ? (
        <section className="v12-card v12-card-pad">
          <h2>Gmail suggested other dates</h2>
          <p>
            Accepting copies the dates onto that one stay or opportunity. It does not change pending
            or confirmed. Rejecting leaves the saved dates.
          </p>
          <ul className="v12-plain-list">
            {suggestions.suggestions.map((suggestion) => {
              const hotel =
                shortlist.status === "ok"
                  ? shortlist.hotels.find((item) => item.tripHotelId === suggestion.tripHotelId)
                  : undefined;
              const opportunity =
                opportunities.status === "ok"
                  ? opportunities.opportunities.find(
                      (item) => item.id === suggestion.pipelineItemId,
                    )
                  : undefined;
              const when = formatStay(suggestion.checkIn, suggestion.checkOut);
              return (
                <li key={suggestion.id} className="v12-list-item">
                  <div className="v12-row">
                    <div>
                      <strong>{hotel?.name ?? opportunity?.hotelName ?? "Stay"}</strong>
                      <p>
                        {opportunity ? `${opportunity.displayRef} · ` : ""}
                        {when ?? `${suggestion.checkIn}–${suggestion.checkOut}`}
                      </p>
                    </div>
                    <SourceBadge source="gmail" />
                  </div>
                  <SuggestionDecisionForm suggestionId={suggestion.id} tripId={trip.id} />
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="v12-card v12-card-pad">
        <h2>Hotels in your shortlist</h2>
        {shortlist.status === "error" ? (
          <ErrorState
            title="We couldn’t load the shortlist"
            description="Reload to try again. This is not an empty shortlist."
          />
        ) : shortlist.hotels.length === 0 ? (
          <EmptyState
            title="No hotels shortlisted yet"
            description="Search this destination below, or save a hotel from Discover."
          />
        ) : (
          <ul className="v12-plain-list">
            {shortlist.hotels.map((hotel) => {
              const href = tripHotelHref(trip.id, hotel.id);
              const pitch = pitchHref(hotel.id, trip.id);
              const rows =
                opportunities.status === "ok"
                  ? opportunities.opportunities.filter((item) => item.hotelId === hotel.id)
                  : [];
              return (
                <li key={hotel.tripHotelId} className="v12-list-item">
                  <div className="v12-row">
                    <div>
                      {href ? (
                        <strong>
                          <Link href={href}>{hotel.name}</Link>
                        </strong>
                      ) : (
                        <strong>{hotel.name}</strong>
                      )}
                      <p>
                        {rows.length > 0
                          ? rows
                              .map((row) => `${row.displayRef} · ${stageWord(row.status)}`)
                              .join(" · ")
                          : "No opportunity yet"}
                      </p>
                    </div>
                    <span className="v12-row">
                      {pitch ? (
                        <ButtonLink href={pitch} size="small">
                          Pitch
                        </ButtonLink>
                      ) : null}
                      <ShortlistRemoveButton tripId={trip.id} hotelId={hotel.id} />
                    </span>
                  </div>
                  <StayForm
                    tripId={trip.id}
                    hotelId={hotel.id}
                    checkIn={hotel.checkIn}
                    checkOut={hotel.checkOut}
                    nightStatus={hotel.nightStatus}
                  />
                  <OpenOpportunityForm
                    hotelId={hotel.id}
                    tripId={trip.id}
                    initiativeId={null}
                    label={
                      rows.some((row) => row.status !== "closed")
                        ? "Another opportunity"
                        : "Open opportunity"
                    }
                  />
                </li>
              );
            })}
          </ul>
        )}

        <form action={`/app/trips/${trip.id}`} method="get" className="v12-form-grid" role="search">
          {pipelineQuery ? <input type="hidden" name="pipeline" value={pipelineQuery} /> : null}
          <label className="v12-field" htmlFor="shortlist-q">
            <span>Search hotels in {trip.destinationName}</span>
            <input id="shortlist-q" name="q" type="search" defaultValue={hotelQuery ?? ""} />
          </label>
          <button type="submit" className="v12-btn">
            Search
          </button>
        </form>
        {hotelSearchFailed ? (
          <ErrorState title="We couldn’t search hotels" description="Try again." />
        ) : hotelQuery && hotelMatches.length === 0 ? (
          <p>No published hotels matched that search in this destination.</p>
        ) : (
          <ul className="v12-plain-list">
            {hotelMatches.map((hotel) => (
              <li key={hotel.id} className="v12-list-item">
                <div className="v12-row">
                  <span>{hotel.name}</span>
                  <ShortlistAddButton tripId={trip.id} hotelId={hotel.id} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="v12-card v12-card-pad">
        <h2>Opportunities on this trip</h2>
        <p>
          Two open opportunities for the same hotel are allowed when the previous one is closed, the
          dates do not overlap, or they belong to different trips. An undated open opportunity
          covers the whole trip.
        </p>
        {opportunities.status === "error" ? (
          <ErrorState
            title="We couldn’t load opportunities"
            description="Reload to try again. This is not an empty pipeline."
          />
        ) : opportunities.opportunities.length === 0 ? (
          <EmptyState
            title="No opportunities on this trip"
            description="Opening one is separate from shortlisting a hotel."
          />
        ) : (
          <ul className="v12-plain-list">
            {opportunities.opportunities.map((item) => (
              <li key={item.id} className="v12-list-item">
                <div className="v12-row">
                  <div>
                    <strong>
                      {item.displayRef} · {item.hotelName}
                    </strong>
                    <p>
                      {item.stayStart && item.stayEnd
                        ? formatStay(item.stayStart, item.stayEnd)
                        : "No dates yet"}
                    </p>
                  </div>
                  <Badge tone={stageTone(item.status)}>{stageWord(item.status)}</Badge>
                </div>
                <OpportunityDatesForm
                  pipelineItemId={item.id}
                  tripId={trip.id}
                  initiativeId={null}
                  stayStart={item.stayStart}
                  stayEnd={item.stayEnd}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="v12-card v12-card-pad">
        <h2>This trip</h2>
        {summary.status === "error" || summary.status === "not_found" ? (
          <ErrorState
            title="We couldn’t load the summary"
            description="Something went wrong reading pipeline and collaboration state. Reload to try again."
          />
        ) : (
          <>
            <Summary metrics={summary.metrics} />
            {summary.metrics.targetHotels === null ? (
              <p>
                Unknown means no pipeline items are linked to this trip yet. It is not a count of
                zero.
              </p>
            ) : null}
          </>
        )}
      </section>

      <section className="v12-card v12-card-pad">
        <h2>Pipeline on this trip</h2>
        <form action={`/app/trips/${trip.id}`} method="get" className="v12-form-grid" role="search">
          {hotelQuery ? <input type="hidden" name="q" value={hotelQuery} /> : null}
          <label className="v12-field" htmlFor="pipeline-q">
            <span>Find a pipeline hotel</span>
            <input
              id="pipeline-q"
              name="pipeline"
              type="search"
              defaultValue={pipelineQuery ?? ""}
            />
          </label>
          <button type="submit" className="v12-btn">
            Find
          </button>
        </form>
        {pipeline.status === "error" ? (
          <ErrorState
            title="We couldn’t load your pipeline"
            description="Reload to try again. This is not an empty pipeline."
          />
        ) : pipeline.items.length === 0 ? (
          <p>
            {pipeline.query
              ? "No pipeline hotels matched that search."
              : pipeline.page > 1
                ? "No more pipeline items on this page."
                : "You don’t have pipeline items to link yet. Save a hotel from Discover first."}
          </p>
        ) : (
          <ul className="v12-plain-list">
            {pipeline.items.map((item) => {
              const linked = item.tripId === trip.id;
              return (
                <li key={item.id} className="v12-list-item">
                  <div className="v12-row">
                    <div>
                      <strong>{item.hotelName}</strong>
                      <p>
                        {pipelineStatusLabel(item.status)}
                        {linked
                          ? " · Linked to this trip"
                          : item.tripId
                            ? " · Linked to another trip"
                            : ""}
                      </p>
                    </div>
                    <PipelineLinkButton tripId={trip.id} pipelineItemId={item.id} linked={linked} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {pipeline.status === "ok" && (pipeline.hasPrevious || pipeline.hasNext) ? (
          <p className="v12-row">
            <span>Page {pipeline.page}</span>
            {pipeline.hasPrevious ? (
              <Link
                href={workspaceHref(trip.id, {
                  q: hotelQuery,
                  pipeline: pipeline.query,
                  pipelinePage: pipeline.page - 1,
                })}
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
              >
                Older
              </Link>
            ) : null}
          </p>
        ) : null}
      </section>

      <section className="v12-card v12-card-pad" id="start-outreach">
        <h2>Start outreach</h2>
        <p>Creating outreach copies the shortlist once. It does not create opportunities.</p>
        {campaigns.status === "ok" && campaigns.campaigns.length > 0 ? (
          <ul className="v12-plain-list">
            {campaigns.campaigns.map((campaign) => (
              <li key={campaign.id} className="v12-list-item">
                <Link href={`/app/outreach/${campaign.id}`}>{campaign.name}</Link>
              </li>
            ))}
          </ul>
        ) : null}
        {allTrips.status === "error" || destinations.status === "error" ? (
          <ErrorState
            title="We couldn’t load the outreach form"
            description="Reload to try again."
          />
        ) : (
          <CreateOutreachForm
            trips={tripChoices}
            destinations={destinationChoices}
            defaultTripId={trip.id}
          />
        )}
      </section>

      <section className="v12-card v12-card-pad">
        <h2>Trip details</h2>
        {destinations.status === "error" ? (
          <p>We couldn’t load destinations. Reload to edit this trip.</p>
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
