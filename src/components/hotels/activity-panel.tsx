/**
 * "Your Activity" — the creator's private relationship to a hotel (PRD §7.3).
 *
 * Three distinct states, because a failed lookup is not a domain fact:
 *   open cycle → human status + route to the pipeline (never Save again, D023)
 *   no cycle   → Save to Pipeline
 *   lookup failed → neutral recoverable notice, and NO Save, NO status, NO
 *                   upgrade — we did not learn that this hotel is unsaved.
 *
 * Status transitions (pitched/replied/follow-up/…) are a later sprint; this
 * surface only reads the relationship and offers Save.
 */
import Link from "next/link";

import { SaveHotelButton } from "@/components/pipeline/save-hotel-button";
import type { OpenRelationshipResult } from "@/lib/pipeline/queries";
import { activityPanelState } from "@/lib/pipeline/view";

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-3 rounded-[var(--radius-app)] border border-border bg-surface p-6">
      {children}
    </div>
  );
}

export function ActivityPanel({
  hotelId,
  relationship,
}: {
  hotelId: string;
  relationship: OpenRelationshipResult;
}) {
  const state = activityPanelState(relationship);

  if (state.kind === "load_error") {
    return (
      <Panel>
        <div className="space-y-1">
          <h3 className="text-base font-semibold text-text">{state.title}</h3>
          <p className="max-w-prose text-sm text-muted">{state.body}</p>
        </div>
      </Panel>
    );
  }

  if (state.kind === "open_cycle") {
    return (
      <Panel>
        <div className="space-y-1">
          <h3 className="text-base font-semibold text-text">{state.statusLabel}</h3>
          <p className="max-w-prose text-sm text-muted">
            This hotel is in your pipeline. Your notes and outreach history stay private to you.
          </p>
        </div>

        <Link
          href="/app/pipeline"
          className="inline-flex rounded-[var(--radius-app)] border border-border px-4 py-2 text-sm font-medium text-text hover:bg-background"
        >
          View in Pipeline
        </Link>
      </Panel>
    );
  }

  return (
    <Panel>
      <div className="space-y-1">
        <h3 className="text-base font-semibold text-text">{state.title}</h3>
        <p className="max-w-prose text-sm text-muted">
          Save this hotel to track your outreach. Your notes and status stay private to you.
        </p>
      </div>

      <SaveHotelButton hotelId={hotelId} />
    </Panel>
  );
}
