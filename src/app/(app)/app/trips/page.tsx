/**
 * My Trips (V12.2). Private rows only. A failed read is not an empty list.
 * Night counts come from trip_night_coverage. The calendar is shown when it
 * matches that read. Sample hotels are not filled in.
 */
import type { Metadata } from "next";
import Link from "next/link";

import { TripCreateForm } from "@/components/trips/trip-forms";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { stageTone, stageWord } from "@/lib/outreach/board";
import { TRIP_LIST_COPY, tripListOutcome } from "@/lib/surfaces/list-outcome";
import {
  coverNights,
  formatStay,
  hotelMark,
  monthName,
  nightCountsMatch,
  selectFeaturedTrip,
} from "@/lib/trips/nights";
import {
  listDestinations,
  listShortlist,
  listTripCampaigns,
  listTripOpportunities,
  listTrips,
  readNightCoverage,
  type TripRecord,
} from "@/lib/trips/queries";
import { tripStatusLabel } from "@/lib/trips/types";

export const metadata: Metadata = { title: "My Trips" };

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function tripTitle(trip: TripRecord): string {
  return trip.name?.trim() || trip.destinationName;
}

export default async function TripsPage() {
  const [tripsResult, destinationsResult] = await Promise.all([listTrips(), listDestinations()]);
  const failed = tripsResult.status === "error";
  const trips = tripsResult.status === "ok" ? tripsResult.trips : [];
  const listOutcome = tripListOutcome({ failed, count: trips.length });
  const destinations = destinationsResult.status === "ok" ? destinationsResult.destinations : [];
  const today = todayUtc();
  const featured = listOutcome === "items" ? selectFeaturedTrip(trips, today) : null;

  const [coverage, shortlist, opportunities, campaigns] = featured
    ? await Promise.all([
        readNightCoverage(featured.id),
        listShortlist(featured.id),
        listTripOpportunities(featured.id),
        listTripCampaigns(featured.id),
      ])
    : [null, null, null, null];

  const stays =
    shortlist?.status === "ok"
      ? shortlist.hotels.map((hotel) => ({
          checkIn: hotel.checkIn,
          checkOut: hotel.checkOut,
          nightStatus: hotel.nightStatus,
        }))
      : [];
  const calendar =
    featured && shortlist?.status === "ok"
      ? coverNights(featured.startDate, featured.endDate, stays)
      : null;
  const calendarMatches =
    calendar !== null && coverage?.status === "ok" && nightCountsMatch(calendar, coverage);
  const month = featured ? monthName(featured.startDate) : null;
  const continueHref =
    campaigns?.status === "ok" && campaigns.campaigns[0]
      ? `/app/outreach/${campaigns.campaigns[0].id}`
      : featured
        ? `/app/trips/${featured.id}#start-outreach`
        : "/app/trips#new-trip";

  return (
    <div className="v12-stack">
      <header className="v12-pagehead">
        <div>
          <div className="v12-eyebrow">My Trips / Creator workspace</div>
          <h1>Make every trip count.</h1>
          <p>
            Your professional travel plan: destinations, shortlists, outreach, and accommodation
            coverage.
          </p>
        </div>
        <div className="v12-head-actions">
          <ButtonLink href="/app/discover">Explore hotels</ButtonLink>
          <ButtonLink href="#new-trip" variant="primary">
            New trip
          </ButtonLink>
        </div>
      </header>

      {listOutcome === "error" ? (
        <ErrorState title={TRIP_LIST_COPY.errorTitle} description={TRIP_LIST_COPY.errorBody} />
      ) : null}

      {listOutcome === "empty" ? (
        <EmptyState title={TRIP_LIST_COPY.emptyTitle} description={TRIP_LIST_COPY.emptyBody} />
      ) : null}

      {featured && coverage && shortlist && opportunities && campaigns ? (
        <>
          <section className="v12-cover">
            <div>
              <div className="v12-eyebrow">
                {featured.startDate > today ? "Upcoming trip" : "Current trip"}
              </div>
              <h2>
                {tripTitle(featured)}
                {month ? ` · ${month}` : ""}
              </h2>
              <p>
                {featured.startDate}–{featured.endDate}
                {coverage.status === "ok" ? ` · ${coverage.tripNights} nights` : ""}
                {shortlist.status === "ok"
                  ? ` · ${shortlist.hotels.length} shortlisted ${shortlist.hotels.length === 1 ? "hotel" : "hotels"}`
                  : ""}
                {campaigns.status === "ok" && campaigns.campaigns.length > 0
                  ? " · Outreach connected"
                  : ""}
              </p>
            </div>
            <ButtonLink href={continueHref} variant="primary">
              {campaigns.status === "ok" && campaigns.campaigns[0]
                ? "Continue outreach"
                : "Start outreach"}
            </ButtonLink>
          </section>

          {coverage.status === "ok" ? (
            <div className="v12-stats">
              <div className="v12-stat">
                <div className="v12-stat-label">Travel nights</div>
                <div className="v12-stat-num">{coverage.tripNights}</div>
                <div className="v12-stat-note">
                  {featured.startDate}–{featured.endDate}
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
              description="The trip is still here. Reload to read the saved stays. This is not zero nights."
            />
          )}

          <section className="v12-card v12-card-pad">
            <div className="v12-panel-head">
              <div>
                <h2>Accommodation coverage</h2>
                <p>Only confirmed nights count as covered. Overlapping nights count once.</p>
              </div>
              {coverage.status === "ok" ? (
                <Badge tone="green">
                  {coverage.confirmedNights} / {coverage.tripNights} confirmed
                </Badge>
              ) : null}
            </div>
            {calendarMatches && calendar ? (
              <>
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
                {calendar.nights.length === 0 ? (
                  <p>This trip starts and ends on the same day, so it has no nights.</p>
                ) : null}
              </>
            ) : shortlist.status === "error" || coverage?.status !== "ok" ? (
              <ErrorState
                title="We couldn’t draw the nights"
                description="The shortlist or the coverage read failed. This is not an empty stay."
              />
            ) : (
              <ErrorState
                title="The night calendar didn’t match the saved stays"
                description="Reload to try again. The counts above are the saved read."
              />
            )}
            <div className="v12-legend">
              <Badge tone="green">Confirmed</Badge>
              <Badge tone="amber">Pending</Badge>
              <Badge tone="gray">Gap</Badge>
            </div>
          </section>

          <div className="v12-split">
            <section className="v12-card v12-card-pad">
              <div className="v12-panel-head">
                <div>
                  <h2>Hotels in your shortlist</h2>
                  <p>Saved once, reused in Outreach.</p>
                </div>
                <ButtonLink href="/app/discover" size="small">
                  Find more hotels
                </ButtonLink>
              </div>
              {shortlist.status === "error" ? (
                <ErrorState
                  title="We couldn’t load the shortlist"
                  description="Reload to try again. This is not an empty shortlist."
                />
              ) : shortlist.hotels.length === 0 ? (
                <EmptyState
                  title="No hotels shortlisted yet"
                  description="Save a hotel from Discover into this trip. A trip does not require outreach."
                />
              ) : (
                <ul className="v12-plain-list">
                  {shortlist.hotels.map((hotel) => {
                    const rows =
                      opportunities.status === "ok"
                        ? opportunities.opportunities.filter((item) => item.hotelId === hotel.id)
                        : [];
                    const stay =
                      hotel.checkIn && hotel.checkOut
                        ? formatStay(hotel.checkIn, hotel.checkOut)
                        : null;
                    return (
                      <li key={hotel.tripHotelId} className="v12-list-item">
                        <div className="v12-row">
                          <span className="v12-mark" aria-hidden="true">
                            {hotelMark(hotel.name)}
                          </span>
                          <div>
                            <strong>
                              <Link href={`/app/trips/${featured.id}`}>{hotel.name}</Link>
                            </strong>
                            <p>
                              {stay ? `${stay} · ` : ""}
                              {hotel.nightStatus === "confirmed" ? "Confirmed" : "Pending"}
                              {rows.length > 0
                                ? ` · ${rows.map((row) => row.displayRef).join(", ")}`
                                : ""}
                            </p>
                          </div>
                          {rows[0] ? (
                            <Badge tone={stageTone(rows[0].status)}>
                              {stageWord(rows[0].status)}
                            </Badge>
                          ) : (
                            <Badge tone="gray">Shortlisted</Badge>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              <ButtonLink href={`/app/trips/${featured.id}`} variant="dark">
                Open trip
              </ButtonLink>
            </section>
            <section className="v12-card v12-card-pad">
              <div className="v12-eyebrow">How the work connects</div>
              <h2>One trip, one shortlist.</h2>
              <div className="v12-list-item">
                <strong>1. Select hotels</strong>
                <p>Save properties from Discover directly into the trip.</p>
              </div>
              <div className="v12-list-item">
                <strong>2. Start outreach</strong>
                <p>The selected hotels are already there when you open Outreach.</p>
              </div>
              <div className="v12-list-item">
                <strong>3. Track outcomes</strong>
                <p>Pipeline, Inbox, agreements, and covered nights use the same opportunities.</p>
              </div>
              <div className="v12-list-item">
                <strong>4. Continue later</strong>
                <p>The next time you sign in, Home brings you back to what is waiting.</p>
              </div>
              <div className="v12-callout">
                Don’t have travel dates? You can begin outreach without creating a trip.
              </div>
            </section>
          </div>
        </>
      ) : null}

      {listOutcome === "items" ? (
        <section className="v12-card v12-card-pad">
          <h2>All trips</h2>
          <ul className="v12-plain-list">
            {trips.map((trip) => (
              <li key={trip.id} className="v12-list-item">
                <div className="v12-row">
                  <div>
                    <strong>
                      <Link href={`/app/trips/${trip.id}`}>{tripTitle(trip)}</Link>
                    </strong>
                    <p>
                      {trip.destinationName} · {trip.startDate}–{trip.endDate}
                    </p>
                  </div>
                  <Badge>{tripStatusLabel(trip.status)}</Badge>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="v12-card v12-card-pad" id="new-trip">
        <h2>New trip</h2>
        {destinationsResult.status === "error" ? (
          <ErrorState
            title="We couldn’t load destinations"
            description="Reload to try again. This is not an empty catalog."
          />
        ) : (
          <TripCreateForm destinations={destinations} />
        )}
      </section>
    </div>
  );
}
