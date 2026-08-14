/**
 * Pure view-state for the pipeline surfaces (PRD §7.3/§7.4).
 *
 * The Hotel Detail activity panel, the Save control and the Pipeline list all
 * decide *what to show* here rather than inline in JSX, so the product rules
 * (a technical failure is never a domain fact; the limit copy is truthful; an
 * empty filter is not an empty pipeline) are unit-testable without a renderer.
 */
import {
  PIPELINE_STATUSES,
  isSaveSuccessful,
  collaborationResultMessage,
  collaborationStatusLabel,
  collaborationTypeLabel,
  dealResultMessage,
  isDealSuccessful,
  pipelineStatusLabel,
  saveResultMessage,
  transitionResultMessage,
  type PipelineStatus,
  type CollaborationAction,
  type CollaborationResult,
  type CollaborationStatus,
  type DealResult,
  type PipelineAction,
  type SaveResult,
  type TransitionResult,
} from "./types";

/** Copy owned by the product, asserted by tests so it cannot drift silently. */
export const PIPELINE_COPY = {
  emptyTitle: "Your pipeline is empty",
  emptyBody: "Save a hotel from Discover to start tracking your outreach.",
  emptyCta: "Discover hotels",
  errorTitle: "We couldn’t load your pipeline",
  filteredTitle: "No hotels with this status",
  limitTitle: "You’ve reached the Free saved-hotel limit.",
  activityErrorTitle: "We couldn’t load your activity",
  activityErrorBody:
    "We couldn’t check whether this hotel is already in your pipeline. Reload the page to try again.",
  unsavedTitle: "Not saved yet",
} as const;

/** Truthful Free-limit explanation. The number comes from the server result. */
export function freeLimitExplanation(limit: number): string {
  return `You can keep up to ${limit} open hotel relationships on Free.`;
}

/* ------------------------------------------------------------------ */
/* Hotel Detail — "Your Activity"                                      */
/* ------------------------------------------------------------------ */

export type ActivityPanelState =
  | { kind: "open_cycle"; status: PipelineStatus; statusLabel: string }
  | { kind: "unsaved"; title: string }
  | { kind: "load_error"; title: string; body: string };

/** What the relationship lookup actually established — the three are distinct. */
export type RelationshipLoad =
  { status: "open"; relationship: { status: string } } | { status: "none" } | { status: "error" };

/**
 * An open (non-closed) cycle means the hotel is already tracked, so Save is
 * never offered a second time (D023). A closed cycle is history: the creator
 * may start a fresh one.
 *
 * A FAILED lookup is neither: we did not learn that the hotel is unsaved, so we
 * must not say "Not saved yet" or offer Save. Fail safe, not fail cheerful.
 */
export function activityPanelState(load: RelationshipLoad): ActivityPanelState {
  if (load.status === "error") {
    return {
      kind: "load_error",
      title: PIPELINE_COPY.activityErrorTitle,
      body: PIPELINE_COPY.activityErrorBody,
    };
  }
  if (load.status === "none" || load.relationship.status === "closed") {
    return { kind: "unsaved", title: PIPELINE_COPY.unsavedTitle };
  }
  return {
    kind: "open_cycle",
    status: load.relationship.status as PipelineStatus,
    statusLabel: pipelineStatusLabel(load.relationship.status),
  };
}

/** Save is offered only when we KNOW there is no open relationship. */
export function shouldOfferSave(state: ActivityPanelState): boolean {
  return state.kind === "unsaved";
}

/* ------------------------------------------------------------------ */
/* Save control                                                        */
/* ------------------------------------------------------------------ */

export type SaveControlState =
  | { kind: "prompt" }
  | { kind: "saved"; message: string }
  | { kind: "limit"; message: string; explanation: string; limit: number }
  | { kind: "problem"; message: string };

/**
 * `already_saved` is a success: a retry or a double click must never look like
 * a failure. `limit_reached` is the only state allowed to offer an upgrade —
 * a technical `error` must not be dressed up as a commercial wall.
 */
export function saveControlState(result: SaveResult | null | undefined): SaveControlState {
  if (!result) return { kind: "prompt" };
  if (isSaveSuccessful(result)) return { kind: "saved", message: saveResultMessage(result) };
  if (result.result === "limit_reached") {
    return {
      kind: "limit",
      message: saveResultMessage(result),
      explanation: freeLimitExplanation(result.limit),
      limit: result.limit,
    };
  }
  return { kind: "problem", message: saveResultMessage(result) };
}

/** Only a real commercial limit may advertise upgrading. */
export function shouldOfferUpgrade(state: SaveControlState): boolean {
  return state.kind === "limit";
}

/* ------------------------------------------------------------------ */
/* Pipeline list                                                       */
/* ------------------------------------------------------------------ */

