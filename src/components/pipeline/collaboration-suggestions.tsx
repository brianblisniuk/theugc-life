"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";

import {
  confirmCollaborationSuggestionAction,
  dismissCollaborationSuggestionAction,
} from "@/lib/gmail/collaboration/actions";
import type { CollaborationSuggestionLoad } from "@/lib/gmail/collaboration/contract";
import {
  COLLABORATION_COPY,
  collaborationKindBody,
  collaborationKindLabel,
  collaborationWriteMessage,
} from "@/lib/gmail/collaboration/display";
import { REPLY_SENTIMENTS } from "@/lib/inbox-pipeline/contract";

const fieldClass =
  "w-full rounded-[var(--radius-app)] border border-border bg-background px-3 py-2 text-sm text-text";
const labelClass = "block text-xs font-medium text-muted";

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast disabled:opacity-60"
    >
      {pending ? "Saving…" : label}
    </button>
  );
}

export function CollaborationSuggestions({
  pipelineItemId,
  hotelId,
  load,
}: {
  pipelineItemId: string;
  hotelId: string;
  load: CollaborationSuggestionLoad;
}) {
  const [message, setMessage] = useState<string | null>(null);
  if (load.status === "hidden") return null;
  if (load.status === "error") {
    return <p className="text-sm text-muted">{COLLABORATION_COPY.error}</p>;
  }
  if (load.status === "paused") {
    return (
      <p className="max-w-prose text-sm text-muted" data-testid="gmail-collaboration-paused">
        {COLLABORATION_COPY.paused}
      </p>
    );
  }
  if (load.suggestions.length === 0) return null;

  return (
    <div className="space-y-3" data-testid="gmail-collaboration-suggestions">
      {message ? <p className="text-sm text-text">{message}</p> : null}
      {load.suggestions.map((suggestion) => (
        <div key={suggestion.id} className="space-y-2 border-t border-border pt-3">
          <p className="text-sm font-medium text-text">{collaborationKindLabel(suggestion.kind)}</p>
          <p className="max-w-prose text-sm text-muted">{collaborationKindBody(suggestion.kind)}</p>
          <form
            action={async (formData) => {
              const result = await confirmCollaborationSuggestionAction(formData);
              setMessage(collaborationWriteMessage(result.result, result.kind ?? suggestion.kind));
            }}
            className="flex flex-wrap items-end gap-3"
          >
            <input type="hidden" name="pipelineItemId" value={pipelineItemId} />
            <input type="hidden" name="hotelId" value={hotelId} />
            <input type="hidden" name="suggestionId" value={suggestion.id} />
            <input type="hidden" name="kind" value={suggestion.kind} />
            {suggestion.kind === "human_reply" ? (
              <label className={labelClass}>
                Your reading of the reply
                <select name="sentiment" required className={fieldClass} defaultValue="">
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
            <SubmitButton
              label={
                suggestion.kind === "collaboration" ? "Confirm suggestion" : "Record on my pipeline"
              }
            />
          </form>
          <form
            action={async (formData) => {
              const result = await dismissCollaborationSuggestionAction(formData);
              setMessage(collaborationWriteMessage(result.result, suggestion.kind));
            }}
          >
            <input type="hidden" name="pipelineItemId" value={pipelineItemId} />
            <input type="hidden" name="hotelId" value={hotelId} />
            <input type="hidden" name="suggestionId" value={suggestion.id} />
            <button type="submit" className="text-sm text-muted underline">
              Dismiss
            </button>
          </form>
        </div>
      ))}
    </div>
  );
}
