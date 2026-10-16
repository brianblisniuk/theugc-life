"use client";

/**
 * Outreach forms (D184, D182).
 * A hotel can be added without an opportunity. A second opportunity needs a
 * closed previous row, different dates, or a different trip. The server decides.
 */
import { useState } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  addOutreachHotelAction,
  createOutreachAction,
  deleteOutreachAction,
  importOutreachShortlistAction,
  openOutreachOpportunityAction,
  setOpportunityDatesAction,
} from "@/lib/outreach/actions";
import type {
  OpenOpportunityResult,
  OpportunityDatesResult,
  OutreachWriteResult,
} from "@/lib/outreach/types";

function PendingButton({
  label,
  pendingLabel,
  variant = "primary",
}: {
  label: string;
  pendingLabel: string;
  variant?: "primary" | "secondary" | "dark";
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size="small" disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}

function writeMessage(result: OutreachWriteResult): string | null {
  switch (result.result) {
    case "created":
      return null;
    case "imported":
      return result.hotelCount === 0
        ? "No new shortlist hotels to import."
        : `Imported ${result.hotelCount} ${result.hotelCount === 1 ? "hotel" : "hotels"}.`;
    case "added":
      return "Hotel added. This did not open an opportunity.";
    case "already_linked":
      return "That hotel is already on this outreach.";
    case "invalid_input":
      return "Check the name and the dates.";
    case "no_trip":
      return "This outreach has no trip, so there is no shortlist to import.";
    case "not_found":
      return "That outreach isn’t available.";
    case "hotel_not_found":
      return "That hotel isn’t in the catalog.";
    case "destination_not_found":
      return "That destination isn’t in the catalog.";
    default:
      return "We couldn’t save this outreach. Try again.";
  }
}

function openMessage(result: OpenOpportunityResult): string | null {
  switch (result.result) {
    case "created":
      return `Opened ${result.displayRef}.`;
    case "already_open":
      return `${result.displayRef} is already open for these dates.`;
    case "overlap":
      return "Those dates overlap an open opportunity on this trip. An undated open opportunity covers the whole trip. Set its dates, choose dates that do not overlap, use another trip, or close the previous one.";
    case "limit_reached":
      return `The Free saved-hotel allowance is ${result.limit}. A second opportunity for a hotel you already have open does not use another slot.`;
    case "invalid_input":
      return "Enter both dates, or leave both empty. Check-out has to be after check-in.";
    case "not_found":
      return "That trip or outreach isn’t available.";
    case "hotel_not_found":
      return "That hotel isn’t in the catalog.";
    default:
      return "We couldn’t open the opportunity. Try again.";
  }
}

function datesMessage(result: OpportunityDatesResult): string | null {
  switch (result.result) {
    case "updated":
      return "Opportunity dates saved. They are separate from the trip-hotel stay.";
    case "overlap":
      return "Those dates overlap another open opportunity on the same trip. The saved dates were left as they were.";
    case "invalid_input":
      return "Enter both dates, or leave both empty.";
    case "not_found":
      return "That opportunity isn’t available.";
    default:
      return "We couldn’t save those dates. Try again.";
  }
}

export function CreateOutreachForm({
  trips,
  destinations,
  defaultTripId,
}: {
  trips: { id: string; label: string }[];
  destinations: { id: string; name: string }[];
  defaultTripId?: string | null;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(formData: FormData) {
    const result = await createOutreachAction(formData);
    if (result.result === "created") {
      router.push(`/app/outreach/${result.initiativeId}`);
      return;
    }
    setMessage(writeMessage(result));
  }

  return (
    <form action={onSubmit} className="v12-form-grid" id="new-outreach">
      <label className="v12-field">
        <span>Name</span>
        <input name="name" type="text" required maxLength={120} />
      </label>
      <label className="v12-field">
        <span>Trip</span>
        <select name="tripId" defaultValue={defaultTripId ?? ""}>
          <option value="">No trip</option>
          {trips.map((trip) => (
            <option key={trip.id} value={trip.id}>
              {trip.label}
            </option>
          ))}
        </select>
      </label>
      <label className="v12-field">
        <span>Destination, if there is no trip</span>
        <select name="destinationId" defaultValue="">
          <option value="">None</option>
          {destinations.map((destination) => (
            <option key={destination.id} value={destination.id}>
              {destination.name}
            </option>
          ))}
        </select>
      </label>
      <PendingButton label="Create outreach" pendingLabel="Creating…" />
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}

export function ImportShortlistForm({ initiativeId }: { initiativeId: string }) {
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(formData: FormData) {
    setMessage(writeMessage(await importOutreachShortlistAction(formData)));
  }

  return (
    <form action={onSubmit}>
      <input type="hidden" name="initiativeId" value={initiativeId} />
      <PendingButton label="Import new hotels" pendingLabel="Importing…" variant="secondary" />
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}

export function AddHotelButton({
  initiativeId,
  hotelId,
}: {
  initiativeId: string;
  hotelId: string;
}) {
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(formData: FormData) {
    setMessage(writeMessage(await addOutreachHotelAction(formData)));
  }

  return (
    <form action={onSubmit}>
      <input type="hidden" name="initiativeId" value={initiativeId} />
      <input type="hidden" name="hotelId" value={hotelId} />
      <PendingButton label="Add hotel" pendingLabel="Adding…" variant="secondary" />
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}

export function DeleteOutreachForm({ initiativeId }: { initiativeId: string }) {
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(formData: FormData) {
    const result = await deleteOutreachAction(formData);
    if (result.result !== "deleted") setMessage(writeMessage(result));
  }

  return (
    <form action={onSubmit}>
      <input type="hidden" name="initiativeId" value={initiativeId} />
      <p>Deleting removes this campaign. Opportunities stay, with the link cleared.</p>
      <PendingButton label="Delete outreach" pendingLabel="Deleting…" variant="dark" />
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}

export function OpenOpportunityForm({
  hotelId,
  tripId,
  initiativeId,
  label,
}: {
  hotelId: string;
  tripId: string | null;
  initiativeId: string | null;
  label: string;
}) {
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(formData: FormData) {
    setMessage(openMessage(await openOutreachOpportunityAction(formData)));
  }

  return (
    <form action={onSubmit} className="v12-stay-form">
      <input type="hidden" name="hotelId" value={hotelId} />
      <input type="hidden" name="tripId" value={tripId ?? ""} />
      <input type="hidden" name="initiativeId" value={initiativeId ?? ""} />
      <label className="v12-field">
        <span>Stay start</span>
        <input name="stayStart" type="date" />
      </label>
      <label className="v12-field">
        <span>Stay end</span>
        <input name="stayEnd" type="date" />
      </label>
      <PendingButton label={label} pendingLabel="Opening…" />
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}

export function OpportunityDatesForm({
  pipelineItemId,
  tripId,
  initiativeId,
  stayStart,
  stayEnd,
}: {
  pipelineItemId: string;
  tripId: string | null;
  initiativeId: string | null;
  stayStart: string | null;
  stayEnd: string | null;
}) {
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(formData: FormData) {
    setMessage(datesMessage(await setOpportunityDatesAction(formData)));
  }

  return (
    <form action={onSubmit} className="v12-stay-form">
      <input type="hidden" name="pipelineItemId" value={pipelineItemId} />
      <input type="hidden" name="tripId" value={tripId ?? ""} />
      <input type="hidden" name="initiativeId" value={initiativeId ?? ""} />
      <label className="v12-field">
        <span>Opportunity check-in</span>
        <input name="stayStart" type="date" defaultValue={stayStart ?? ""} />
      </label>
      <label className="v12-field">
        <span>Opportunity check-out</span>
        <input name="stayEnd" type="date" defaultValue={stayEnd ?? ""} />
      </label>
      <PendingButton label="Save dates" pendingLabel="Saving…" variant="secondary" />
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}
