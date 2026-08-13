/**
 * Pure parsing/validation of the workflow form (Sprint 2C).
 *
 * Framework-free so it is unit-testable, and deliberately NOT the security
 * boundary: the database re-validates every field, re-derives identity, and
 * re-checks the transition. This exists so an obvious mistake becomes a
 * friendly message instead of a round trip, and so nothing beyond the declared
 * fields is ever forwarded.
 *
 * Note what is absent: user id, creator id, plan, entitlement, limit. Those are
 * not optional inputs — they are not inputs at all.
 */
import { isUuid } from "@/lib/hotels/ids";

import {
  CLOSE_REASONS,
  OFFER_TYPES,
  OUTREACH_CHANNELS,
  REPLY_SENTIMENTS,
  WORKFLOW_ACTIONS,
  type WorkflowAction,
} from "./types";

/** The exact fields the browser may supply. */
export interface WorkflowFormFields {
  pipelineItemId?: string | null;
  action?: string | null;
  date?: string | null;
  channel?: string | null;
  sentiment?: string | null;
  offerType?: string | null;
  closeReason?: string | null;
}

export interface ParsedTransition {
  pipelineItemId: string;
  action: WorkflowAction;
  eventAt: string | null;
  channel: string | null;
  sentiment: string | null;
  offerType: string | null;
  closeReason: string | null;
}

export type ParseResult =
  { ok: true; value: ParsedTransition } | { ok: false; reason: "invalid_input" };

const INVALID = { ok: false, reason: "invalid_input" } as const;

/** Empty strings are "not supplied", which is what a blank <select> posts. */
function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * `<input type="date">` posts YYYY-MM-DD. Interpreting it at UTC midnight keeps
 * the recorded day stable regardless of where the server runs, and keeps
 * "today" safely in the past for the future-date check.
 */
export function parseEventDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  // Round-trip guard: rejects impossible days like 2026-02-31.
  return date.toISOString().slice(0, 10) === value ? date.toISOString() : null;
}

function inList(value: string | null, list: readonly string[]): boolean {
  return value !== null && list.includes(value);
}

export function parseWorkflowForm(fields: WorkflowFormFields): ParseResult {
  const pipelineItemId = clean(fields.pipelineItemId);
  const action = clean(fields.action);

  if (!pipelineItemId || !isUuid(pipelineItemId)) return INVALID;
  if (!inList(action, WORKFLOW_ACTIONS)) return INVALID;

  const channel = clean(fields.channel);
  const sentiment = clean(fields.sentiment);
  // The Reply form offers "None" for offer type; that is an absence, not a value.
  const rawOffer = clean(fields.offerType);
  const offerType = rawOffer === "none" ? null : rawOffer;
  const closeReason = clean(fields.closeReason);
  const eventAt = parseEventDate(clean(fields.date));

  if (channel !== null && !inList(channel, OUTREACH_CHANNELS)) return INVALID;
  if (offerType !== null && !inList(offerType, OFFER_TYPES)) return INVALID;

  const value: ParsedTransition = {
    pipelineItemId,
    action: action as WorkflowAction,
    eventAt,
    channel,
    sentiment,
    offerType,
    closeReason,
  };

  switch (value.action) {
    case "plan":
      // One action, no questionnaire.
      return { ok: true, value: { ...value, eventAt: null, channel: null } };
    case "mark_pitched":
      if (!eventAt || channel === null) return INVALID;
      return { ok: true, value };
    case "mark_followup_sent":
      if (!eventAt) return INVALID;
      return { ok: true, value };
    case "mark_replied":
      if (!eventAt || !inList(sentiment, REPLY_SENTIMENTS)) return INVALID;
      return { ok: true, value };
    case "close":
      if (!inList(closeReason, CLOSE_REASONS)) return INVALID;
      return { ok: true, value: { ...value, eventAt: null } };
  }
}
