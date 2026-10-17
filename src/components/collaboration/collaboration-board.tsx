"use client";

import { useState } from "react";
import Link from "next/link";

import { V12Icon } from "@/components/icons/v12-icons";
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
import {
  ACTIVITY_CAPPED,
  ACTIVITY_EMPTY,
  ACTIVITY_ERROR,
  ACTIVITY_UNLINKED,
  activityTimelineClaim,
  approvalProgress,
  deliverablePillClass,
  inPreparationCount,
  type ActivityTimeline,
  type BoardCard,
  type BoardCompensation,
  type BoardDeliverable,
} from "@/lib/collaboration/board";
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
        <span className={deliverablePillClass(row.status)}>{row.statusLabel}</span>
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
        <V12Icon name="plus" size={15} />
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

function DeliverableRow({ row }: { row: BoardDeliverable }) {
  const detail = [row.platform, row.dueOn ? `Due ${row.dueOn}` : "No due date"]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="v12-list-item">
      <strong>
        {row.quantity} × {row.typeLabel}
      </strong>
      <p>{detail}</p>
      <span className={deliverablePillClass(row.status)}>{row.statusLabel}</span>
    </div>
  );
}

function CardView({ card }: { card: BoardCard }) {
  return (
    <div className="v12-stack">
      {card.deliverables.length === 0 ? (
        <p>No deliverables recorded.</p>
      ) : (
        card.deliverables.map((row) => <DeliverableRow key={row.id} row={row} />)
      )}
      <details className="v12-details">
        <summary>Update this collaboration</summary>
        {card.pipelineItemId ? (
          <div className="v12-stack">
            <CompensationEditor
              seed={card.compensation}
              pipelineItemId={card.pipelineItemId}
              hotelId={card.hotelId}
            />
            {card.deliverables.map((row) => (
              <DeliverableStatusForm key={row.id} row={row} hotelId={card.hotelId} />
            ))}
            <AddDeliverableForm pipelineItemId={card.pipelineItemId} hotelId={card.hotelId} />
          </div>
        ) : (
          <p>This collaboration is not linked to a pipeline cycle.</p>
        )}
      </details>
    </div>
  );
}

function ActivityTimelineView({
  pipelineItemId,
  timeline,
}: {
  pipelineItemId: string | null;
  timeline: ActivityTimeline;
}) {
  const claim = activityTimelineClaim(timeline, pipelineItemId);
  if (claim === "unlinked") return <p>{ACTIVITY_UNLINKED}</p>;
  if (claim === "error") return <p>{ACTIVITY_ERROR}</p>;
  if (claim === "empty") return <p>{ACTIVITY_EMPTY}</p>;
  const events =
    timeline.kind === "ok"
      ? timeline.events.filter((event) => event.pipelineItemId === pipelineItemId)
      : [];
  return (
    <div className="v12-timeline">
      {events.map((event, index) => (
        <div
          key={`${event.pipelineItemId}-${event.day}-${event.label}-${index}`}
          className="v12-event"
        >
          <strong>{event.label}</strong>
          <p>{event.day}</p>
        </div>
      ))}
      {timeline.kind === "ok" && timeline.capped ? <p>{ACTIVITY_CAPPED}</p> : null}
    </div>
  );
}

