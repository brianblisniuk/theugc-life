"use client";

import { useState } from "react";

import { saveSelfReportedAudience, type ShareWriteResult } from "@/lib/profile/share-actions";

const FIELD =
  "w-full rounded-[var(--radius-app)] border border-border bg-background px-3 py-2 text-sm text-text";

function saveMessage(result: ShareWriteResult): string {
  if (result.result === "saved") return "Saved. These numbers are not shared until you opt in.";
  if (result.result === "invalid_input") return result.message;
  return "We couldn’t save audience metrics. Try again.";
}

export function AudienceFields({
  followers,
  engagement,
}: {
  followers: string;
  engagement: string;
}) {
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(formData: FormData) {
    const result = await saveSelfReportedAudience(formData);
    setMessage(saveMessage(result));
  }

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-text">Audience</h2>
        <p className="max-w-prose text-sm text-muted">
          Self-reported. Not verified. Leave a box blank if you don’t know. Blank is unknown, not
          zero.
        </p>
      </div>
      <form action={onSubmit} className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1 text-xs font-medium text-muted">
          Followers
          <input
            className={FIELD}
            name="selfReportedFollowers"
            defaultValue={followers}
            inputMode="numeric"
            autoComplete="off"
          />
        </label>
        <label className="block space-y-1 text-xs font-medium text-muted">
          Engagement
          <input
            className={FIELD}
            name="selfReportedEngagement"
            defaultValue={engagement}
            autoComplete="off"
          />
        </label>
        <div className="sm:col-span-2">
          <button
            type="submit"
            className="inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
          >
            Save audience
          </button>
          {message ? (
            <p className="mt-2 text-sm text-text" role="status">
              {message}
            </p>
          ) : null}
        </div>
      </form>
    </section>
  );
}
