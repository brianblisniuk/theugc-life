/**
 * Pipeline domain types + pure display helpers (PRD §7.4, DECISIONS D023/D042).
 *
 * Framework-free so status labelling and result mapping are unit-testable
 * without a database or a React renderer.
 */

/** `pipeline_items.status` vocabulary (migration 0005 CHECK constraint). */
export const PIPELINE_STATUSES = [
  "saved",
  "planned",
  "pitched",
  "replied",
  "follow_up",
  "negotiating",
  "won",
  "closed",
] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

/**
 * Statuses that count as an ENGAGED CRM relationship (D042). `saved` is a
 * passive relationship and is deliberately excluded — the engaged allowance is
 * consumed only when an item leaves `saved`.
 */
export const ENGAGED_STATUSES = [
  "planned",
  "pitched",
  "replied",
  "follow_up",
  "negotiating",
  "won",
] as const;

/** Human-readable labels (DESIGN_SYSTEM.md §5). */
const STATUS_LABEL: Record<string, string> = {
  saved: "Saved",
  planned: "Planned",
  pitched: "Pitched",
  replied: "Replied",
  follow_up: "Follow-up",
  negotiating: "Negotiating",
  won: "Won",
  closed: "Closed",
};

export function pipelineStatusLabel(status: string | null): string {
  if (!status) return "Saved";
  return STATUS_LABEL[status] ?? status.replace(/_/g, " ");
}

/** A cycle is open (D023) in every status except `closed`. */
export function isOpenCycle(status: string | null): boolean {
  return status !== null && status !== "closed";
}

/** Sanitized outcomes of a save attempt — never a raw Postgres error. */
export type SaveResult =
  | { result: "created"; pipelineItemId: string; status: PipelineStatus }
  | { result: "already_saved"; pipelineItemId: string; status: PipelineStatus }
  | { result: "limit_reached"; limit: number; openCount: number }
  | { result: "hotel_not_found" }
  | { result: "creator_profile_missing" }
  | { result: "error" };

/** True when the attempt left the hotel in the creator's pipeline. */
export function isSaveSuccessful(result: SaveResult): boolean {
  return result.result === "created" || result.result === "already_saved";
}

/**
 * Map the RPC's JSON payload to a typed, sanitized result. Anything
 * unrecognized becomes `error` — the browser never receives SQL detail.
 */
export function mapSaveResult(payload: unknown): SaveResult {
  if (!payload || typeof payload !== "object") return { result: "error" };
  const row = payload as Record<string, unknown>;
  const id = typeof row.pipeline_item_id === "string" ? row.pipeline_item_id : null;
  const status = typeof row.status === "string" ? (row.status as PipelineStatus) : "saved";

  switch (row.result) {
    case "created":
      return id ? { result: "created", pipelineItemId: id, status } : { result: "error" };
    case "already_saved":
      return id ? { result: "already_saved", pipelineItemId: id, status } : { result: "error" };
    case "limit_reached":
      return {
        result: "limit_reached",
        limit: Number(row.limit ?? 0),
        openCount: Number(row.open_count ?? 0),
      };
    case "hotel_not_found":
      return { result: "hotel_not_found" };
    case "creator_profile_missing":
      return { result: "creator_profile_missing" };
    default:
      return { result: "error" };
  }
}

/** User-facing message for a save outcome. Never leaks internal detail. */
export function saveResultMessage(result: SaveResult): string {
  switch (result.result) {
    case "created":
      return "Saved to your pipeline.";
    case "already_saved":
      return "This hotel is already in your pipeline.";
    case "limit_reached":
      return "You’ve reached the Free saved-hotel limit.";
    case "hotel_not_found":
      return "That hotel is no longer available.";
    case "creator_profile_missing":
      return "We couldn’t find your creator profile. Please reload and try again.";
    default:
      return "We couldn’t save this hotel just now. Please try again.";
  }
}

/* ==================================================================== */
/* Workflow transitions (Sprint 2C — EVENTS.md §3/§4, D042/D043)        */
/* ==================================================================== */

/**
 * Workflow actions implemented in this slice. `negotiation_started` and
 * `deal_won` belong to the next slice and are deliberately absent — an action
 * the server rejects must never be offered by the UI.
 */
export const WORKFLOW_ACTIONS = [
  "plan",
  "mark_pitched",
  "mark_followup_sent",
  "mark_replied",
  "close",
] as const;
export type WorkflowAction = (typeof WORKFLOW_ACTIONS)[number];

/** `outreach_events.channel` vocabulary (migration 0006 CHECK constraint). */
export const OUTREACH_CHANNELS = [
  "email",
  "instagram",
  "linkedin",
  "website_form",
  "whatsapp",
  "in_person",
  "other",
] as const;
export type OutreachChannel = (typeof OUTREACH_CHANNELS)[number];

