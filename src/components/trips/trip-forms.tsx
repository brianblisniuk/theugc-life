"use client";

/**
 * Trip forms. They post only the fields the creator typed. The server action
 * resolves the session; these components never send a user id.
 */
import { useState } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";

import {
  addTripHotelAction,
  createTripAction,
  deleteTripAction,
  linkPipelineItemAction,
  removeTripHotelAction,
  updateTripAction,
} from "@/lib/trips/actions";
import { tripLimitMessage } from "@/lib/trips/display";
import {
  TRIP_STATUSES,
  tripStatusLabel,
  type ShortlistResult,
  type TripStatus,
  type TripWriteResult,
} from "@/lib/trips/types";

const FIELD =
  "w-full rounded-[var(--radius-app)] border border-border bg-background px-3 py-2 text-sm text-text";
const LABEL = "block text-xs font-medium text-muted";

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast disabled:opacity-60"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

function writeMessage(result: TripWriteResult): string | null {
  switch (result.result) {
    case "limit_reached":
      return tripLimitMessage(result.limit);
    case "invalid_input":
      return "Check the destination and dates.";
    case "destination_not_found":
      return "That destination isn’t in the catalog.";
    case "not_found":
      return "That trip isn’t available.";
    case "error":
    case "creator_profile_missing":
      return "We couldn’t save the trip. Try again.";
    default:
      return null;
  }
}

