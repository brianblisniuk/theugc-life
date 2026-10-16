/**
 * Collaborations board (D078, D186).
 *
 * Deliverable status and agreed compensation are the creator's rows.
 * `revision_requested` is a production state. It is not a deadline and it is
 * not approval. Barter, payment, and both are display names for in-kind,
 * paid, and hybrid. Unknown compensation stays unknown, never zero.
 * Another creator's row is a failed read, not an empty collaboration.
 */
import {
  COMPENSATION_STRUCTURES,
  DELIVERABLE_STATUSES,
  DELIVERABLE_TYPES,
  PAYMENT_STATUSES,
  type CompensationStructure,
  type DeliverableStatus,
  type DeliverableType,
  type PaymentStatus,
} from "@/lib/collaboration/contract";
import { MAX_MINOR_AMOUNT, isIsoCurrency } from "@/lib/collaboration/currencies";
import {
  compensationStructureLabel,
  deliverableStatusLabel,
  deliverableTypeLabel,
  formatMinor,
  minorToMajorInput,
  paymentStatusLabel,
} from "@/lib/collaboration/display";
import { isUuid } from "@/lib/hotels/ids";
import { collaborationStatusLabel, collaborationTypeLabel } from "@/lib/pipeline/types";

export const BOARD_READ_LIMIT = 80;

export const AGREED_IS_NOT_APPROVED =
  "Agreed does not mean approved. The deal stage and each deliverable stay separate.";

const DISPLAY_REF = /^OP-[1-9][0-9]{3,}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const COLLABORATION_TYPES = new Set(["stay", "product", "paid", "stay_plus_paid", "other"]);

export type CompensationFamily = "barter" | "payment" | "both";

export interface BoardDeliverable {
  id: string;
  pipelineItemId: string;
  deliverableType: DeliverableType;
  typeLabel: string;
  quantity: number;
  platform: string | null;
  dueOn: string | null;
  status: DeliverableStatus;
  statusLabel: string;
  proofUrl: string | null;
  notes: string | null;
}

export interface BoardCompensation {
  family: CompensationFamily | null;
  familyLabel: string;
  structure: CompensationStructure;
  structureLabel: string;
  summary: string;
  paymentLabel: string;
  cashAmount: string;
  cashCurrency: string;
  inKindDescription: string;
  inKindEstimate: string;
  inKindEstimateCurrency: string;
  paymentStatus: PaymentStatus;
}

export interface BoardCard {
  id: string;
  hotelId: string;
  hotelName: string;
  pipelineItemId: string | null;
  displayRef: string | null;
  displayMissing: boolean;
  statusLabel: string;
  typeLabel: string | null;
  when: string | null;
  deliverables: BoardDeliverable[];
  approved: number;
  revisionRequested: number;
  nextDue: string | null;
  datesUnreadable: boolean;
  compensation: BoardCompensation | null;
}

export type CollaborationBoard =
  | { kind: "error"; title: string; body: string }
  | {
      kind: "empty";
      title: string;
      body: string;
      cta: { href: string; label: string };
    }
  | { kind: "items"; cards: BoardCard[]; summary: string; capped: boolean };

const ERROR = {
  kind: "error" as const,
  title: "We couldn’t load your collaborations",
  body: "We couldn’t load your collaborations. This is not an empty list. Reload the page to try again.",
};

const EMPTY = {
  kind: "empty" as const,
  title: "No collaborations yet",
  body: "A collaboration appears here after you mark a pipeline cycle won. An empty list is not a failed load.",
  cta: { href: "/app/pipeline", label: "Open your pipeline" },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  return row as Record<string, unknown>;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function minor(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_MINOR_AMOUNT
  ) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed <= MAX_MINOR_AMOUNT) return parsed;
  }
  return undefined;
}

function textOrNull(value: unknown, max: number): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

function calendarDay(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || !DAY.test(value)) return undefined;
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!year || !month || !day) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return value;
}

export function compensationFamily(structure: CompensationStructure): CompensationFamily | null {
  if (structure === "in_kind") return "barter";
  if (structure === "paid") return "payment";
  if (structure === "hybrid") return "both";
  return null;
}

export function compensationFamilyLabel(family: CompensationFamily | null): string {
  if (family === "barter") return "Barter";
  if (family === "payment") return "Payment";
  if (family === "both") return "Barter and payment";
  return "Not a barter or a payment";
}