export const REPLY_SENTIMENTS = ["positive", "negative", "unclear"] as const;
export type ReplySentiment = (typeof REPLY_SENTIMENTS)[number];

export const OFFER_TYPES = ["stay", "product", "paid", "stay_plus_paid", "other"] as const;
export type OfferType = (typeof OFFER_TYPES)[number];

export const CLOSE_REASONS = ["no_reply", "rejected", "not_a_fit", "timing", "other"] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

const ACTION_LABEL: Record<WorkflowAction, string> = {
  plan: "Plan outreach",
  mark_pitched: "Mark as pitched",
  mark_followup_sent: "Mark follow-up sent",
  mark_replied: "Mark replied",
  close: "Close",
};

const CHANNEL_LABEL: Record<string, string> = {
  email: "Email",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  website_form: "Website form",
  whatsapp: "WhatsApp",
  in_person: "In person",
  other: "Other",
};

const SENTIMENT_LABEL: Record<string, string> = {
  positive: "Positive",
  negative: "Negative",
  unclear: "Unclear",
};

const OFFER_LABEL: Record<string, string> = {
  stay: "Stay",
  product: "Product",
  paid: "Paid",
  stay_plus_paid: "Stay + paid",
  other: "Other",
};

const CLOSE_REASON_LABEL: Record<string, string> = {
  no_reply: "No reply",
  rejected: "Rejected",
  not_a_fit: "Not a fit",
  timing: "Timing",
  other: "Other",
};

export function workflowActionLabel(action: WorkflowAction): string {
  return ACTION_LABEL[action];
}
export function channelLabel(value: string): string {
  return CHANNEL_LABEL[value] ?? value.replace(/_/g, " ");
}
export function sentimentLabel(value: string): string {
  return SENTIMENT_LABEL[value] ?? value;
}
export function offerTypeLabel(value: string): string {
  return OFFER_LABEL[value] ?? value.replace(/_/g, " ");
}
export function closeReasonLabel(value: string): string {
  return CLOSE_REASON_LABEL[value] ?? value.replace(/_/g, " ");
}

/** Sanitized outcomes of a transition attempt — never a raw Postgres error. */
export type TransitionResult =
  | { result: "applied"; status: PipelineStatus }
  | { result: "already_applied"; status: PipelineStatus }
  | { result: "engaged_limit_reached"; limit: number; engagedCount: number }
  | { result: "invalid_transition" }
  | { result: "invalid_input" }
  | { result: "invalid_event_time" }
  | { result: "pipeline_item_not_found" }
  | { result: "creator_profile_missing" }
  | { result: "error" };

/** True when the relationship ended up where the creator asked it to be. */
export function isTransitionSuccessful(result: TransitionResult): boolean {
  return result.result === "applied" || result.result === "already_applied";
}

/**
 * Map the RPC's JSON payload to a typed, sanitized result. Anything
 * unrecognized becomes `error` — the browser never receives SQL detail.
 */
export function mapTransitionResult(payload: unknown): TransitionResult {
  if (!payload || typeof payload !== "object") return { result: "error" };
  const row = payload as Record<string, unknown>;
  const status = typeof row.status === "string" ? (row.status as PipelineStatus) : null;

  switch (row.result) {
    case "applied":
      return status ? { result: "applied", status } : { result: "error" };
    case "already_applied":
      return status ? { result: "already_applied", status } : { result: "error" };
    case "engaged_limit_reached":
      return {
        result: "engaged_limit_reached",
        limit: Number(row.limit ?? 0),
        engagedCount: Number(row.engaged_count ?? 0),
      };
    case "invalid_transition":
      return { result: "invalid_transition" };
    case "invalid_input":
      return { result: "invalid_input" };
    case "invalid_event_time":
      return { result: "invalid_event_time" };
    case "pipeline_item_not_found":
      return { result: "pipeline_item_not_found" };
    case "creator_profile_missing":
      return { result: "creator_profile_missing" };
    default:
      return { result: "error" };
  }
}

/** User-facing message for a transition outcome. Never leaks internal detail. */
export function transitionResultMessage(result: TransitionResult): string {
  switch (result.result) {
    case "applied":
      return `Updated to ${pipelineStatusLabel(result.status)}.`;
    case "already_applied":
      return `Already ${pipelineStatusLabel(result.status)} — nothing was recorded twice.`;
    case "engaged_limit_reached":
      return "You’ve reached the Free active-pipeline limit.";
    case "invalid_transition":
      return "That step isn’t available from this stage. Reload the page to see the current status.";
    case "invalid_input":
      return "Please check the details and try again.";
    case "invalid_event_time":
      return "That date doesn’t fit this outreach — it can’t be in the future or before your pitch.";
    case "pipeline_item_not_found":
      return "We couldn’t find this relationship. Reload the page to try again.";
    case "creator_profile_missing":
      return "We couldn’t find your creator profile. Please reload and try again.";
    default:
      return "We couldn’t record that just now. Please try again.";
  }
}

