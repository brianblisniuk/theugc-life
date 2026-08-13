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
  /**
   * The instant the creator's chosen calendar day begins in THEIR timezone,
   * converted in the browser (see `localDateToIso`). The raw YYYY-MM-DD is
   * never resolved here: the server has no idea which day "today" is for this
   * creator, and guessing with the server's own timezone is how you tell
   * someone in Auckland that the pitch they sent this morning is in the future.
   */
  eventAt?: string | null;
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
 * Convert the YYYY-MM-DD from `<input type="date">` into the instant that day
 * begins in the RUNNING ENVIRONMENT's timezone. Call this in the browser, where
 * that environment is the creator's own device and the platform already knows
 * their zone and its DST rules for the selected date.
 *
 * Local midnight — not UTC midnight. For a creator at UTC+14 just after
 * midnight, their local "today" is still the previous UTC calendar day, so
 * UTC midnight of that date would be hours in the FUTURE and the database
 * would correctly refuse to record outreach they really did send today.
 *
 * On a spring-forward date where 00:00 does not exist locally, the platform
 * moves to the first instant that does; the calendar day is unchanged.
 */
export function localDateToIso(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];

  const local = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (Number.isNaN(local.getTime())) return null;
  // Round-trip guard: impossible days like 2026-02-31 roll over into March.
  if (local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== day) {
    return null;
  }
  return local.toISOString();
}

/**
 * Validate an instant supplied by the browser. It is untrusted input like any
 * other — the database remains the authority on whether the instant is in the
 * future or predates the pitch it belongs to.
 */
export function parseEventInstant(value: string | null): string | null {
  if (!value) return null;
  // Require a full timestamp: a bare YYYY-MM-DD would be read as UTC midnight,
  // which is exactly the ambiguity this field exists to avoid.
  const head = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value);
  if (!head) return null;

  // Reject impossible civil dates rather than letting Date roll 02-31 into
  // March. The offset suffix does not matter here — the calendar part is a
  // plain civil date either way.
  const [, y, m, d] = head as unknown as [string, string, string, string];
  const civil = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (
    civil.getUTCFullYear() !== Number(y) ||
    civil.getUTCMonth() !== Number(m) - 1 ||
    civil.getUTCDate() !== Number(d)
  ) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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
  const eventAt = parseEventInstant(clean(fields.eventAt));

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
