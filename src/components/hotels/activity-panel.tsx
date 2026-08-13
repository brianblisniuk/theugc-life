/**
 * "Your Activity" — the creator's private relationship to a hotel (PRD §7.3).
 *
 * Sprint 2B makes this real: when no open cycle exists the creator can save the
 * hotel; when one exists we show its human status and route to the pipeline.
 * A second cycle is never offered while one is open (D023).
 *
 * Status transitions (pitched/replied/follow-up/…) are a later sprint; this
 * surface only reads the relationship and offers Save.
 */
import Link from "next/link";

import { SaveHotelButton } from "@/components/pipeline/save-hotel-button";
import type { HotelRelationship } from "@/lib/pipeline/queries";
import { activityPanelState } from "@/lib/pipeline/view";

export function ActivityPanel({
  hotelId,
  relationship,
}: {
  hotelId: string;
  relationship: HotelRelationship | null;
}) {
  const state = activityPanelState(relationship);

  if (state.kind === "open_cycle") {
    return (
      <div className="space-y-3 rounded-[var(--radius-app)] border border-border bg-surface p-6">
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
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-[var(--radius-app)] border border-border bg-surface p-6">
      <div className="space-y-1">
        <h3 className="text-base font-semibold text-text">Not saved yet</h3>
        <p className="max-w-prose text-sm text-muted">
          Save this hotel to track your outreach. Your notes and status stay private to you.
        </p>
      </div>

      <SaveHotelButton hotelId={hotelId} />
    </div>
  );
}
