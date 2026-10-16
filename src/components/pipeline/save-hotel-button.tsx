"use client";

/**
 * Save-to-Pipeline control (PRD §7.3).
 *
 * Posts only the hotel id to a server action — identity is resolved server-side
 * from the session, so nothing here can influence whose pipeline is written.
 * Uses a real <form> so it works before hydration, with useFormStatus for the
 * pending state and a polite live region for the outcome.
 */
import { useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";

import { capture } from "@/lib/analytics";
import { saveHotelAction } from "@/lib/pipeline/actions";
import type { SaveResult } from "@/lib/pipeline/types";
import { saveControlState, shouldOfferUpgrade } from "@/lib/pipeline/view";

function SubmitButton({
  idle,
  pendingLabel,
  appearance,
}: {
  idle: string;
  pendingLabel: string;
  appearance: "text" | "icon";
}) {
  const { pending } = useFormStatus();
  if (appearance === "icon") {
    return (
      <button
        type="submit"
        disabled={pending}
        className="s1-icon-save"
        aria-label={pending ? pendingLabel : idle}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="M6 3h12v18l-6-4-6 4z" />
        </svg>
      </button>
    );
  }
  return (
    <button type="submit" disabled={pending} className="v12-btn">
      {pending ? pendingLabel : idle}
    </button>
  );
}

export function SaveHotelButton({
  hotelId,
  idle = "Save to Pipeline",
  pendingLabel = "Saving…",
  appearance = "text",
}: {
  hotelId: string;
  idle?: string;
  pendingLabel?: string;
  appearance?: "text" | "icon";
}) {
  const [result, setResult] = useState<SaveResult | null>(null);

  async function onSubmit(formData: FormData) {
    const outcome = await saveHotelAction(formData);
    setResult(outcome);
    if (outcome.result === "created") {
      // Product analytics only — outreach_events remains the source of truth.
      capture("hotel_saved", { hotel_id: hotelId });
    }
  }

  const state = saveControlState(result);

  // A successful save flips this control into the saved state without waiting
  // for a full refresh; the server revalidation keeps the page authoritative.
  if (state.kind === "saved") {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium text-text" role="status">
          {state.message}
        </p>
        <Link
          href="/app/pipeline"
          className="inline-flex rounded-[var(--radius-app)] border border-border px-4 py-2 text-sm font-medium text-text hover:bg-background"
        >
          View in Pipeline
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <form action={onSubmit}>
        <input type="hidden" name="hotelId" value={hotelId} />
        <SubmitButton idle={idle} pendingLabel={pendingLabel} appearance={appearance} />
      </form>

      {state.kind === "limit" || state.kind === "problem" ? (
        <div role="status" className="space-y-2">
          <p className="text-sm text-text">{state.message}</p>
          {shouldOfferUpgrade(state) && state.kind === "limit" ? (
            <>
              <p className="max-w-prose text-sm text-muted">
                {state.explanation} Close one you are no longer pursuing, or upgrade for unlimited
                saves.
              </p>
              <Link
                href="/app/billing"
                className="inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
              >
                View access options
              </Link>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
