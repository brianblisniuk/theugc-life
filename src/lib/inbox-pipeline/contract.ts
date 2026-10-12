/**
 * D06 / D080 — inbox and pipeline share one creator-owned status.
 *
 * pipeline_status is the record. A Gmail commercial_state is a reading.
 * The two are never the same field.
 */
import { PIPELINE_STATUSES, type PipelineStatus } from "@/lib/pipeline/types";

export const INBOX_SUGGESTION_KINDS = [
  "mark_replied",
  "open_negotiation",
  "review_agreement",
  "review_decline",
] as const;
export type InboxSuggestionKind = (typeof INBOX_SUGGESTION_KINDS)[number];

export const MACHINE_THREAD_STATES = [
  "unresolved",
  "engaged",
  "negotiating",
  "agreement_observed",
  "declined_observed",
  "ambiguous",
] as const;
export type MachineThreadState = (typeof MACHINE_THREAD_STATES)[number];

export const UNITY_STATES = ["unlinked", "suggestion_pending", "creator_authoritative"] as const;
export type UnityState = (typeof UNITY_STATES)[number];

export const REPLY_SENTIMENTS = ["positive", "negative", "unclear"] as const;
export type ReplySentiment = (typeof REPLY_SENTIMENTS)[number];

export interface InboxBinding {
  mailAccountId: string;
  providerThreadId: string;
  emailAddress: string | null;
}

export interface InboxReading {
  commercialState: MachineThreadState | null;
  stale: boolean;
  hasRedirect: boolean;
  hasRejection: boolean;
  hasHumanReply: boolean;
  declineSupported: boolean;
}

export interface InboxSuggestion {
  id: string;
  kind: InboxSuggestionKind;
  appliesCrm: boolean;
  basis: string;
}

export interface InboxUnity {
  pipelineStatus: PipelineStatus;
  unity: UnityState;
  binding: InboxBinding | null;
  reading: InboxReading | null;
  suggestions: InboxSuggestion[];
}

export type InboxLoad =
  | { status: "ok"; unity: InboxUnity }
  | { status: "not_found" }
  | { status: "error" };

export interface ConnectedMailbox {
  id: string;
  emailAddress: string | null;
}

export type MailboxLoad = { status: "ok"; mailboxes: ConnectedMailbox[] } | { status: "error" };

export type InboxWriteResult =
  | { result: "refreshed" }
  | { result: "no_reading" }
  | { result: "stale" }
  | { result: "already_bound" }
  | { result: "item_already_bound" }
  | { result: "thread_already_bound" }
  | { result: "thread_not_stored" }
  | { result: "mailbox_not_connected" }
  | { result: "unbound" }
  | { result: "not_bound" }
  | { result: "dismissed" }
  | { result: "acknowledged" }
  | { result: "applied" }
  | { result: "already_applied" }
  | { result: "invalid_transition" }
  | { result: "invalid_input" }
  | { result: "needs_event_time" }
  | { result: "stale_reading" }
  | { result: "reading_moved" }
  | { result: "not_pending" }
  | { result: "not_found" }
  | { result: "error" };

