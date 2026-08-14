"use client";

/**
 * Collaboration lifecycle controls (PRD §7.4, D045).
 *
 * The same posture as the outreach workflow: only the steps legal from the
 * current collaboration status are offered, each opens the two or three fields
 * it actually needs, and every form posts to a server action so identity and
 * the state machine are resolved server-side.
 *
 * Dates follow Sprint 2C's rule — the browser converts the creator's chosen
 * calendar day, because only it knows their timezone — and send both the
 * instant (for the domain event) and the plain day (for the DATE columns).
 */
import { useState } from "react";
import { useFormStatus } from "react-dom";

import { capture } from "@/lib/analytics";
import { progressCollaborationAction } from "@/lib/pipeline/actions";
import { localDateToIso } from "@/lib/pipeline/input";
import {
  CANCELLATION_REASONS,
  TERMS_MATCHED_VALUES,
  cancellationReasonLabel,
  collaborationActionLabel,
  termsMatchedLabel,
  type CollaborationAction,
  type CollaborationResult,
} from "@/lib/pipeline/types";
import { lifecycleControlState } from "@/lib/pipeline/view";

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

export function CollaborationLifecycle({
  pipelineItemId,
  hotelId,
  actions,
}: {
  pipelineItemId: string;
  hotelId: string;
  actions: readonly CollaborationAction[];
}) {
  const [open, setOpen] = useState<CollaborationAction | null>(null);
  const [result, setResult] = useState<CollaborationResult | null>(null);
  const state = lifecycleControlState(result);

  async function onSubmit(formData: FormData) {
    // `schedule` is planning state and emits no event, so it needs no instant —
    // only the calendar dates the DATE columns store.
    const day = formData.get("day");
    if (typeof day === "string" && day !== "") {
      formData.set("eventAt", localDateToIso(day) ?? "");
    }

    const outcome = await progressCollaborationAction(formData);
    setResult(outcome);
    if (outcome.result === "applied") {
      setOpen(null);
      // Product analytics only — outreach_events remains the source of truth.
      capture("pipeline_status_changed", {
        hotel_id: hotelId,
        status: outcome.pipelineStatus,
      });
    }
  }

  function Form({ action, children }: { action: CollaborationAction; children?: React.ReactNode }) {
    return (
      <form action={onSubmit} className="space-y-3">
        <input type="hidden" name="pipelineItemId" value={pipelineItemId} />
        <input type="hidden" name="hotelId" value={hotelId} />
        <input type="hidden" name="action" value={action} />
        {children}
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton label={collaborationActionLabel(action)} />
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
              {collaborationActionLabel(action)}
            </button>
          ))}
        </div>
      ) : null}

      {open === "schedule" ? (
        <Form action="schedule">
          <div className="flex flex-wrap gap-3">
            <Field id="schedule-start" label="Start date">
              <input
                id="schedule-start"
                name="startDate"
                type="date"
                required
                defaultValue={todayValue()}
                className={fieldClass}
              />
            </Field>
            <Field id="schedule-end" label="End date (optional)">
              <input id="schedule-end" name="endDate" type="date" className={fieldClass} />
            </Field>
          </div>
          <p className="max-w-prose text-sm text-muted">
            Planned dates only — nothing is recorded as activity until the collaboration starts.
          </p>
        </Form>
      ) : null}

      {open === "start" ? (
        <Form action="start">
          <Field id="start-date" label="Start date">
            {/* One picker feeding both the event instant and the DATE column. */}
            <input
              id="start-date"
              name="day"
              type="date"
              required
              defaultValue={todayValue()}
              className={fieldClass}
              onChange={(event) => {
                const form = event.currentTarget.form;
                const hidden = form?.elements.namedItem("startDate");
                if (hidden instanceof HTMLInputElement) hidden.value = event.currentTarget.value;
              }}
            />
          </Field>
          <input type="hidden" name="startDate" defaultValue={todayValue()} />
        </Form>
      ) : null}

      {open === "complete" ? (
        <Form action="complete">
          <div className="flex flex-wrap gap-3">
            <Field id="complete-date" label="End date">
              <input
                id="complete-date"
                name="day"
                type="date"
                required
                defaultValue={todayValue()}
                className={fieldClass}
                onChange={(event) => {
                  const form = event.currentTarget.form;
                  const hidden = form?.elements.namedItem("endDate");
                  if (hidden instanceof HTMLInputElement) hidden.value = event.currentTarget.value;
                }}
              />
            </Field>
            <Field id="complete-terms" label="Did they match the agreed terms?">
              <select
                id="complete-terms"
                name="termsMatched"
                required
                defaultValue=""
                className={fieldClass}
              >
                <option value="" disabled>
                  Choose
                </option>
                {TERMS_MATCHED_VALUES.map((value) => (
                  <option key={value} value={value}>
                    {termsMatchedLabel(value)}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="complete-again" label="Work with them again?">
              <select
                id="complete-again"
                name="wouldWorkAgain"
                defaultValue="unknown"
                className={fieldClass}
              >
                <option value="yes">Yes</option>
                <option value="no">No</option>
                <option value="unknown">Not sure</option>
              </select>
            </Field>
          </div>
          <input type="hidden" name="endDate" defaultValue={todayValue()} />
        </Form>
      ) : null}

      {open === "cancel" ? (
        <Form action="cancel">
          <div className="flex flex-wrap gap-3">
            <Field id="cancel-reason" label="Reason">
              <select
                id="cancel-reason"
                name="cancelReason"
                required
                defaultValue=""
                className={fieldClass}
              >
                <option value="" disabled>
                  Choose a reason
                </option>
                {CANCELLATION_REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {cancellationReasonLabel(reason)}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="cancel-date" label="Date">
              <input
                id="cancel-date"
                name="day"
                type="date"
                required
                defaultValue={todayValue()}
                className={fieldClass}
                onChange={(event) => {
                  const form = event.currentTarget.form;
                  const hidden = form?.elements.namedItem("endDate");
                  if (hidden instanceof HTMLInputElement) hidden.value = event.currentTarget.value;
                }}
              />
            </Field>
          </div>
          <input type="hidden" name="endDate" defaultValue={todayValue()} />
          <p className="max-w-prose text-sm text-muted">
            Cancelling closes this relationship cycle. The deal you won stays on record — you can
            save this hotel again later to start a new one.
          </p>
        </Form>
      ) : null}

      {state.kind !== "idle" ? (
        <div role="status" aria-live="polite">
          <p className="text-sm text-text">{state.message}</p>
        </div>
      ) : null}
    </div>
  );
}