/* ==================================================================== */
/* Deal progress (Sprint 2D — EVENTS.md §3, DATABASE.md §8)             */
/* ==================================================================== */

/**
 * Deal actions live behind their own RPC because they carry different inputs
 * and, for `mark_won`, write a collaboration alongside the event.
 */
export const DEAL_ACTIONS = ["start_negotiation", "mark_won"] as const;
export type DealAction = (typeof DEAL_ACTIONS)[number];

/** Everything the workflow UI may offer, whichever RPC ultimately serves it. */
export type PipelineAction = WorkflowAction | DealAction;

export function isDealAction(action: string): action is DealAction {
  return (DEAL_ACTIONS as readonly string[]).includes(action);
}

/** `collaborations.collaboration_type` vocabulary (migration 0006). */
export const COLLABORATION_TYPES = ["stay", "product", "paid", "stay_plus_paid", "other"] as const;
export type CollaborationType = (typeof COLLABORATION_TYPES)[number];

const DEAL_ACTION_LABEL: Record<DealAction, string> = {
  start_negotiation: "Start negotiation",
  mark_won: "Mark as won",
};

const COLLABORATION_TYPE_LABEL: Record<string, string> = {
  stay: "Stay",
  product: "Product",
  paid: "Paid",
  stay_plus_paid: "Stay + paid",
  other: "Other",
};

export function pipelineActionLabel(action: PipelineAction): string {
  return isDealAction(action) ? DEAL_ACTION_LABEL[action] : workflowActionLabel(action);
}

export function collaborationTypeLabel(value: string): string {
  return COLLABORATION_TYPE_LABEL[value] ?? value.replace(/_/g, " ");
}

/** Sanitized outcomes of a deal-progress attempt. */
export type DealResult =
  | { result: "applied"; status: PipelineStatus; collaborationId: string | null }
  | { result: "already_applied"; status: PipelineStatus; collaborationId: string | null }
  | { result: "invalid_transition" }
  | { result: "invalid_input" }
  | { result: "invalid_event_time" }
  | { result: "pipeline_item_not_found" }
  | { result: "creator_profile_missing" }
  /** The stored state is self-contradictory; we refuse to guess which half is right. */
  | { result: "integrity_error" }
  | { result: "error" };

export function isDealSuccessful(result: DealResult): boolean {
  return result.result === "applied" || result.result === "already_applied";
}

/** Map the RPC's JSON payload to a typed, sanitized result. */
export function mapDealResult(payload: unknown): DealResult {
  if (!payload || typeof payload !== "object") return { result: "error" };
  const row = payload as Record<string, unknown>;
  const status = typeof row.status === "string" ? (row.status as PipelineStatus) : null;
  const collaborationId = typeof row.collaboration_id === "string" ? row.collaboration_id : null;

  switch (row.result) {
    case "applied":
      return status ? { result: "applied", status, collaborationId } : { result: "error" };
    case "already_applied":
      return status ? { result: "already_applied", status, collaborationId } : { result: "error" };
    case "invalid_transition":
      return { result: "invalid_transition" };
    case "invalid_input":
      return { result: "invalid_input" };
    case "invalid_event_time":
      return { result: "invalid_event_time" };
    case "pipeline_item_not_found":
      return { result: "pipeline_item_not_found" };
    case "creator_profile_missing":
      return { result: "creator_profile_missing" };
    case "integrity_error":
      return { result: "integrity_error" };
    default:
      return { result: "error" };
  }
}

/** User-facing message for a deal outcome. Never leaks internal detail. */
export function dealResultMessage(result: DealResult): string {
  switch (result.result) {
    case "applied":
      return result.status === "won"
        ? "Collaboration agreed."
        : `Updated to ${pipelineStatusLabel(result.status)}.`;
    case "already_applied":
      return result.status === "won"
        ? "This collaboration is already recorded."
        : `Already ${pipelineStatusLabel(result.status)} — nothing was recorded twice.`;
    case "invalid_transition":
      return "That step isn’t available from this stage. Reload the page to see the current status.";
    case "invalid_input":
      return "Please check the details and try again.";
    case "invalid_event_time":
      return "That agreed date can’t be in the future.";
    case "pipeline_item_not_found":
      return "We couldn’t find this relationship. Reload the page to try again.";
    case "creator_profile_missing":
      return "We couldn’t find your creator profile. Please reload and try again.";
    case "integrity_error":
      return "This deal’s records don’t line up, so we didn’t change anything. Please contact support.";
    default:
      return "We couldn’t record that just now. Please try again.";
  }
}
