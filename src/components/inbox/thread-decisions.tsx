"use client";

import { useState } from "react";

import {
  acceptInboxSuggestionAction,
  dismissInboxSuggestionAction,
} from "@/lib/inbox-pipeline/actions";
import { REPLY_SENTIMENTS } from "@/lib/inbox-pipeline/contract";
import { inboxWriteMessage } from "@/lib/inbox-pipeline/display";
import { suggestionKindLabel, type InboxSuggestionRow } from "@/lib/inbox/model";

export function ThreadDecisions({
  pipelineItemId,
  hotelId,
  suggestions,
}: {
  pipelineItemId: string;
  hotelId: string;
  suggestions: readonly InboxSuggestionRow[];
}) {
  const [message, setMessage] = useState<string | null>(null);
  if (suggestions.length === 0) return null;
  return (
    <div className="v12-decisions" data-testid="inbox-thread-decisions">
      {message ? (
        <p role="status" className="v12-date-note">
          {message}
        </p>
      ) : null}
      {suggestions.map((suggestion) => (
        <div key={suggestion.id} className="v12-decision">
          <p>{suggestionKindLabel(suggestion.kind)}</p>
          <form
            action={async (formData) => {
              const result = await acceptInboxSuggestionAction(formData);
              setMessage(inboxWriteMessage(result.result));
            }}
            className="v12-decision-form"
          >
            <input type="hidden" name="pipelineItemId" value={pipelineItemId} />
            <input type="hidden" name="hotelId" value={hotelId} />
            <input type="hidden" name="suggestionId" value={suggestion.id} />
            <input type="hidden" name="kind" value={suggestion.kind} />
            {suggestion.kind === "mark_replied" ? (
              <label>
                Your reading of the reply
                <select name="sentiment" required defaultValue="">
                  <option value="" disabled>
                    Choose
                  </option>
                  {REPLY_SENTIMENTS.map((sentiment) => (
                    <option key={sentiment} value={sentiment}>
                      {sentiment}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <button type="submit" className="v12-btn v12-btn-primary v12-btn-small">
              {suggestion.appliesCrm ? "Apply to pipeline" : "Acknowledge"}
            </button>
          </form>
          <form
            action={async (formData) => {
              const result = await dismissInboxSuggestionAction(formData);
              setMessage(inboxWriteMessage(result.result));
            }}
          >
            <input type="hidden" name="pipelineItemId" value={pipelineItemId} />
            <input type="hidden" name="hotelId" value={hotelId} />
            <input type="hidden" name="suggestionId" value={suggestion.id} />
            <button type="submit" className="v12-btn v12-btn-ghost v12-btn-small">
              Dismiss
            </button>
          </form>
        </div>
      ))}
    </div>
  );
}
