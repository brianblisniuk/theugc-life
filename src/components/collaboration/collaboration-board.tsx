"use client";

import { useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  COMPENSATION_STRUCTURES,
  DELIVERABLE_STATUSES,
  DELIVERABLE_TYPES,
  paymentStatusesFor,
  type CompensationStructure,
  type PaymentStatus,
} from "@/lib/collaboration/contract";
import {
  compensationStructureLabel,
  deliverableStatusLabel,
  deliverableTypeLabel,
  paymentStatusLabel,
} from "@/lib/collaboration/display";
import type { BoardCard, BoardCompensation, BoardDeliverable } from "@/lib/collaboration/board";
import { saveCompensationAction, saveDeliverableAction } from "@/lib/collaboration/actions";
import { hotelHref } from "@/lib/shell/navigation";

function resultText(result: string | null): string | null {
  if (!result) return null;
  if (result === "saved") return "Saved";
  if (result === "invalid_input") return "Check the values and try again.";
  return "Could not save";
}

function DeliverableStatusForm({ row, hotelId }: { row: BoardDeliverable; hotelId: string }) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <form
      className="s6-deliverable"
      action={async (formData) => {
        const result = await saveDeliverableAction(formData);
        setMessage(resultText(result.result));
      }}
    >
      <input type="hidden" name="pipelineItemId" value={row.pipelineItemId} />
      <input type="hidden" name="hotelId" value={hotelId} />
      <input type="hidden" name="deliverableId" value={row.id} />
      <input type="hidden" name="deliverableType" value={row.deliverableType} />
      <input type="hidden" name="quantity" value={String(row.quantity)} />
      <input type="hidden" name="platform" value={row.platform ?? ""} />
      <input type="hidden" name="dueOn" value={row.dueOn ?? ""} />
      <input type="hidden" name="proofUrl" value={row.proofUrl ?? ""} />
      <input type="hidden" name="notes" value={row.notes ?? ""} />
      <div>
        <strong>
          {row.quantity} × {row.typeLabel}
        </strong>
        <p className="s6-muted">
          {[row.platform, row.dueOn ? `Due ${row.dueOn}` : "No due date"]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      <label className="v12-field">
        <span>Status</span>
        <select name="status" defaultValue={row.status}>
          {DELIVERABLE_STATUSES.map((status) => (
            <option key={status} value={status}>
              {deliverableStatusLabel(status)}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" size="small">
        Save status
      </Button>
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}

function AddDeliverableForm({
  pipelineItemId,
  hotelId,
}: {
  pipelineItemId: string;
  hotelId: string;
}) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <form
      className="s6-add"
      action={async (formData) => {
        const result = await saveDeliverableAction(formData);
        setMessage(resultText(result.result));
      }}
    >
      <input type="hidden" name="pipelineItemId" value={pipelineItemId} />
      <input type="hidden" name="hotelId" value={hotelId} />
      <input type="hidden" name="deliverableId" value="" />
      <input type="hidden" name="proofUrl" value="" />
      <input type="hidden" name="notes" value="" />
      <label className="v12-field">
        <span>Type</span>
        <select name="deliverableType" defaultValue="reel">
          {DELIVERABLE_TYPES.map((type) => (
            <option key={type} value={type}>
              {deliverableTypeLabel(type)}
            </option>
          ))}
        </select>
      </label>
      <label className="v12-field">
        <span>Quantity</span>
        <input name="quantity" type="number" min={1} max={10000} defaultValue={1} required />
      </label>
      <label className="v12-field">
        <span>Platform</span>
        <input name="platform" type="text" maxLength={80} />
      </label>
      <label className="v12-field">
        <span>Due date</span>
        <input name="dueOn" type="date" />
      </label>
      <label className="v12-field">
        <span>Status</span>
        <select name="status" defaultValue="pending">
          {DELIVERABLE_STATUSES.map((status) => (
            <option key={status} value={status}>
              {deliverableStatusLabel(status)}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" size="small">
        Add deliverable
      </Button>
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}

function CompensationEditor({
  seed,
  pipelineItemId,
  hotelId,
}: {
  seed: BoardCompensation | null;
  pipelineItemId: string;
  hotelId: string;
}) {
  const [structure, setStructure] = useState<CompensationStructure>(seed?.structure ?? "unknown");
  const [payment, setPayment] = useState<PaymentStatus>(seed?.paymentStatus ?? "not_applicable");
  const [message, setMessage] = useState<string | null>(null);
  const payments = paymentStatusesFor(structure);
  const paymentValue = payments.includes(payment) ? payment : payments[0];
  const showCash = structure === "paid" || structure === "hybrid";
  const showKind = structure === "in_kind" || structure === "hybrid";
  return (
    <form
      className="s6-add"
      action={async (formData) => {
        const result = await saveCompensationAction(formData);
        setMessage(resultText(result.result));
      }}
    >
      <input type="hidden" name="pipelineItemId" value={pipelineItemId} />
      <input type="hidden" name="hotelId" value={hotelId} />
      <label className="v12-field">
        <span>Compensation</span>
        <select
          name="structure"
          value={structure}
          onChange={(event) => {
            const next = event.target.value as CompensationStructure;
            setStructure(next);
            const nextPayments = paymentStatusesFor(next);
            setPayment(nextPayments[0] ?? "not_applicable");
          }}
        >
          {COMPENSATION_STRUCTURES.map((value) => (
            <option key={value} value={value}>
              {value === "in_kind"
                ? "Barter"
                : value === "paid"
                  ? "Payment"
                  : value === "hybrid"
                    ? "Barter and payment"
                    : compensationStructureLabel(value)}
            </option>
          ))}
        </select>
      </label>
      {showCash ? (
        <>
          <label className="v12-field">
            <span>Cash amount</span>
            <input name="cashAmount" defaultValue={seed?.cashAmount ?? ""} inputMode="decimal" />
          </label>
          <label className="v12-field">
            <span>Cash currency</span>
            <input name="cashCurrency" defaultValue={seed?.cashCurrency || "USD"} maxLength={3} />
          </label>
        </>
      ) : null}
      {showKind ? (
        <>
          <label className="v12-field">
            <span>Barter</span>
            <input
              name="inKindDescription"
              defaultValue={seed?.inKindDescription ?? ""}
              maxLength={500}
            />
          </label>
          <label className="v12-field">
            <span>Estimate</span>
            <input
              name="inKindEstimate"
              defaultValue={seed?.inKindEstimate ?? ""}
              inputMode="decimal"
            />
          </label>
          <label className="v12-field">
            <span>Estimate currency</span>
            <input
              name="inKindEstimateCurrency"
              defaultValue={seed?.inKindEstimateCurrency ?? ""}
              maxLength={3}
            />
          </label>
        </>
      ) : null}
      <label className="v12-field">
        <span>Payment status</span>
        <select
          name="paymentStatus"
          value={paymentValue}
          onChange={(event) => setPayment(event.target.value as PaymentStatus)}
        >
          {payments.map((value) => (
            <option key={value} value={value}>
              {paymentStatusLabel(value)}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" size="small">
        Save compensation
      </Button>
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}

function CardView({ card }: { card: BoardCard }) {
  const href = hotelHref(card.hotelId, { kind: "collaboration" }, "collaboration");
  return (
    <article className="v12-card v12-card-pad s6-card">
      <header className="s6-card-head">
        <div>
          <p className="s6-eyebrow">{card.displayRef ?? "Collaboration"}</p>
          <h2>{card.hotelName}</h2>
          <p className="s6-muted">
            {card.statusLabel}
            {card.typeLabel ? ` · ${card.typeLabel}` : ""}
            {card.when ? ` · ${card.when}` : ""}
          </p>
          {card.displayMissing ? (
            <p className="s6-muted">The opportunity id could not be read.</p>
          ) : null}
        </div>
        {href ? (
          <Link href={href} className="v12-btn v12-btn-small">
            Open hotel
          </Link>
        ) : null}
      </header>
      <div className="s6-stats">
        <div>
          <span>Deliverables</span>
          <strong>{card.deliverables.length}</strong>
        </div>
        <div>
          <span>Approved</span>
          <strong>{card.approved}</strong>
        </div>
        <div>
          <span>Revision requested</span>
          <strong>{card.revisionRequested}</strong>
        </div>
        <div>
          <span>Next deadline</span>
          <strong>{card.datesUnreadable ? "Unreadable" : (card.nextDue ?? "None")}</strong>
        </div>
      </div>
      <section>
        <h3>Compensation</h3>
        {card.compensation ? (
          <p>
            <span className="v12-badge v12-badge-lime">{card.compensation.familyLabel}</span>{" "}
            {card.compensation.summary} · {card.compensation.paymentLabel}
          </p>
        ) : (
          <p className="s6-muted">Compensation is not recorded. Unknown is not zero.</p>
        )}
        {card.pipelineItemId ? (
          <CompensationEditor
            seed={card.compensation}
            pipelineItemId={card.pipelineItemId}
            hotelId={card.hotelId}
          />
        ) : (
          <p className="s6-muted">This collaboration is not linked to a pipeline cycle.</p>
        )}
      </section>
      <section>
        <h3>Deliverables</h3>
        {card.deliverables.length === 0 ? (
          <p className="s6-muted">No deliverables recorded.</p>
        ) : (
          <ul className="s6-list">
            {card.deliverables.map((row) => (
              <li key={row.id}>
                {card.pipelineItemId ? (
                  <DeliverableStatusForm row={row} hotelId={card.hotelId} />
                ) : (
                  <p>
                    {row.quantity} × {row.typeLabel} · {row.statusLabel}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        {card.pipelineItemId ? (
          <AddDeliverableForm pipelineItemId={card.pipelineItemId} hotelId={card.hotelId} />
        ) : null}
      </section>
    </article>
  );
}

export function CollaborationBoardView({ cards }: { cards: readonly BoardCard[] }) {
  return (
    <div className="s6-stack">
      {cards.map((card) => (
        <CardView key={card.id} card={card} />
      ))}
    </div>
  );
}