function compensationSummary(input: {
  structure: CompensationStructure;
  cashAmountMinor: number | null;
  cashCurrency: string | null;
  inKindDescription: string | null;
  inKindEstimateMinor: number | null;
  inKindEstimateCurrency: string | null;
}): string {
  if (input.structure === "unknown") return "Unknown";
  if (input.structure === "unpaid") return "No compensation (unpaid)";
  if (input.structure === "other") return "Other";
  const cash =
    input.structure === "paid" || input.structure === "hybrid"
      ? formatMinor(input.cashAmountMinor, input.cashCurrency)
      : null;
  const kind = input.inKindDescription;
  const estimate =
    input.inKindEstimateMinor === null
      ? null
      : `estimate ${formatMinor(input.inKindEstimateMinor, input.inKindEstimateCurrency)}`;
  if (input.structure === "paid") return cash ?? "Unknown";
  if (input.structure === "in_kind") {
    return [kind, estimate ?? "estimate unknown"].filter(Boolean).join(" · ");
  }
  return [cash, kind, estimate ?? "in-kind estimate unknown"].filter(Boolean).join(" · ");
}

/** Approval is only the approved status. Agreement never counts as approval. */
export function countApproved(rows: readonly { status: string }[]): number {
  return rows.filter((row) => row.status === "approved").length;
}

function nextDue(rows: readonly BoardDeliverable[]): {
  nextDue: string | null;
  datesUnreadable: boolean;
} {
  let unreadable = false;
  let earliest: string | null = null;
  for (const row of rows) {
    if (row.status !== "pending" && row.status !== "rejected") continue;
    if (row.dueOn === null) continue;
    if (!DAY.test(row.dueOn)) {
      unreadable = true;
      continue;
    }
    if (earliest === null || row.dueOn < earliest) earliest = row.dueOn;
  }
  return { nextDue: earliest, datesUnreadable: unreadable };
}