export function TripCreateForm({ destinations }: { destinations: { id: string; name: string }[] }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(formData: FormData) {
    const result = await createTripAction(formData);
    if (result.result === "created") {
      router.push(`/app/trips/${result.tripId}`);
      return;
    }
    setMessage(writeMessage(result));
  }

  if (destinations.length === 0) {
    return (
      <p className="text-sm text-muted">
        Trip planning needs a destination from the catalog. None are available to choose yet.
      </p>
    );
  }

  return (
    <form action={onSubmit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1 sm:col-span-2">
          <label className={LABEL} htmlFor="trip-name">
            Name <span className="font-normal">(optional)</span>
          </label>
          <input id="trip-name" name="name" type="text" maxLength={120} className={FIELD} />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <label className={LABEL} htmlFor="trip-destination">
            Destination
          </label>
          <select
            id="trip-destination"
            name="destinationId"
            required
            className={FIELD}
            defaultValue=""
          >
            <option value="" disabled>
              Choose a destination
            </option>
            {destinations.map((destination) => (
              <option key={destination.id} value={destination.id}>
                {destination.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className={LABEL} htmlFor="trip-start">
            Start
          </label>
          <input id="trip-start" name="startDate" type="date" required className={FIELD} />
        </div>
        <div className="space-y-1">
          <label className={LABEL} htmlFor="trip-end">
            End
          </label>
          <input id="trip-end" name="endDate" type="date" required className={FIELD} />
        </div>
        <div className="space-y-1">
          <label className={LABEL} htmlFor="trip-status">
            Status
          </label>
          <select id="trip-status" name="status" defaultValue="planning" className={FIELD}>
            {TRIP_STATUSES.map((status) => (
              <option key={status} value={status}>
                {tripStatusLabel(status)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <SubmitButton label="Create trip" pendingLabel="Creating…" />
      {message ? (
        <p className="text-sm text-muted" role="status">
          {message}
        </p>
      ) : null}
    </form>
  );
}

export function TripEditForm({
  trip,
  destinations,
}: {
  trip: {
    id: string;
    name: string | null;
    destinationId: string;
    startDate: string;
    endDate: string;
    status: TripStatus;
  };
  destinations: { id: string; name: string }[];
}) {
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(formData: FormData) {
    const result = await updateTripAction(formData);
    setMessage(result.result === "updated" ? "Saved." : writeMessage(result));
  }

  return (
    <form action={onSubmit} className="space-y-4">
      <input type="hidden" name="tripId" value={trip.id} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1 sm:col-span-2">
          <label className={LABEL} htmlFor="edit-trip-name">
            Name <span className="font-normal">(optional)</span>
          </label>
          <input
            id="edit-trip-name"
            name="name"
            type="text"
            maxLength={120}
            defaultValue={trip.name ?? ""}
            className={FIELD}
          />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <label className={LABEL} htmlFor="edit-trip-destination">
            Destination
          </label>
          <select
            id="edit-trip-destination"
            name="destinationId"
            required
            className={FIELD}
            defaultValue={trip.destinationId}
          >
            {destinations.map((destination) => (
              <option key={destination.id} value={destination.id}>
                {destination.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className={LABEL} htmlFor="edit-trip-start">
            Start
          </label>
          <input
            id="edit-trip-start"
            name="startDate"
            type="date"
            required
            defaultValue={trip.startDate}
            className={FIELD}
          />
        </div>
        <div className="space-y-1">
          <label className={LABEL} htmlFor="edit-trip-end">
            End
          </label>
          <input
            id="edit-trip-end"
            name="endDate"
            type="date"
            required
            defaultValue={trip.endDate}
            className={FIELD}
          />
        </div>
        <div className="space-y-1">
          <label className={LABEL} htmlFor="edit-trip-status">
            Status
          </label>
          <select id="edit-trip-status" name="status" defaultValue={trip.status} className={FIELD}>
            {TRIP_STATUSES.map((status) => (
              <option key={status} value={status}>
                {tripStatusLabel(status)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <SubmitButton label="Save changes" pendingLabel="Saving…" />
      {message ? (
        <p className="text-sm text-muted" role="status">
          {message}
        </p>
      ) : null}
    </form>
  );
}

export function TripDeleteForm({ tripId }: { tripId: string }) {
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(formData: FormData) {
    const result = await deleteTripAction(formData);
    setMessage(writeMessage(result));
  }

  return (
    <form action={onSubmit} className="space-y-2">
      <input type="hidden" name="tripId" value={tripId} />
      <button type="submit" className="text-sm text-muted underline hover:text-text">
        Delete trip
      </button>
      {message ? (
        <p className="text-sm text-muted" role="status">
          {message}
        </p>
      ) : null}
    </form>
  );
}

export function ShortlistAddButton({ tripId, hotelId }: { tripId: string; hotelId: string }) {
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(formData: FormData) {
    const result = await addTripHotelAction(formData);
    if (result.result === "added" || result.result === "already_shortlisted") {
      setMessage(result.result === "added" ? "Added." : "Already on this trip.");
      return;
    }
    if (result.result === "hotel_not_found") {
      setMessage("That hotel isn’t in the published catalog.");
      return;
    }
    setMessage("We couldn’t add that hotel.");
  }

  return (
    <form action={onSubmit} className="space-y-1">
      <input type="hidden" name="tripId" value={tripId} />
      <input type="hidden" name="hotelId" value={hotelId} />
      <SubmitButton label="Add" pendingLabel="Adding…" />
      {message ? <p className="text-xs text-muted">{message}</p> : null}
    </form>
  );
}

function shortlistRefusal(result: ShortlistResult): string | null {
  if (result.result === "removed") return "Removed.";
  if (result.result === "not_found") return "That stay isn’t on your account. Nothing was changed.";
  return "We couldn’t remove that hotel. Nothing was changed.";
}

export function ShortlistRemoveButton({ tripId, hotelId }: { tripId: string; hotelId: string }) {
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(formData: FormData) {
    const result = await removeTripHotelAction(formData);
    setMessage(shortlistRefusal(result));
  }

  return (
    <form action={onSubmit} className="space-y-1">
      <input type="hidden" name="tripId" value={tripId} />
      <input type="hidden" name="hotelId" value={hotelId} />
      <button type="submit" className="text-sm text-muted underline hover:text-text">
        Remove
      </button>
      {message ? (
        <p className="text-xs text-muted" role="status">
          {message}
        </p>
      ) : null}
    </form>
  );
}

export function PipelineLinkButton({
  tripId,
  pipelineItemId,
  linked,
}: {
  tripId: string;
  pipelineItemId: string;
  linked: boolean;
}) {
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(formData: FormData) {
    const result = await linkPipelineItemAction(formData);
    if (result.result === "linked" || result.result === "unlinked") {
      setMessage(result.result === "linked" ? "Linked." : "Unlinked.");
      return;
    }
    if (result.result === "not_found") {
      setMessage("That item isn’t on your account. Nothing was changed.");
      return;
    }
    setMessage("We couldn’t update that link. Nothing was changed.");
  }

  return (
    <form action={onSubmit} className="space-y-1">
      <input type="hidden" name="tripId" value={tripId} />
      <input type="hidden" name="pipelineItemId" value={pipelineItemId} />
      <input type="hidden" name="mode" value={linked ? "unlink" : "link"} />
      <button type="submit" className="text-sm font-medium text-text underline">
        {linked ? "Unlink" : "Link to this trip"}
      </button>
      {message ? (
        <p className="text-xs text-muted" role="status">
          {message}
        </p>
      ) : null}
    </form>
  );
}
