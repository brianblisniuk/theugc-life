"use client";

/**
 * Add the open hotel to one of the creator's trips (D01 `addTripHotelAction`).
 *
 * The form posts a trip id and a hotel id. It does not post a user id.
 * `alreadyOn === null` means the shortlist read failed: no trip is labeled
 * as already containing the hotel, and the copy does not say it is on none.
 */
import { useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";

import { addTripHotelAction } from "@/lib/trips/actions";
import { addToTripMessage } from "@/lib/trips/display";
import type { ShortlistResult } from "@/lib/trips/types";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="ux-btn"
    >
      {pending ? "Adding…" : "Add to trip"}
    </button>
  );
}

export function AddToTrip({
  hotelId,
  trips,
  tripsLoad,
  alreadyOn,
}: {
  hotelId: string;
  trips: readonly { id: string; label: string }[];
  tripsLoad: "ok" | "error";
  alreadyOn: readonly string[] | null;
}) {
  const [result, setResult] = useState<ShortlistResult | null>(null);

  if (tripsLoad === "error") {
    return (
      <p className="text-sm text-muted" role="status">
        We couldn’t load your trips. Reload the page to try again.
      </p>
    );
  }

  if (trips.length === 0) {
    return (
      <p className="text-sm text-muted">
        You don’t have a trip yet.{" "}
        <Link href="/app/trips" className="text-text underline hover:no-underline">
          Plan a trip
        </Link>
      </p>
    );
  }

  const known = new Set(alreadyOn ?? []);

  return (
    <form
      action={async (formData) => {
        setResult(await addTripHotelAction(formData));
      }}
      className="flex flex-wrap items-end gap-3"
    >
      <input type="hidden" name="hotelId" value={hotelId} />
      <div className="min-w-0 flex-1 space-y-1">
        <label htmlFor="add-to-trip" className="block text-xs font-medium text-muted">
          Add to trip
        </label>
        <select
          id="add-to-trip"
          name="tripId"
          defaultValue={trips[0]?.id}
          className="w-full border border-border bg-background px-3 py-2 text-sm text-text"
        >
          {trips.map((trip) => (
            <option key={trip.id} value={trip.id}>
              {trip.label}
              {alreadyOn !== null && known.has(trip.id) ? " — already on this trip" : ""}
            </option>
          ))}
        </select>
      </div>
      <SubmitButton />
      {result ? (
        <p className="basis-full text-sm text-muted" role="status">
          {addToTripMessage(result)}
        </p>
      ) : null}
    </form>
  );
}