const WRITE_RESULTS = new Set<string>([
  "refreshed",
  "no_reading",
  "stale",
  "no_binding",
  "already_bound",
  "item_already_bound",
  "thread_already_bound",
  "thread_not_stored",
  "mailbox_not_connected",
  "mailbox_unavailable",
  "unbound",
  "not_bound",
  "dismissed",
  "acknowledged",
  "applied",
  "already_applied",
  "invalid_transition",
  "invalid_input",
  "needs_event_time",
  "stale_reading",
  "reading_moved",
  "not_pending",
  "not_found",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPipelineStatus(value: unknown): value is PipelineStatus {
  return typeof value === "string" && (PIPELINE_STATUSES as readonly string[]).includes(value);
}

function isMachineState(value: unknown): value is MachineThreadState | null {
  if (value === null) return true;
  return typeof value === "string" && (MACHINE_THREAD_STATES as readonly string[]).includes(value);
}

function isKind(value: unknown): value is InboxSuggestionKind {
  return typeof value === "string" && (INBOX_SUGGESTION_KINDS as readonly string[]).includes(value);
}

/**
 * A machine label in the pipeline status field is a contract break.
 * agreement_observed, declined_observed, and the rest of the B07 vocabulary
 * are not pipeline statuses, so they fail this parse.
 */
export function parseInboxUnity(payload: unknown): InboxUnity | null {
  if (!isRecord(payload) || payload.result !== "ok") return null;
  if (!isPipelineStatus(payload.pipeline_status)) return null;
  if (
    payload.unity !== "unlinked" &&
    payload.unity !== "suggestion_pending" &&
    payload.unity !== "creator_authoritative"
  ) {
    return null;
  }

  let binding: InboxBinding | null = null;
  if (payload.binding !== null) {
    if (!isRecord(payload.binding)) return null;
    if (typeof payload.binding.mail_account_id !== "string") return null;
    if (typeof payload.binding.provider_thread_id !== "string") return null;
    if (payload.binding.email_address !== null && typeof payload.binding.email_address !== "string") {
      return null;
    }
    binding = {
      mailAccountId: payload.binding.mail_account_id,
      providerThreadId: payload.binding.provider_thread_id,
      emailAddress: payload.binding.email_address,
    };
  }

  let reading: InboxReading | null = null;
  if (payload.reading !== null) {
    if (!isRecord(payload.reading)) return null;
    if (!isMachineState(payload.reading.commercial_state)) return null;
    if (typeof payload.reading.stale !== "boolean") return null;
    if (typeof payload.reading.has_redirect !== "boolean") return null;
    if (typeof payload.reading.has_rejection !== "boolean") return null;
    if (typeof payload.reading.has_human_reply !== "boolean") return null;
    if (typeof payload.reading.decline_supported !== "boolean") return null;
    if (payload.reading.decline_supported && payload.reading.has_redirect) return null;
    reading = {
      commercialState: payload.reading.commercial_state,
      stale: payload.reading.stale,
      hasRedirect: payload.reading.has_redirect,
      hasRejection: payload.reading.has_rejection,
      hasHumanReply: payload.reading.has_human_reply,
      declineSupported: payload.reading.decline_supported,
    };
  }

  if (!Array.isArray(payload.suggestions)) return null;
  const suggestions: InboxSuggestion[] = [];
  for (const row of payload.suggestions) {
    if (!isRecord(row) || typeof row.id !== "string" || !isKind(row.kind)) return null;
    if (typeof row.applies_crm !== "boolean" || typeof row.basis !== "string") return null;
    if (row.kind === "review_decline" && row.basis !== "rejection") return null;
    if (row.kind === "review_decline" && row.applies_crm) return null;
    if (row.kind === "review_agreement" && row.applies_crm) return null;
    if ((row.kind === "mark_replied" || row.kind === "open_negotiation") && !row.applies_crm) {
      return null;
    }
    suggestions.push({ id: row.id, kind: row.kind, appliesCrm: row.applies_crm, basis: row.basis });
  }

  if (payload.unity === "unlinked" && (binding !== null || suggestions.length > 0)) return null;
  if (payload.unity === "suggestion_pending" && suggestions.length === 0) return null;
  if (payload.unity === "creator_authoritative" && suggestions.length > 0) return null;
  if (reading?.declineSupported && suggestions.some((row) => row.kind === "review_decline" && row.basis !== "rejection")) {
    return null;
  }

  return {
    pipelineStatus: payload.pipeline_status,
    unity: payload.unity,
    binding,
    reading,
    suggestions,
  };
}

export function mapInboxWrite(payload: unknown): InboxWriteResult {
  if (!isRecord(payload) || typeof payload.result !== "string") return { result: "error" };
  if (payload.result === "no_binding") return { result: "not_bound" };
  if (payload.result === "mailbox_unavailable") return { result: "mailbox_not_connected" };
  if (!WRITE_RESULTS.has(payload.result)) return { result: "error" };
  return { result: payload.result as InboxWriteResult["result"] };
}
