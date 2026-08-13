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
  pipelineStatusLabel,
  saveResultMessage,
  type PipelineStatus,
  type SaveResult,
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
