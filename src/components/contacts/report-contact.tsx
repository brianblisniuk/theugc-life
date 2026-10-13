"use client";

import { useState } from "react";

import { capture } from "@/lib/analytics";
import { reportContactAction } from "@/lib/credits/actions";
import type { ReportActionResult } from "@/lib/credits/types";

/** The owner reports a contact they already unlocked. Filing it does not spend a credit. */
export function ReportContact({ hotelId }: { hotelId: string }) {
  const [result, setResult] = useState<ReportActionResult | null>(null);

  async function onSubmit(formData: FormData) {
    const outcome = await reportContactAction(formData);
    setResult(outcome);
    if (outcome.status === "reported") capture("contact_report", { hotel_id: hotelId });
  }

  if (result?.status === "reported") {
    return (
      <p className="text-sm text-muted" role="status">
        Report received. An admin reviews it before any courtesy credit.
      </p>
    );
  }

  return (
    <form action={onSubmit} className="space-y-2">
      <input type="hidden" name="hotelId" value={hotelId} />
      <label className="block text-xs font-medium text-muted">
        What went wrong
        <input
          name="reason"
          required
          maxLength={500}
          className="mt-1 block w-full rounded-[var(--radius-app)] border border-border bg-background px-3 py-2 text-sm text-text"
        />
      </label>
      <button
        type="submit"
        className="inline-flex rounded-[var(--radius-app)] border border-border px-3 py-1.5 text-sm font-semibold text-text"
      >
        Report this email
      </button>
      {result?.status === "error" ? (
        <p className="text-sm text-muted" role="status">
          The report wasn&rsquo;t saved. You can try again.
        </p>
      ) : null}
    </form>
  );
}
