/**
 * "Your Activity" — the creator's private relationship to a hotel (PRD §7.3).
 *
 * Three distinct states, because a failed lookup is not a domain fact:
 *   open cycle → human status + route to the pipeline (never Save again, D023)
 *   no cycle   → Save to Pipeline
 *   lookup failed → neutral recoverable notice, and NO Save, NO status, NO
 *                   upgrade — we did not learn that this hotel is unsaved.
 *
 * On a `won` cycle the panel also shows the agreed collaboration. That read is
 * tri-state for the same reason the relationship read is: on a won cycle,
 * "we could not load it" and "there is none" mean very different things.
 */
import Link from "next/link";

import { SaveHotelButton } from "@/components/pipeline/save-hotel-button";
import { WorkflowActions } from "@/components/pipeline/workflow-actions";
import type { CollaborationLoad, OpenRelationshipResult } from "@/lib/pipeline/queries";
import {
  activityPanelState,
  collaborationPanelState,
  shouldOfferWorkflow,
} from "@/lib/pipeline/view";

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

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
  collaboration,
}: {
  hotelId: string;
  relationship: OpenRelationshipResult;
  /** Only read for a `won` cycle; `none` elsewhere. */
  collaboration: CollaborationLoad;
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
    const deal = collaborationPanelState({ status: state.status, load: collaboration });

    return (
      <Panel>
        <div className="space-y-1">
          <h3 className="text-base font-semibold text-text">{state.statusLabel}</h3>
          <p className="max-w-prose text-sm text-muted">
            This hotel is in your pipeline. Your notes and outreach history stay private to you.
          </p>
        </div>

        {deal.kind === "agreed" ? (
          <div className="space-y-1 rounded-[var(--radius-app)] border border-border bg-background p-4">
            <h4 className="text-sm font-semibold text-text">{deal.title}</h4>
            <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
              {deal.typeLabel ? (
                <div className="flex gap-2">
                  <dt>Type</dt>
                  <dd className="font-medium text-text">{deal.typeLabel}</dd>
                </div>
              ) : null}
              {formatDate(deal.agreedAt) ? (
                <div className="flex gap-2">
                  <dt>Agreed</dt>
                  <dd className="font-medium text-text">{formatDate(deal.agreedAt)}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        ) : deal.kind === "load_error" || deal.kind === "integrity_problem" ? (
          <div className="space-y-1 rounded-[var(--radius-app)] border border-border bg-background p-4">
            <h4 className="text-sm font-semibold text-text">{deal.title}</h4>
            <p className="max-w-prose text-sm text-muted">{deal.body}</p>
          </div>
        ) : null}

        {shouldOfferWorkflow(state) && relationship.status === "open" ? (
          <WorkflowActions
            pipelineItemId={relationship.relationship.pipelineItemId}
            hotelId={hotelId}
            status={state.status}
          />
        ) : null}

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
