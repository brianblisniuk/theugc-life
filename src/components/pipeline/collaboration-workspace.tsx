"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useFormStatus } from "react-dom";

import {
  deleteDeliverableAction,
  prefillCompensationAction,
  saveCompensationAction,
  saveDeliverableAction,
} from "@/lib/collaboration/actions";
import {
  COMPENSATION_STRUCTURES,
  DELIVERABLE_STATUSES,
  DELIVERABLE_TYPES,
  paymentStatusesFor,
  type CompensationStructure,
  type DeliverableStatus,
  type DeliverableType,
  type PaymentStatus,
} from "@/lib/collaboration/contract";
import { ISO_CURRENCIES } from "@/lib/collaboration/currencies";
import {
  attributedValueLabel,
  compensationStructureLabel,
  deliverableStatusLabel,
  deliverableTypeLabel,
  minorToMajorInput,
  paymentStatusLabel,
  valuationLabel,
} from "@/lib/collaboration/display";
import type { CollaborationWorkspace } from "@/lib/collaboration/contract";

const fieldClass =
  "w-full rounded-[var(--radius-app)] border border-border bg-background px-3 py-2 text-sm text-text";
const labelClass = "block text-xs font-medium text-muted";

const CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  ...ISO_CURRENCIES.filter((code) => code !== "USD" && code !== "EUR" && code !== "GBP"),
];

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

function outcomeText(result: string | null): string | null {
  if (!result) return null;
  if (result === "saved" || result === "deleted" || result === "suggested") return "Saved";
  if (result === "no_current_machine_compensation") {
    return "No current machine reading to suggest. Your record was not changed.";
  }
  if (result === "invalid_input") return "Check the values and try again.";
  return "Could not save";
}

