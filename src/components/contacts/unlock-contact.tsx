"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";

import { RetryButton } from "@/components/ui/retry-button";

import { capture } from "@/lib/analytics";
import {
  ALREADY_UNLOCKED_LABEL,
  CONTACT_LOOKUP_UNAVAILABLE,
  OUT_OF_CREDITS_COPY,
  addedToPipelineToast,
  unlockChrome,
  unlockContactLabel,
} from "@/lib/credits/config";
import { CREDITS_UNAVAILABLE, UNLOCK_ASSURANCE } from "@/lib/screens/copy";
import { unlockHotelContactAction } from "@/lib/credits/actions";
import type { UnlockActionResult } from "@/lib/credits/types";
import { PIPELINE_COPY, freeLimitExplanation } from "@/lib/pipeline/view";

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="ux-btn ux-btn-primary">
      {pending ? "Unlocking…" : label}
    </button>
  );
}

/**
 * Explicit unlock. Rendering this control does not spend a credit.
 * Onboarding passes showEmail false so the card never carries an address.
 */
export function UnlockContact({
  hotelId,
  unlocked,
  balance,
  cost,
  showEmail,
}: {
  hotelId: string;
  unlocked: boolean;
  balance: number | null;
  cost: number;
  showEmail: boolean;
}) {
  const [result, setResult] = useState<UnlockActionResult | null>(null);
  const chrome = unlockChrome({
    unlocked: unlocked || result?.status === "unlocked" || result?.status === "already_unlocked",
    balance:
      result && "balance" in result && result.balance !== undefined ? result.balance : balance,
    cost,
  });
  const label = unlockContactLabel(cost);

  if (chrome === "already") {
    const email =
      showEmail && result && (result.status === "unlocked" || result.status === "already_unlocked")
        ? result.email
        : null;
    const added = addedToPipelineToast(result);
    return (
      <div className="space-y-2" data-testid="unlock-state">
        <p className="text-sm font-semibold text-text">{ALREADY_UNLOCKED_LABEL}</p>
        {email ? (
          <p className="text-sm text-text">
            <a className="underline" href={`mailto:${email}`}>
              {email}
            </a>
          </p>
        ) : null}
        {added ? (
          <p
            className="rounded-md bg-accent px-4 py-3 text-sm font-semibold text-accent-contrast"
            role="status"
            data-testid="added-to-pipeline"
          >
            {added}
          </p>
        ) : null}
      </div>
    );
  }

  if (chrome === "out") {
    return (
      <div
        className="space-y-2 rounded-[var(--radius-app)] border border-border bg-surface p-4"
        role="status"
      >
        <p className="text-sm font-semibold text-text">{OUT_OF_CREDITS_COPY}</p>
      </div>
    );
  }

  if (chrome === "unknown") {
    return (
      <div className="ux-stack-sm" role="status">
        <p className="ux-name">{CREDITS_UNAVAILABLE}</p>
        <p className="ux-meta">Retry the balance. This is not 0, and it is not an upgrade.</p>
        <RetryButton className="ux-btn" />
      </div>
    );
  }

  async function onSubmit(formData: FormData) {
    capture("contact_unlock_clicked", { hotel_id: hotelId });
    const outcome = await unlockHotelContactAction(formData);
    setResult(outcome);
    if (outcome.status === "unlocked" || outcome.status === "already_unlocked") {
      capture("credit_unlock", { hotel_id: hotelId });
      if (outcome.pipelineAdded) capture("hotel_saved", { hotel_id: hotelId });
    } else if (outcome.status === "insufficient_credits") {
      capture("credit_insufficient", { hotel_id: hotelId });
    }
  }

  return (
    <div className="space-y-2">
      <form action={onSubmit}>
        <input type="hidden" name="hotelId" value={hotelId} />
        <SubmitButton label={label} />
      </form>
      <p className="ux-meta">{UNLOCK_ASSURANCE}</p>
      {result?.status === "not_found" ? (
        <p className="text-sm text-muted" role="status">
          Contact not available yet. This did not use a credit.
        </p>
      ) : null}
      {result?.status === "unavailable" ? (
        <p className="text-sm text-muted" role="status">
          {CONTACT_LOOKUP_UNAVAILABLE}
        </p>
      ) : null}
      {result?.status === "pipeline_limit" ? (
        <div role="status" className="space-y-2">
          <p className="text-sm font-medium text-text">{PIPELINE_COPY.limitTitle}</p>
          {result.limit !== null ? (
            <p className="max-w-prose text-sm text-muted">{freeLimitExplanation(result.limit)}</p>
          ) : null}
        </div>
      ) : null}
      {result?.status === "error" || result?.status === "hotel_missing" ? (
        <p className="text-sm text-muted" role="status">
          The unlock didn&rsquo;t finish. Reload and try again. This is not a missing contact.
        </p>
      ) : null}
    </div>
  );
}