/** Accept only known statuses from the URL; anything else means "all". */
export function normalizeStatusFilter(
  raw: string | string[] | undefined | null,
): PipelineStatus | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  return (PIPELINE_STATUSES as readonly string[]).includes(value)
    ? (value as PipelineStatus)
    : null;
}

export type PipelineListState =
  | { kind: "error"; title: string }
  | { kind: "items"; count: number; summary: string }
  | { kind: "empty_filtered"; title: string }
  | { kind: "empty"; title: string; body: string };

/**
 * A failed query renders a neutral error — never "your pipeline is empty",
 * which would be a lie the creator might act on.
 */
export function pipelineListState(input: {
  failed: boolean;
  items: readonly unknown[] | null;
  status: string | null;
}): PipelineListState {
  if (input.failed || input.items === null) {
    return { kind: "error", title: PIPELINE_COPY.errorTitle };
  }
  const count = input.items.length;
  if (count > 0) {
    const suffix = input.status ? ` with status ${pipelineStatusLabel(input.status)}` : "";
    return { kind: "items", count, summary: `${count} hotel${count === 1 ? "" : "s"}${suffix}` };
  }
  if (input.status) return { kind: "empty_filtered", title: PIPELINE_COPY.filteredTitle };
  return { kind: "empty", title: PIPELINE_COPY.emptyTitle, body: PIPELINE_COPY.emptyBody };
}

/* ------------------------------------------------------------------ */
/* Workflow actions (Sprint 2C)                                        */
/* ------------------------------------------------------------------ */

/**
 * Which workflow actions the creator may take from a given status.
 *
 * This mirrors the transition map the database enforces, so the UI never
 * offers a step the RPC would reject. Sprint 2D adds the deal path
 * (replied → negotiating → won); collaboration execution and closing a won
 * cycle remain absent, because offering a control that cannot succeed is
 * worse than offering none.
 */
const ACTIONS_BY_STATUS: Record<string, readonly PipelineAction[]> = {
  saved: ["plan", "mark_pitched", "close"],
  planned: ["mark_pitched", "close"],
  pitched: ["mark_followup_sent", "mark_replied", "close"],
  follow_up: ["mark_replied", "close"],
  replied: ["start_negotiation", "close"],
  negotiating: ["mark_won", "close"],
  // A won cycle is finished for this slice: closing it belongs to the
  // collaboration lifecycle, not to outreach.
  won: [],
  closed: [],
};

export function availableActions(status: string | null | undefined): readonly PipelineAction[] {
  if (!status) return [];
  return ACTIONS_BY_STATUS[status] ?? [];
}

/** Workflow controls exist only for a status we actually loaded. */
export function shouldOfferWorkflow(state: ActivityPanelState): boolean {
  return state.kind === "open_cycle" && availableActions(state.status).length > 0;
}

export const WORKFLOW_COPY = {
  engagedLimitTitle: "You’ve reached the Free active-pipeline limit.",
  engagedLimitNote: "Your saved hotels stay saved — only active outreach is limited.",
} as const;

/** Truthful engaged-limit explanation. The number comes from the server. */
export function engagedLimitExplanation(limit: number): string {
  return `You can actively work up to ${limit} hotel relationships on Free.`;
}

export type WorkflowControlState =
  | { kind: "idle" }
  | { kind: "applied"; message: string; status: PipelineStatus }
  | { kind: "limit"; message: string; explanation: string; note: string; limit: number }
  | { kind: "problem"; message: string };

/**
 * `already_applied` is a success: a double click or retry must not look like a
 * failure. `engaged_limit_reached` is the ONLY workflow outcome allowed to
 * offer an upgrade — a technical error or a rejected transition must never be
 * dressed up as a commercial wall.
 */
export function workflowControlState(
  result: TransitionResult | null | undefined,
): WorkflowControlState {
  if (!result) return { kind: "idle" };
  if (result.result === "applied" || result.result === "already_applied") {
    return {
      kind: "applied",
      message: transitionResultMessage(result),
      status: result.status,
    };
  }
  if (result.result === "engaged_limit_reached") {
    return {
      kind: "limit",
      message: transitionResultMessage(result),
      explanation: engagedLimitExplanation(result.limit),
      note: WORKFLOW_COPY.engagedLimitNote,
      limit: result.limit,
    };
  }
  return { kind: "problem", message: transitionResultMessage(result) };
}

/** Only a real commercial limit may advertise upgrading. */
export function shouldOfferWorkflowUpgrade(state: WorkflowControlState): boolean {
  return state.kind === "limit";
}

/* ------------------------------------------------------------------ */
/* Deal progress + collaboration (Sprint 2D)                           */
/* ------------------------------------------------------------------ */

export const COLLABORATION_COPY = {
  agreedTitle: "Collaboration agreed",
  errorTitle: "We couldn’t load your collaboration",
  errorBody:
    "This is a temporary problem on our side, not a missing collaboration. Reload the page to try again.",
  integrityTitle: "This deal needs a second look",
  integrityBody:
    "This relationship is marked won but we can’t find its collaboration record. Nothing was changed. Please contact support.",
} as const;

