"use client";

/**
 * Outreach workflow controls (PRD §7.4, EVENTS.md §5).
 *
 * Progressive disclosure: the creator picks a step, and only then sees the two
 * or three fields that step actually needs. Every form is a real <form> posting
 * to a server action, so identity and the engaged limit are resolved on the
 * server; nothing here is trusted.
 *
 * Only the actions legal from the current status are offered — the same map the
 * database enforces — so no control on screen can be rejected as an invalid
 * transition.
 */
import { useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";

import { capture } from "@/lib/analytics";
import { transitionPipelineItemAction } from "@/lib/pipeline/actions";
import {
  CLOSE_REASONS,
  OFFER_TYPES,
  OUTREACH_CHANNELS,
  REPLY_SENTIMENTS,
  channelLabel,
  closeReasonLabel,
  offerTypeLabel,
  sentimentLabel,
  workflowActionLabel,
  type PipelineStatus,
  type TransitionResult,
  type WorkflowAction,
} from "@/lib/pipeline/types";
import {
  availableActions,
  shouldOfferWorkflowUpgrade,
  workflowControlState,
} from "@/lib/pipeline/view";

/** Today in the creator's own timezone, formatted for <input type="date">. */
function todayValue(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

const fieldClass =
  "rounded-[var(--radius-app)] border border-border bg-background px-3 py-2 text-sm text-text";
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

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className={labelClass} htmlFor={id}>
        {label}
      </label>
      {children}
    </div>
  );
}

export function WorkflowActions({
  pipelineItemId,
  hotelId,
  status,
}: {
  pipelineItemId: string;
  hotelId: string;
  status: PipelineStatus;
}) {
  const [open, setOpen] = useState<WorkflowAction | null>(null);
  const [result, setResult] = useState<TransitionResult | null>(null);
  const actions = availableActions(status);
  const state = workflowControlState(result);

  async function onSubmit(formData: FormData) {
    const outcome = await transitionPipelineItemAction(formData);
    setResult(outcome);
    if (outcome.result === "applied") {
      setOpen(null);
      // Product analytics only — outreach_events remains the source of truth.
      capture("pipeline_status_changed", { hotel_id: hotelId, status: outcome.status });
    }
  }

  function Form({ action, children }: { action: WorkflowAction; children?: React.ReactNode }) {
    return (
      <form action={onSubmit} className="space-y-3">
        <input type="hidden" name="pipelineItemId" value={pipelineItemId} />
        <input type="hidden" name="hotelId" value={hotelId} />
        <input type="hidden" name="action" value={action} />
        {children}
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton label={workflowActionLabel(action)} />
          <button
            type="button"
            onClick={() => setOpen(null)}
            className="text-sm text-muted underline hover:text-text"
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="space-y-3">
      {open === null ? (
        <div className="flex flex-wrap gap-2">
          {actions.map((action) => (
            <button
              key={action}
              type="button"
              onClick={() => {
                setResult(null);
                setOpen(action);
              }}
              className="inline-flex rounded-[var(--radius-app)] border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-background"
            >
              {workflowActionLabel(action)}
            </button>
          ))}
        </div>
      ) : null}

      {open === "plan" ? (
        <Form action="plan">
          <p className="max-w-prose text-sm text-muted">
            Mark this hotel as one you intend to pitch. Nothing is sent — this is your own planning
            state.
          </p>
        </Form>
      ) : null}

      {open === "mark_pitched" ? (
        <Form action="mark_pitched">
          <div className="flex flex-wrap gap-3">
            <Field id="pitch-channel" label="Channel">
              <select
                id="pitch-channel"
                name="channel"
                required
                defaultValue=""
                className={fieldClass}
              >
                <option value="" disabled>
                  Choose a channel
                </option>
                {OUTREACH_CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {channelLabel(c)}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="pitch-date" label="Date sent">
              <input
                id="pitch-date"
                name="date"
                type="date"
                required
                defaultValue={todayValue()}
                className={fieldClass}
              />
            </Field>
          </div>
        </Form>
      ) : null}

      {open === "mark_followup_sent" ? (
        <Form action="mark_followup_sent">
          <div className="flex flex-wrap gap-3">
            <Field id="followup-date" label="Date sent">
              <input
                id="followup-date"
                name="date"
                type="date"
                required
                defaultValue={todayValue()}
                className={fieldClass}
              />
            </Field>
            <Field id="followup-channel" label="Channel (optional)">
              <select id="followup-channel" name="channel" defaultValue="" className={fieldClass}>
                <option value="">Not recorded</option>
                {OUTREACH_CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {channelLabel(c)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Form>
      ) : null}

      {open === "mark_replied" ? (
        <Form action="mark_replied">
          <div className="flex flex-wrap gap-3">
            <Field id="reply-date" label="Reply date">
              <input
                id="reply-date"
                name="date"
                type="date"
                required
                defaultValue={todayValue()}
                className={fieldClass}
              />
            </Field>
            <Field id="reply-sentiment" label="Sentiment">
              <select
                id="reply-sentiment"
                name="sentiment"
                required
                defaultValue=""
                className={fieldClass}
              >
                <option value="" disabled>
                  Choose
                </option>
                {REPLY_SENTIMENTS.map((s) => (
                  <option key={s} value={s}>
                    {sentimentLabel(s)}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="reply-offer" label="Offer type (optional)">
              <select id="reply-offer" name="offerType" defaultValue="none" className={fieldClass}>
                <option value="none">None yet</option>
                {OFFER_TYPES.map((o) => (
                  <option key={o} value={o}>
                    {offerTypeLabel(o)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Form>
      ) : null}

      {open === "close" ? (
        <Form action="close">
          <Field id="close-reason" label="Reason">
            <select
              id="close-reason"
              name="closeReason"
              required
              defaultValue=""
              className={fieldClass}
            >
              <option value="" disabled>
                Choose a reason
              </option>
              {CLOSE_REASONS.map((r) => (
                <option key={r} value={r}>
                  {closeReasonLabel(r)}
                </option>
              ))}
            </select>
          </Field>
          <p className="max-w-prose text-sm text-muted">
            Closing keeps the history. You can save this hotel again later to start a fresh outreach
            cycle.
          </p>
        </Form>
      ) : null}

      {state.kind !== "idle" ? (
        <div role="status" aria-live="polite" className="space-y-2">
          <p className="text-sm text-text">{state.message}</p>
          {shouldOfferWorkflowUpgrade(state) && state.kind === "limit" ? (
            <>
              <p className="max-w-prose text-sm text-muted">
                {state.explanation} {state.note}
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
