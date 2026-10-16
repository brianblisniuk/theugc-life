"use client";

import { useState } from "react";

import {
  acceptStayDateSuggestionAction,
  rejectStayDateSuggestionAction,
} from "@/lib/inbox/date-actions";
import { dateDecisionMessage, type DateSuggestionView } from "@/lib/inbox/model";

export function DateDecision({ suggestion }: { suggestion: DateSuggestionView }) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="v12-date" data-testid="stay-date-suggestion">
      <p>
        <strong>{suggestion.hotelName}</strong>
        <span>
          {suggestion.checkIn} – {suggestion.checkOut}
          {suggestion.target === "trip" ? " · trip stay" : " · opportunity stay"}
        </span>
      </p>
      <div className="v12-date-actions">
        <form
          action={async (formData) => {
            const result = await acceptStayDateSuggestionAction(formData);
            setMessage(dateDecisionMessage(result.result));
          }}
        >
          <input type="hidden" name="suggestionId" value={suggestion.id} />
          <button type="submit" className="v12-btn v12-btn-primary v12-btn-small">
            Accept dates
          </button>
        </form>
        <form
          action={async (formData) => {
            const result = await rejectStayDateSuggestionAction(formData);
            setMessage(dateDecisionMessage(result.result));
          }}
        >
          <input type="hidden" name="suggestionId" value={suggestion.id} />
          <button type="submit" className="v12-btn v12-btn-small">
            Reject
          </button>
        </form>
      </div>
      {message ? (
        <p role="status" className="v12-date-note">
          {message}
        </p>
      ) : null}
    </div>
  );
}