export function assembleCollaborationBoard(input: {
  viewerId: string | null;
  failed: boolean;
  total: number | null;
  collaborations: readonly unknown[];
  deliverables: readonly unknown[];
  compensations: readonly unknown[];
  pipelineItems: readonly unknown[];
  childFailed: boolean;
}): CollaborationBoard {
  if (
    input.failed ||
    input.childFailed ||
    input.viewerId === null ||
    !isUuid(input.viewerId) ||
    input.total === null
  ) {
    return ERROR;
  }
  if (input.collaborations.length > BOARD_READ_LIMIT) return ERROR;
  if (input.deliverables.length > BOARD_READ_LIMIT) return ERROR;
  if (input.compensations.length > BOARD_READ_LIMIT) return ERROR;

  const displayByPipeline = new Map<string, string>();
  for (const raw of input.pipelineItems) {
    const row = asRecord(raw);
    if (!row || row.creator_id !== input.viewerId) return ERROR;
    if (typeof row.id !== "string" || !isUuid(row.id)) return ERROR;
    if (typeof row.display_ref !== "string" || !DISPLAY_REF.test(row.display_ref)) return ERROR;
    displayByPipeline.set(row.id, row.display_ref);
  }

  const deliverablesByCollaboration = new Map<string, BoardDeliverable[]>();
  for (const raw of input.deliverables) {
    const row = asRecord(raw);
    if (!row || row.creator_id !== input.viewerId) return ERROR;
    if (typeof row.id !== "string" || !isUuid(row.id)) return ERROR;
    if (typeof row.collaboration_id !== "string" || !isUuid(row.collaboration_id)) return ERROR;
    if (typeof row.pipeline_item_id !== "string" || !isUuid(row.pipeline_item_id)) return ERROR;
    const deliverableType = oneOf(row.deliverable_type, DELIVERABLE_TYPES);
    const status = oneOf(row.status, DELIVERABLE_STATUSES);
    if (!deliverableType || !status) return ERROR;
    const quantity =
      typeof row.quantity === "number" && Number.isInteger(row.quantity)
        ? row.quantity
        : typeof row.quantity === "string" && /^\d+$/.test(row.quantity)
          ? Number(row.quantity)
          : null;
    if (quantity === null || quantity < 1 || quantity > 10_000) return ERROR;
    const platform = textOrNull(row.platform, 80);
    const notes = textOrNull(row.notes, 2000);
    const dueOn = calendarDay(row.due_on);
    const proof =
      row.proof_url === null
        ? null
        : typeof row.proof_url === "string" && row.proof_url.startsWith("https://")
          ? row.proof_url
          : undefined;
    if (
      platform === undefined ||
      notes === undefined ||
      dueOn === undefined ||
      proof === undefined
    ) {
      return ERROR;
    }
    const item: BoardDeliverable = {
      id: row.id,
      pipelineItemId: row.pipeline_item_id,
      deliverableType,
      typeLabel: deliverableTypeLabel(deliverableType),
      quantity,
      platform,
      dueOn,
      status,
      statusLabel: deliverableStatusLabel(status),
      proofUrl: proof,
      notes,
    };
    const list = deliverablesByCollaboration.get(row.collaboration_id) ?? [];
    list.push(item);
    deliverablesByCollaboration.set(row.collaboration_id, list);
  }

  const compensationByCollaboration = new Map<string, BoardCompensation>();
  for (const raw of input.compensations) {
    const row = asRecord(raw);
    if (!row || row.creator_id !== input.viewerId) return ERROR;
    if (typeof row.collaboration_id !== "string" || !isUuid(row.collaboration_id)) return ERROR;
    const structure = oneOf(row.structure, COMPENSATION_STRUCTURES);
    const paymentStatus = oneOf(row.payment_status, PAYMENT_STATUSES);
    if (!structure || !paymentStatus) return ERROR;
    const cashAmountMinor = minor(row.cash_amount_minor);
    const estimateMinor = minor(row.in_kind_estimate_minor);
    const description = textOrNull(row.in_kind_description, 500);
    if (cashAmountMinor === undefined || estimateMinor === undefined || description === undefined) {
      return ERROR;
    }
    const cashCurrency =
      row.cash_currency === null
        ? null
        : typeof row.cash_currency === "string" && isIsoCurrency(row.cash_currency)
          ? row.cash_currency
          : undefined;
    const estimateCurrency =
      row.in_kind_estimate_currency === null
        ? null
        : typeof row.in_kind_estimate_currency === "string" &&
            isIsoCurrency(row.in_kind_estimate_currency)
          ? row.in_kind_estimate_currency
          : undefined;
    if (cashCurrency === undefined || estimateCurrency === undefined) return ERROR;
    const family = compensationFamily(structure);
    compensationByCollaboration.set(row.collaboration_id, {
      family,
      familyLabel: compensationFamilyLabel(family),
      structure,
      structureLabel: compensationStructureLabel(structure),
      summary: compensationSummary({
        structure,
        cashAmountMinor,
        cashCurrency,
        inKindDescription: description,
        inKindEstimateMinor: estimateMinor,
        inKindEstimateCurrency: estimateCurrency,
      }),
      paymentLabel: paymentStatusLabel(paymentStatus),
      cashAmount: minorToMajorInput(cashAmountMinor, cashCurrency),
      cashCurrency: cashCurrency ?? "",
      inKindDescription: description ?? "",
      inKindEstimate: minorToMajorInput(estimateMinor, estimateCurrency),
      inKindEstimateCurrency: estimateCurrency ?? "",
      paymentStatus,
    });
  }

  const cards: BoardCard[] = [];
  for (const raw of input.collaborations) {
    const row = asRecord(raw);
    if (!row || typeof row.id !== "string" || !isUuid(row.id)) return ERROR;
    if (row.creator_id !== input.viewerId) return ERROR;
    const hotel = asRecord(row.hotel);
    if (!hotel || typeof hotel.id !== "string" || !isUuid(hotel.id)) return ERROR;
    if (row.hotel_id !== hotel.id) return ERROR;
    const hotelName = typeof hotel.name === "string" && hotel.name.trim() ? hotel.name.trim() : "";
    if (!hotelName) return ERROR;
    const pipelineItemId =
      row.pipeline_item_id === null
        ? null
        : typeof row.pipeline_item_id === "string" && isUuid(row.pipeline_item_id)
          ? row.pipeline_item_id
          : undefined;
    if (pipelineItemId === undefined) return ERROR;
    const start = calendarDay(row.start_date);
    const end = calendarDay(row.end_date);
    if (start === undefined || end === undefined) return ERROR;
    const type =
      row.collaboration_type === null
        ? null
        : typeof row.collaboration_type === "string" &&
            COLLABORATION_TYPES.has(row.collaboration_type)
          ? collaborationTypeLabel(row.collaboration_type)
          : undefined;
    if (type === undefined) return ERROR;
    const deliverables = deliverablesByCollaboration.get(row.id) ?? [];
    const due = nextDue(deliverables);
    const displayRef = pipelineItemId ? (displayByPipeline.get(pipelineItemId) ?? null) : null;
    cards.push({
      id: row.id,
      hotelId: hotel.id,
      hotelName,
      pipelineItemId,
      displayRef,
      displayMissing: pipelineItemId !== null && displayRef === null,
      statusLabel: collaborationStatusLabel(typeof row.status === "string" ? row.status : null),
      typeLabel: type,
      when: start && end ? `${start} – ${end}` : null,
      deliverables,
      approved: countApproved(deliverables),
      revisionRequested: deliverables.filter((item) => item.status === "revision_requested").length,
      nextDue: due.nextDue,
      datesUnreadable: due.datesUnreadable,
      compensation: compensationByCollaboration.get(row.id) ?? null,
    });
  }

  if (input.total > 0 && cards.length === 0) return ERROR;
  if (cards.length === 0 && input.total === 0) return EMPTY;
  const shown = cards.length;
  const summary =
    input.total > shown
      ? `Showing ${shown} of ${input.total} collaborations.`
      : `${input.total} ${input.total === 1 ? "collaboration" : "collaborations"}.`;
  const deliverableOverflow = input.deliverables.length >= BOARD_READ_LIMIT;
  const compensationOverflow = input.compensations.length >= BOARD_READ_LIMIT;
  return {
    kind: "items",
    cards,
    summary,
    capped: input.total > shown || deliverableOverflow || compensationOverflow,
  };
}
