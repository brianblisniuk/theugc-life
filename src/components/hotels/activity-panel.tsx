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

import { CollaborationLifecycle } from "@/components/pipeline/collaboration-lifecycle";
import { CollaborationSuggestions } from "@/components/pipeline/collaboration-suggestions";
import { CollaborationWorkspace } from "@/components/pipeline/collaboration-workspace";
import { ContractDrafts } from "@/components/pipeline/contract-drafts";
import { InboxLink } from "@/components/pipeline/inbox-link";
import { SaveHotelButton } from "@/components/pipeline/save-hotel-button";
import { WorkflowActions } from "@/components/pipeline/workflow-actions";
import type { WorkspaceLoad } from "@/lib/collaboration/queries";
import type { ContractListLoad } from "@/lib/contracts/queries";
import type { CollaborationSuggestionLoad } from "@/lib/gmail/collaboration/contract";
import type { InboxLoad, MailboxLoad } from "@/lib/inbox-pipeline/contract";
import type { GmailPromptLoad } from "@/lib/network-intelligence/contract";
import type { CollaborationLoad, OpenRelationshipResult } from "@/lib/pipeline/queries";
import { SHELL_NOTES } from "@/lib/shell/navigation";
import {
  activityPanelState,
  collaborationPanelState,
  shouldOfferLifecycle,
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
  workspace,
  contracts,
  inbox,
  mailboxes,
  gmailPrompt,
  collaborationSuggestions,
  pipelineHref,
}: {
  hotelId: string;
  relationship: OpenRelationshipResult | { status: "not_open" };
  /** Only read for a `won` cycle; `none` elsewhere. */
  collaboration: CollaborationLoad;
  /** Deliverables and agreed compensation for that collaboration. */
  workspace: WorkspaceLoad;
  /** Agreement drafts for a won deal. Omitted when there is no collaboration. */
  contracts?: ContractListLoad;
  /** Inbox link for an open cycle. Omitted when there is no cycle to attach it to. */
  inbox?: InboxLoad;
  mailboxes?: MailboxLoad;
  gmailPrompt?: GmailPromptLoad;
  collaborationSuggestions?: CollaborationSuggestionLoad;
  /** Where "View in Pipeline" returns. Defaults to the full pipeline list. */
  pipelineHref?: string;
}) {
  if (relationship.status === "not_open") {
    return (
      <Panel>
        <div className="space-y-1">
          <h3 className="text-base font-semibold text-text">That opportunity isn’t open</h3>
          <p className="max-w-prose text-sm text-muted">
            This page did not switch to another opportunity.
          </p>
        </div>
        <div id="inbox" className="scroll-mt-24" />
        <div id="collaboration" className="scroll-mt-24" />
      </Panel>
    );
  }

  const state = activityPanelState(relationship);

  if (state.kind === "load_error") {
    return (
      <Panel>
        <div className="space-y-1">
          <h3 className="text-base font-semibold text-text">{state.title}</h3>
          <p className="max-w-prose text-sm text-muted">{state.body}</p>
        </div>
        <div id="inbox" className="scroll-mt-24" />
        <div id="collaboration" className="scroll-mt-24" />
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

        {deal.kind === "lifecycle" ? (
          <div
            id="collaboration"
            className="scroll-mt-24 space-y-3 rounded-[var(--radius-app)] border border-border bg-background p-4"
          >
            <div className="space-y-1">
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
                {deal.startDate ? (
                  <div className="flex gap-2">
                    <dt>Start</dt>
                    <dd className="font-medium text-text">{deal.startDate}</dd>
                  </div>
                ) : null}
                {deal.endDate ? (
                  <div className="flex gap-2">
                    <dt>End</dt>
                    <dd className="font-medium text-text">{deal.endDate}</dd>
                  </div>
                ) : null}
              </dl>
            </div>

            {/* Lifecycle controls exist only for a collaboration we actually
                loaded — never for a failed read or a missing record. */}
            {shouldOfferLifecycle(deal) && relationship.status === "open" ? (
              <CollaborationLifecycle
                pipelineItemId={relationship.relationship.pipelineItemId}
                hotelId={hotelId}
                actions={deal.actions}
              />
            ) : null}
            {relationship.status === "open" && workspace.status === "ok" ? (
              <CollaborationWorkspace
                pipelineItemId={relationship.relationship.pipelineItemId}
                hotelId={hotelId}
                initial={workspace.workspace}
                asOf={new Date().toISOString()}
              />
            ) : relationship.status === "open" && workspace.status === "error" ? (
              <p className="text-sm text-muted">
                Compensation and deliverables couldn&rsquo;t be loaded. Reload the page to try
                again.
              </p>
            ) : null}
            {relationship.status === "open" && contracts?.status === "ok" ? (
              <ContractDrafts
                pipelineItemId={relationship.relationship.pipelineItemId}
                hotelId={hotelId}
                drafts={contracts.drafts}
              />
            ) : contracts?.status === "error" ? (
              <p className="text-sm text-muted">
                Agreement drafts couldn&rsquo;t be loaded. Reload the page to try again.
              </p>
            ) : null}
          </div>
        ) : deal.kind === "load_error" || deal.kind === "integrity_problem" ? (
          <div
            id="collaboration"
            className="scroll-mt-24 space-y-1 rounded-[var(--radius-app)] border border-border bg-background p-4"
          >
            <h4 className="text-sm font-semibold text-text">{deal.title}</h4>
            <p className="max-w-prose text-sm text-muted">{deal.body}</p>
          </div>
        ) : (
          <div id="collaboration" className="scroll-mt-24 space-y-1">
            <h4 className="text-sm font-semibold text-text">Collaboration</h4>
            <p className="max-w-prose text-sm text-muted">{SHELL_NOTES.collaborationNeedsWin}</p>
          </div>
        )}

        {inbox && mailboxes && relationship.status === "open" ? (
          <div id="inbox" className="scroll-mt-24">
            <InboxLink
              pipelineItemId={relationship.relationship.pipelineItemId}
              hotelId={hotelId}
              inbox={inbox}
              mailboxes={mailboxes}
              gmailPrompt={gmailPrompt}
            />
            {collaborationSuggestions ? (
              <CollaborationSuggestions
                pipelineItemId={relationship.relationship.pipelineItemId}
                hotelId={hotelId}
                load={collaborationSuggestions}
              />
            ) : null}
          </div>
        ) : (
          <div id="inbox" className="scroll-mt-24" />
        )}

        {shouldOfferWorkflow(state) && relationship.status === "open" ? (
          <WorkflowActions
            pipelineItemId={relationship.relationship.pipelineItemId}
            hotelId={hotelId}
            status={state.status}
          />
        ) : null}

        <Link
          href={pipelineHref ?? "/app/pipeline"}
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
      <div id="inbox" className="scroll-mt-24 space-y-1">
        <h4 className="text-sm font-semibold text-text">Inbox</h4>
        <p className="max-w-prose text-sm text-muted">{SHELL_NOTES.inboxNeedsCycle}</p>
      </div>
      <div id="collaboration" className="scroll-mt-24 space-y-1">
        <h4 className="text-sm font-semibold text-text">Collaboration</h4>
        <p className="max-w-prose text-sm text-muted">{SHELL_NOTES.collaborationNeedsWin}</p>
      </div>
    </Panel>
  );
}