export function CollaborationWorkspace({
  pipelineItemId,
  hotelId,
  initial,
}: {
  pipelineItemId: string;
  hotelId: string;
  initial: CollaborationWorkspace;
}) {
  const saved = initial.compensation;
  const [structure, setStructure] = useState<CompensationStructure>(saved?.structure ?? "unknown");
  const [payment, setPayment] = useState<PaymentStatus>(saved?.payment_status ?? "not_applicable");
  const [estimate, setEstimate] = useState(
    minorToMajorInput(
      saved?.in_kind_estimate_minor ?? null,
      saved?.in_kind_estimate_currency ?? null,
    ),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [prefillMessage, setPrefillMessage] = useState<string | null>(null);
  const payments = paymentStatusesFor(structure);
  const showCash = structure === "paid" || structure === "hybrid";
  const showKind = structure === "in_kind" || structure === "hybrid";

  function onStructure(next: CompensationStructure) {
    setStructure(next);
    const allowed = paymentStatusesFor(next);
    if (!allowed.includes(payment)) setPayment(allowed[0]!);
  }

  return (
    <div className="space-y-4 border-t border-border pt-4">
      <div className="space-y-1">
        <h5 className="text-sm font-semibold text-text">Agreed compensation</h5>
        <p className="max-w-prose text-sm text-muted">
          Your record of what this collaboration is worth. Nothing is charged. The value beside each
          deliverable is derived from this record.
        </p>
        <p className="text-sm text-text">
          Collaboration value:{" "}
          <span className="font-medium">{valuationLabel(initial.valuation)}</span>
        </p>
      </div>

      {initial.suggestion ? (
        <div className="space-y-2 rounded-[var(--radius-app)] border border-border bg-background p-3">
          <p className="text-sm text-text">
            Machine suggestion: {compensationStructureLabel(initial.suggestion.structure)}. This is
            not your record.
          </p>
          {saved ? (
            <p className="text-xs text-muted">
              A suggestion never replaces compensation you have saved.
            </p>
          ) : (
            <button
              type="button"
              className="text-xs text-muted underline hover:text-text"
              onClick={() => onStructure(initial.suggestion!.structure)}
            >
              Use this structure in the form
            </button>
          )}
        </div>
      ) : null}

      <form
        className="space-y-3"
        action={async (formData) => {
          const outcome = await saveCompensationAction(formData);
          setMessage(outcomeText(outcome.result));
        }}
      >
        <input type="hidden" name="pipelineItemId" value={pipelineItemId} />
        <input type="hidden" name="hotelId" value={hotelId} />
        <label className={labelClass} htmlFor="compensation-structure">
          Type
        </label>
        <select
          id="compensation-structure"
          name="structure"
          className={fieldClass}
          value={structure}
          onChange={(event) => onStructure(event.target.value as CompensationStructure)}
        >
          {COMPENSATION_STRUCTURES.map((value) => (
            <option key={value} value={value}>
              {compensationStructureLabel(value)}
            </option>
          ))}
        </select>

        {showCash ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className={labelClass} htmlFor="cash-amount">
                Cash amount
              </label>
              <input
                id="cash-amount"
                name="cashAmount"
                inputMode="decimal"
                defaultValue={
                  saved && (saved.structure === "paid" || saved.structure === "hybrid")
                    ? minorToMajorInput(saved.cash_amount_minor, saved.cash_currency)
                    : ""
                }
                className={fieldClass}
              />
            </div>
            <div className="space-y-1">
              <label className={labelClass} htmlFor="cash-currency">
                Cash currency
              </label>
              <select
                id="cash-currency"
                name="cashCurrency"
                className={fieldClass}
                defaultValue={saved?.cash_currency ?? "USD"}
              >
                {CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : null}

        {showKind ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <label className={labelClass} htmlFor="in-kind-description">
                Product or stay
              </label>
              <textarea
                id="in-kind-description"
                name="inKindDescription"
                rows={2}
                defaultValue={saved?.in_kind_description ?? ""}
                className={fieldClass}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className={labelClass} htmlFor="in-kind-estimate">
                  Your estimate (optional)
                </label>
                <input
                  id="in-kind-estimate"
                  name="inKindEstimate"
                  inputMode="decimal"
                  value={estimate}
                  onChange={(event) => setEstimate(event.target.value)}
                  className={fieldClass}
                />
              </div>
              <div className="space-y-1">
                <label className={labelClass} htmlFor="in-kind-currency">
                  Estimate currency
                </label>
                {/* An empty estimate is optional. Posting the default currency
                    alone makes the parser require an amount. */}
                <select
                  id="in-kind-currency"
                  name={estimate.trim() === "" ? undefined : "inKindEstimateCurrency"}
                  className={fieldClass}
                  defaultValue={saved?.in_kind_estimate_currency ?? "USD"}
                >
                  {CURRENCIES.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="text-xs text-muted">An in-kind number is your estimate, not a charge.</p>
          </div>
        ) : null}

        <div className="space-y-1">
          <label className={labelClass} htmlFor="payment-status">
            Payment status
          </label>
          <select
            id="payment-status"
            name="paymentStatus"
            className={fieldClass}
            value={payment}
            onChange={(event) => setPayment(event.target.value as PaymentStatus)}
          >
            {payments.map((value) => (
              <option key={value} value={value}>
                {paymentStatusLabel(value)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-3">
          <SubmitButton label="Save compensation" />
          {message ? <span className="text-xs text-muted">{message}</span> : null}
        </div>
      </form>

      <form
        className="space-y-2"
        action={async (formData) => {
          const outcome = await prefillCompensationAction(formData);
          setPrefillMessage(outcomeText(outcome.result));
        }}
      >
        <input type="hidden" name="pipelineItemId" value={pipelineItemId} />
        <input type="hidden" name="hotelId" value={hotelId} />
        <p className="text-xs text-muted">
          Ask a Gmail reading to suggest a structure. It never overwrites compensation you have
          saved.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <input
            name="mailAccountId"
            placeholder="Mailbox id"
            aria-label="Mailbox id"
            className={fieldClass}
          />
          <input
            name="providerThreadId"
            placeholder="Gmail thread id"
            aria-label="Gmail thread id"
            className={fieldClass}
          />
        </div>
        <div className="flex items-center gap-3">
          <SubmitButton label="Suggest structure" />
          {prefillMessage ? <span className="text-xs text-muted">{prefillMessage}</span> : null}
        </div>
      </form>

      <div className="space-y-3">
        <h5 className="text-sm font-semibold text-text">Deliverables</h5>
        {initial.deliverables.length === 0 ? (
          <p className="text-sm text-muted">No deliverables yet.</p>
        ) : (
          <ul className="space-y-3">
            {initial.deliverables.map((row) => (
              <li
                key={row.id}
                className="space-y-2 rounded-[var(--radius-app)] border border-border p-3"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium text-text">
                    {row.quantity} × {deliverableTypeLabel(row.deliverable_type)}
                    {row.platform ? ` · ${row.platform}` : ""}
                  </p>
                  <p className="text-sm text-text">{attributedValueLabel(row.attributed_value)}</p>
                </div>
                <p className="text-xs text-muted">
                  {deliverableStatusLabel(row.status)}
                  {row.due_on ? ` · due ${row.due_on}` : ""}
                  {row.attributed_value.kind === "derived"
                    ? " · derived value"
                    : " · value unknown"}
                </p>
                <DeliverableForm
                  pipelineItemId={pipelineItemId}
                  hotelId={hotelId}
                  deliverableId={row.id}
                  deliverableType={row.deliverable_type}
                  quantity={row.quantity}
                  platform={row.platform}
                  dueOn={row.due_on}
                  status={row.status}
                  proofUrl={row.proof_url}
                  notes={row.notes}
                />
              </li>
            ))}
          </ul>
        )}
        <DeliverableForm pipelineItemId={pipelineItemId} hotelId={hotelId} />
      </div>
    </div>
  );
}

function DeliverableForm({
  pipelineItemId,
  hotelId,
  deliverableId,
  deliverableType = "reel",
  quantity = 1,
  platform,
  dueOn,
  status = "pending",
  proofUrl,
  notes,
}: {
  pipelineItemId: string;
  hotelId: string;
  deliverableId?: string;
  deliverableType?: DeliverableType;
  quantity?: number;
  platform?: string | null;
  dueOn?: string | null;
  status?: DeliverableStatus;
  proofUrl?: string | null;
  notes?: string | null;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <form
      className="space-y-2"
      aria-label={deliverableId ? "Update deliverable" : "Add deliverable"}
      // The server parser is the authority. A native date or number tooltip
      // would swallow the submit and never reach that parser.
      noValidate
      action={async (formData) => {
        const outcome = await saveDeliverableAction(formData);
        setMessage(outcomeText(outcome.result));
        if (outcome.result === "saved") router.refresh();
      }}
    >
      <input type="hidden" name="pipelineItemId" value={pipelineItemId} />
      <input type="hidden" name="hotelId" value={hotelId} />
      {deliverableId ? <input type="hidden" name="deliverableId" value={deliverableId} /> : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <select
          name="deliverableType"
          defaultValue={deliverableType}
          className={fieldClass}
          aria-label="Deliverable type"
        >
          {DELIVERABLE_TYPES.map((value) => (
            <option key={value} value={value}>
              {deliverableTypeLabel(value)}
            </option>
          ))}
        </select>
        <input
          name="quantity"
          type="number"
          min={1}
          max={10000}
          defaultValue={quantity}
          aria-label="Quantity"
          className={fieldClass}
        />
        <input
          name="platform"
          defaultValue={platform ?? ""}
          placeholder="Platform"
          aria-label="Platform"
          className={fieldClass}
        />
        <input
          name="dueOn"
          type="date"
          defaultValue={dueOn ?? ""}
          aria-label="Due date"
          className={fieldClass}
        />
        <select
          name="status"
          defaultValue={status}
          className={fieldClass}
          aria-label="Deliverable status"
        >
          {DELIVERABLE_STATUSES.map((value) => (
            <option key={value} value={value}>
              {deliverableStatusLabel(value)}
            </option>
          ))}
        </select>
        <input
          name="proofUrl"
          defaultValue={proofUrl ?? ""}
          placeholder="https proof link"
          aria-label="Proof URL"
          className={fieldClass}
        />
      </div>
      <textarea
        name="notes"
        rows={2}
        defaultValue={notes ?? ""}
        placeholder="Notes"
        aria-label="Deliverable notes"
        className={fieldClass}
      />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton label={deliverableId ? "Update deliverable" : "Add deliverable"} />
        {deliverableId ? (
          <button
            type="submit"
            formAction={async (formData) => {
              const outcome = await deleteDeliverableAction(formData);
              setMessage(outcomeText(outcome.result));
            }}
            className="text-xs text-muted underline"
          >
            Remove
          </button>
        ) : null}
        {message ? <span className="text-xs text-muted">{message}</span> : null}
      </div>
    </form>
  );
}
