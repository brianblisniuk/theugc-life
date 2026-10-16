"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";

import { answerGmailReadingAction } from "@/lib/inbox-pipeline/actions";
import {
  GMAIL_CONFIRM_PROMPT,
  GMAIL_DISMISSED,
  GMAIL_STALE,
  gmailPromptCopy,
} from "@/lib/network-intelligence/display";
import type { GmailPromptLoad } from "@/lib/network-intelligence/contract";

function Choice({ label }: { label: string }) {
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

export function GmailConfirmation({
  pipelineItemId,
  hotelId,
  prompt,
}: {
  pipelineItemId: string;
  hotelId: string;
  prompt: GmailPromptLoad;
}) {
  const [message, setMessage] = useState<string | null>(null);
  if (prompt.status === "hidden") return null;
  if (prompt.status === "error") {
    return <p className="text-sm text-muted">This email confirmation could not be loaded.</p>;
  }

  const stored = gmailPromptCopy(prompt.status);
  if (prompt.status === "stale") {
    return <p className="max-w-prose text-sm text-muted">{GMAIL_STALE}</p>;
  }
  if (stored) {
    return (
      <p className="max-w-prose text-sm text-text" data-testid="gmail-confirmation-stored">
        {stored}
      </p>
    );
  }

  return (
    <div className="space-y-2 border-t border-border pt-3" data-testid="gmail-confirmation">
      <p className="text-sm font-medium text-text">{GMAIL_CONFIRM_PROMPT}</p>
      {message ? <p className="text-sm text-text">{message}</p> : null}
      <div className="flex flex-wrap gap-2">
        <form
          action={async (formData) => {
            const result = await answerGmailReadingAction(formData);
            setMessage(
              result.result === "dismissed"
                ? GMAIL_DISMISSED
                : (gmailPromptCopy(result.result) ?? "Could not save."),
            );
          }}
        >
          <input type="hidden" name="pipelineItemId" value={pipelineItemId} />
          <input type="hidden" name="hotelId" value={hotelId} />
          <input type="hidden" name="decision" value="confirmed" />
          <Choice label="Yes" />
        </form>
        <form
          action={async (formData) => {
            const result = await answerGmailReadingAction(formData);
            setMessage(result.result === "dismissed" ? GMAIL_DISMISSED : "Could not save.");
          }}
        >
          <input type="hidden" name="pipelineItemId" value={pipelineItemId} />
          <input type="hidden" name="hotelId" value={hotelId} />
          <input type="hidden" name="decision" value="dismissed" />
          <Choice label="No" />
        </form>
      </div>
    </div>
  );
}
