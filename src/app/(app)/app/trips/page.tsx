/**
 * Trip list (PRD §7.5, ROUTES.md `/app/trips`).
 *
 * A failed read is an error, not an empty list. Trips are private; the query
 * runs under the caller's RLS.
 */
import Link from "next/link";
import type { Metadata } from "next";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { TripCreateForm } from "@/components/trips/trip-forms";
import { listCrumbs } from "@/lib/shell/navigation";
import { TRIP_LIST_COPY, tripListOutcome } from "@/lib/surfaces/list-outcome";
import { listDestinations, listTrips, type TripRecord } from "@/lib/trips/queries";
import { tripStatusLabel } from "@/lib/trips/types";

export const metadata: Metadata = { title: "Trips" };

function TripRow({ trip }: { trip: TripRecord }) {
  const title = trip.name ?? trip.destinationName;
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 rounded-[var(--radius-app)] border border-border bg-surface p-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-text">{title}</h2>
        <p className="text-sm text-muted">
          {trip.destinationName} · {trip.startDate} – {trip.endDate}
        </p>
        <p className="text-xs text-muted">
          <span className="rounded-[var(--radius-app)] border border-border px-2 py-0.5 font-medium text-text">
            {tripStatusLabel(trip.status)}
          </span>
          <span className="ml-2">{trip.visibility === "private" ? "Private" : "Public"}</span>
        </p>
      </div>
      <Link
        href={`/app/trips/${trip.id}`}
        className="inline-flex rounded-[var(--radius-app)] border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-background"
      >
        Open
      </Link>
    </li>
  );
}

export default async function TripsPage() {
  const [tripsResult, destinationsResult] = await Promise.all([listTrips(), listDestinations()]);
  const failed = tripsResult.status === "error";
  const trips = tripsResult.status === "ok" ? tripsResult.trips : [];
  const listOutcome = tripListOutcome({ failed, count: trips.length });
  const destinations = destinationsResult.status === "ok" ? destinationsResult.destinations : [];

  return (
    <div className="space-y-8">
      <PageHeader
        title="Trips"
        description="One place for a destination, the hotels you’re targeting, and the outreach tied to that trip. Trips stay private."
        crumbs={listCrumbs("Trips")}
      />

      {listOutcome === "error" ? (
        <EmptyState title={TRIP_LIST_COPY.errorTitle} description={TRIP_LIST_COPY.errorBody} />
      ) : listOutcome === "empty" ? (
        <EmptyState title={TRIP_LIST_COPY.emptyTitle} description={TRIP_LIST_COPY.emptyBody} />
      ) : (
        <ul className="space-y-3">
          {trips.map((trip) => (
            <TripRow key={trip.id} trip={trip} />
          ))}
        </ul>
      )}

      <section className="space-y-4 rounded-[var(--radius-app)] border border-border bg-surface p-4">
        <h2 className="text-base font-semibold text-text">New trip</h2>
        {destinationsResult.status === "error" ? (
          <p className="text-sm text-muted">We couldn’t load destinations. Reload to try again.</p>
        ) : (
          <TripCreateForm destinations={destinations} />
        )}
      </section>
    </div>
  );
}