export function CollaborationBoardView({
  cards,
  selectedId,
  timeline,
}: {
  cards: readonly BoardCard[];
  selectedId: string | null;
  timeline: ActivityTimeline;
}) {
  const selected = cards.find((card) => card.id === selectedId) ?? cards[0];
  if (!selected) return null;
  const missingSelection = selectedId !== null && selected.id !== selectedId;
  const hotelLink = hotelHref(selected.hotelId, { kind: "collaboration" }, "collaboration");
  const progress = approvalProgress(selected.approved, selected.deliverables.length);
  const preparing = inPreparationCount(selected.deliverables);
  const context = [selected.typeLabel, selected.when, selected.statusLabel]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="v12-stack">
      <nav className="v12-picker" aria-label="Other collaborations">
        {cards.map((card) => {
          const current = card.id === selected.id;
          return (
            <Link
              key={card.id}
              href={`/app/collaborations?collaboration=${card.id}`}
              aria-current={current ? "page" : undefined}
              className={
                current ? "v12-btn v12-btn-primary v12-btn-small" : "v12-btn v12-btn-small"
              }
            >
              {card.hotelName}
            </Link>
          );
        })}
      </nav>
      {missingSelection ? (
        <p role="status">That collaboration is not in this list. Showing the first one.</p>
      ) : null}
      <div className="v12-context">
        <div>
          <strong>
            {selected.hotelName}
            {selected.displayRef ? ` · ${selected.displayRef}` : ""}
          </strong>
          <p>{context || "Status not recorded"}</p>
          {selected.displayMissing ? <p>The opportunity id could not be read.</p> : null}
        </div>
        <span className="v12-badge">{selected.statusLabel}</span>
        {hotelLink ? (
          <Link href={hotelLink} className="v12-btn v12-btn-small">
            Open hotel
          </Link>
        ) : null}
      </div>
      <div className="v12-stats">
        <div className="v12-stat">
          <span className="v12-stat-label">Deliverables</span>
          <div className="v12-stat-num">{selected.deliverables.length}</div>
          <div className="v12-stat-note">On this collaboration</div>
        </div>
        <div className="v12-stat">
          <span className="v12-stat-label">Approved</span>
          <div className="v12-stat-num">{selected.approved}</div>
          <div className="v12-stat-note">Approved status only</div>
        </div>
        <div className="v12-stat v12-stat-tint">
          <span className="v12-stat-label">In preparation</span>
          <div className="v12-stat-num">{preparing}</div>
          <div className="v12-stat-note">Pending or submitted</div>
        </div>
        <div className="v12-stat">
          <span className="v12-stat-label">Next milestone</span>
          <div className="v12-stat-num">
            {selected.datesUnreadable ? "Unreadable" : (selected.nextDue ?? "None")}
          </div>
          <div className="v12-stat-note">
            {selected.datesUnreadable ? "A date could not be read" : "Earliest open due date"}
          </div>
        </div>
      </div>
      <div className="v12-layout">
        <section className="v12-panel v12-panel-pad">
          <div className="v12-panel-head">
            <div>
              <h2>Deliverables and milestones</h2>
              <p>Progress tracks recorded deliverables, not the deal stage.</p>
            </div>
          </div>
          <div className="v12-between">
            <strong>{progress.label}</strong>
            <span>{selected.deliverables.length > 0 ? `${progress.percent}%` : "—"}</span>
          </div>
          <div className="v12-progress" aria-hidden="true">
            <span style={{ width: `${progress.width}%` }} />
          </div>
          <CardView card={selected} />
        </section>
        <aside className="v12-stack">
          <section className="v12-panel v12-panel-pad">
            <p className="v12-eyebrow">NEXT MILESTONE</p>
            <h2>
              {selected.datesUnreadable
                ? "A due date could not be read"
                : selected.nextDue
                  ? `Due ${selected.nextDue}`
                  : "No due date recorded"}
            </h2>
            <p>
              {selected.revisionRequested > 0
                ? `${selected.revisionRequested} revision request${selected.revisionRequested === 1 ? "" : "s"}`
                : "No revision is requested on this collaboration."}
            </p>
          </section>
          <section className="v12-panel v12-panel-pad">
            <h3>Agreement at a glance</h3>
            <div className="v12-list-item">
              <strong>Compensation</strong>
              <p>
                {selected.compensation
                  ? `${selected.compensation.familyLabel} · ${selected.compensation.summary}`
                  : "Compensation is not recorded. Unknown is not zero."}
              </p>
            </div>
            <div className="v12-list-item">
              <strong>Linked opportunity</strong>
              <p>
                {selected.displayRef ?? "Opportunity id unavailable"} · {selected.hotelName}
              </p>
            </div>
          </section>
        </aside>
      </div>
      <section className="v12-panel v12-panel-pad">
        <h2>Activity timeline</h2>
        <ActivityTimelineView pipelineItemId={selected.pipelineItemId} timeline={timeline} />
      </section>
    </div>
  );
}