export type DealControlState =
  | { kind: "idle" }
  | { kind: "applied"; message: string; status: PipelineStatus }
  | { kind: "problem"; message: string };

/**
 * `already_applied` is a success — a double click on "Mark as won" must not
 * read as a failure. Nothing on the deal path offers an upgrade: none of these
 * outcomes is a commercial limit.
 */
export function dealControlState(result: DealResult | null | undefined): DealControlState {
  if (!result) return { kind: "idle" };
  if (result.result === "applied" || result.result === "already_applied") {
    return { kind: "applied", message: dealResultMessage(result), status: result.status };
  }
  return { kind: "problem", message: dealResultMessage(result) };
}

/** No deal outcome is ever a reason to sell an upgrade. */
export function shouldOfferDealUpgrade(_state: DealControlState): boolean {
  return false;
}

export { isDealSuccessful };

/** What the collaboration lookup established — the three are distinct. */
export type CollaborationLoadState =
  | {
      status: "found";
      collaboration: {
        status?: string | null;
        collaborationType: string | null;
        agreedAt: string | null;
        startDate?: string | null;
        endDate?: string | null;
      };
    }
  | { status: "none" }
  | { status: "error" };

export type CollaborationPanelState =
  | { kind: "hidden" }
  | {
      kind: "lifecycle";
      title: string;
      status: CollaborationStatus;
      typeLabel: string | null;
      agreedAt: string | null;
      startDate: string | null;
      endDate: string | null;
      actions: readonly CollaborationAction[];
    }
  | { kind: "load_error"; title: string; body: string }
  | { kind: "integrity_problem"; title: string; body: string };

/**
 * Which lifecycle steps are offered from each collaboration status (D045).
 * Terminal states offer none: the pipeline cycle is closed by then, and the
 * relationship is free to start again through Save.
 */
const LIFECYCLE_ACTIONS: Record<string, readonly CollaborationAction[]> = {
  agreed: ["schedule", "start", "cancel"],
  scheduled: ["start", "cancel"],
  active: ["complete", "cancel"],
  completed: [],
  cancelled: [],
};

export function collaborationLifecycleActions(
  status: string | null | undefined,
): readonly CollaborationAction[] {
  if (!status) return [];
  return LIFECYCLE_ACTIONS[status] ?? [];
}

/**
 * A `won` cycle must have a collaboration; that is the whole point of writing
 * them together. So the three lookup answers mean three different things:
 *
 *   found → show it
 *   error → a temporary glitch; say so, and do NOT claim there is none
 *   none  → a contradiction, not an empty state. Surface it rather than
 *           rendering a reassuring blank.
 */
export function collaborationPanelState(input: {
  status: string;
  load: CollaborationLoadState;
}): CollaborationPanelState {
  if (input.status !== "won") return { kind: "hidden" };

  if (input.load.status === "error") {
    return {
      kind: "load_error",
      title: COLLABORATION_COPY.errorTitle,
      body: COLLABORATION_COPY.errorBody,
    };
  }
  if (input.load.status === "none") {
    return {
      kind: "integrity_problem",
      title: COLLABORATION_COPY.integrityTitle,
      body: COLLABORATION_COPY.integrityBody,
    };
  }
  const collaboration = input.load.collaboration;
  const status = (collaboration.status ?? "agreed") as CollaborationStatus;

  return {
    kind: "lifecycle",
    title: collaborationStatusLabel(status),
    status,
    typeLabel: collaboration.collaborationType
      ? collaborationTypeLabel(collaboration.collaborationType)
      : null,
    agreedAt: collaboration.agreedAt,
    startDate: collaboration.startDate ?? null,
    endDate: collaboration.endDate ?? null,
    actions: collaborationLifecycleActions(status),
  };
}

/** Lifecycle controls exist only for a collaboration we actually loaded. */
export function shouldOfferLifecycle(state: CollaborationPanelState): boolean {
  return state.kind === "lifecycle" && state.actions.length > 0;
}

export type LifecycleControlState =
  { kind: "idle" } | { kind: "applied"; message: string } | { kind: "problem"; message: string };

/**
 * `already_applied` is a success: a double-clicked "Complete collaboration"
 * must not read as a failure. Nothing on this path is a commercial limit, so
 * no lifecycle outcome ever offers an upgrade.
 */
export function lifecycleControlState(
  result: CollaborationResult | null | undefined,
): LifecycleControlState {
  if (!result) return { kind: "idle" };
  if (result.result === "applied" || result.result === "already_applied") {
    return { kind: "applied", message: collaborationResultMessage(result) };
  }
  return { kind: "problem", message: collaborationResultMessage(result) };
}
