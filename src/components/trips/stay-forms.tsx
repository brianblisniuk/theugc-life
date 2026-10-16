"use client";

/**
 * Creator-set stays and Gmail date decisions (D183).
 * These forms post hotel and suggestion ids. They do not post a user id.
 */
import { useState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import {
  acceptStaySuggestionAction,
  rejectStaySuggestionAction,
  setTripHotelStayAction,
} from "@/lib/trips/actions";
import type { StayWriteResult, SuggestionDecision } from "@/lib/trips/types";

function PendingButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" size="small" disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}

function stayMessage(result: StayWriteResult): string | null {
  switch (result.result) {
    case "updated":
      return "Stay saved.";
    case "invalid_input":
      return "Enter both dates, with check-out after check-in. Confirmed needs both dates.";
    case "not_found":
      return "That hotel isn’t on this trip.";
    default:
      return "We couldn’t save the stay. Try again.";
  }
}

function decisionMessage(result: SuggestionDecision): string | null {
  switch (result.result) {
    case "accepted":
      return "Dates saved. Pending or confirmed was left as you set it.";
    case "rejected":
      return "Suggestion dismissed. The saved dates are unchanged.";
    case "overlap":
      return "Those dates overlap another open opportunity, so this suggestion is still pending.";
    case "not_pending":
      return "That suggestion is already decided.";
    case "not_found":
      return "That suggestion isn’t available.";
    default:
      return "We couldn’t update the suggestion. Try again.";
  }
}

export function StayForm({
  tripId,
  hotelId,
  checkIn,
  checkOut,
  nightStatus,
}: {
  tripId: string;
  hotelId: string;
  checkIn: string | null;
  checkOut: string | null;
  nightStatus: "pending" | "confirmed";
}) {
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(formData: FormData) {
    const result = await setTripHotelStayAction(formData);
    setMessage(stayMessage(result));
  }

  return (
    <form action={onSubmit} className="v12-stay-form">
      <input type="hidden" name="tripId" value={tripId} />
      <input type="hidden" name="hotelId" value={hotelId} />
      <label className="v12-field">
        <span>Check-in</span>
        <input name="checkIn" type="date" defaultValue={checkIn ?? ""} />
      </label>
      <label className="v12-field">
        <span>Check-out</span>
        <input name="checkOut" type="date" defaultValue={checkOut ?? ""} />
      </label>
      <label className="v12-field">
        <span>Nights</span>
        <select name="nightStatus" defaultValue={nightStatus}>
          <option value="pending">Pending</option>
          <option value="confirmed">Confirmed</option>
        </select>
      </label>
      <PendingButton label="Save stay" pendingLabel="Saving…" />
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}

export function SuggestionDecisionForm({
  suggestionId,
  tripId,
  initiativeId,
}: {
  suggestionId: string;
  tripId?: string | null;
  initiativeId?: string | null;
}) {
  const [message, setMessage] = useState<string | null>(null);

  async function onAccept(formData: FormData) {
    setMessage(decisionMessage(await acceptStaySuggestionAction(formData)));
  }

  async function onReject(formData: FormData) {
    setMessage(decisionMessage(await rejectStaySuggestionAction(formData)));
  }

  return (
    <div className="v12-suggestion">
      <form action={onAccept}>
        <input type="hidden" name="suggestionId" value={suggestionId} />
        {tripId ? <input type="hidden" name="tripId" value={tripId} /> : null}
        {initiativeId ? <input type="hidden" name="initiativeId" value={initiativeId} /> : null}
        <PendingButton label="Accept dates" pendingLabel="Accepting…" />
      </form>
      <form action={onReject}>
        <input type="hidden" name="suggestionId" value={suggestionId} />
        {tripId ? <input type="hidden" name="tripId" value={tripId} /> : null}
        <Button type="submit" size="small">
          Reject
        </Button>
      </form>
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
