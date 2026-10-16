/**
 * Inbox screen decisions (V2-S4).
 *
 * A linked thread is a stored Gmail conversation the creator attached to one
 * opportunity. The commercial reading is a classification, not the message
 * and not the pipeline status. A stay-date row is a proposal until the
 * creator accepts or rejects it. This module does not send mail.
 */
import { isUuid } from "@/lib/hotels/ids";
import {
  INBOX_SUGGESTION_KINDS,
  MACHINE_THREAD_STATES,
  type InboxSuggestionKind,
  type MachineThreadState,
} from "@/lib/inbox-pipeline/contract";
import { pipelineStageLabel, pipelineStatusLabel } from "@/lib/pipeline/types";
import { hotelHref, pitchHref, withOpportunityQuery } from "@/lib/shell/navigation";
import { REVOKED_INBOX_COPY } from "@/lib/surfaces/list-outcome";
import {
  COLLABORATION_SUGGESTION_KINDS,
  type CollaborationSuggestionKind,
} from "@/lib/gmail/collaboration/contract";

export const INBOX_THREAD_CAP = 50;
export const INBOX_DATE_CAP = 50;
/** Pending suggestions for the threads on this page. One extra row means the list is truncated. */
export const INBOX_SUGGESTION_CAP = 200;

const DISPLAY_REF = /^OP-[1-9][0-9]{3,}$/;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

export const INBOX_SEND_GATE =
  "Sending stays off. gmail.send is not granted, so this screen cannot send a message. Prepare a reply in Pitch Studio. A draft is not a sent email.";

export const INBOX_COPY = {
  errorTitle: "We couldn’t load your inbox",
  errorBody: "Something went wrong on our side. Try again. This is not an empty inbox.",
  lede: "Classifications come from threads already stored for your mailbox. Message text stays in Gmail. Opening this page does not start a sync and does not send mail.",
  emptyConnected:
    "No conversation is linked yet. A sync does not start from this page, and an unlinked thread is not listed.",
  emptyDisconnected:
    "Gmail is not connected. Linked conversations that were already stored can still appear. Nothing here sends mail.",
  datesError: "Date suggestions are unavailable. This does not mean there are none.",
  suggestionsError: "We could not review inbox suggestions. This does not mean there are none.",
  reviewUnavailable:
    "We could not review what these conversations need. This does not mean nothing needs a reply.",
  suggestionsTruncated:
    "There are more inbox suggestions than this page lists. This is not a completed review.",
  suggestionsCappedHeading:
    "Inbox suggestions on this page are incomplete. This does not mean nothing needs a reply.",
  gmailError:
    "We could not review Gmail collaboration suggestions. This does not mean there are none.",
  gmailTruncated:
    "There are more Gmail suggestions than this page lists. It does not say how many.",
  emptyNeedsReply: "None of the linked conversations need a reply.",
  gmailPaused:
    "Gmail detection stays paused on Free. An active Pro plan or Destination Pass resumes it. Nothing here was recorded.",
  truncated: "The conversation list is capped. It is not the database total.",
  datesTruncated: "There are more date suggestions than this page lists.",
  noClassification: "Insufficient data for a classification.",
  stale: "The Gmail reading is stale. It is not a current classification.",
  redirect: "A redirect is not a rejection.",
  choose: "Choose a conversation to see its classification and any date suggestion.",
  datesTitle: "Dates named by Gmail",
  datesEmpty: "No date suggestion is waiting. A suggestion is not created from a guess.",
  bodyHidden: "The message body is not copied onto this screen.",
} as const;

const COMMERCIAL_LABEL: Record<MachineThreadState, string> = {
  unresolved: "No commercial decision is stored for this thread.",
  engaged: "A person replied on this thread.",
  negotiating: "The thread reading is negotiation.",
  agreement_observed: "The reading looks like an agreement. It is not a saved collaboration.",
  declined_observed: "The reading looks like a decline. It does not close the opportunity.",
  ambiguous: "The reading is ambiguous.",
};

const SUGGESTION_LABEL: Record<InboxSuggestionKind, string> = {
  mark_replied: "Record the human reply",
  open_negotiation: "Open negotiation",
  review_agreement: "Review the agreement reading",
  review_decline: "Review the decline reading",
};

export type InboxFilter = "needs_reply" | "all";
export type InboxAttention = "needs_reply" | "follow_up" | "waiting" | "other";

export type InboxMailbox =
  | { kind: "connected"; email: string | null }
  | { kind: "disconnected" }
  | { kind: "consent" }
  | { kind: "reauth" }
  | { kind: "unconfigured" }
  | { kind: "error" };

export interface InboxSuggestionRow {
  id: string;
  creatorId: string;
  pipelineItemId: string;
  kind: InboxSuggestionKind;
  appliesCrm: boolean;
}

export interface InboxThreadRow {
  bindingId: string;
  creatorId: string;
  pipelineItemId: string;
  hotelId: string;
  hotelName: string;
  displayRef: string | null;
  status: string;
  updatedAt: string;
  commercialState: MachineThreadState | null;
  readingPresent: boolean;
  stale: boolean;
  hasHumanReply: boolean;
  hasRedirect: boolean;
  tripId: string | null;
}

export interface InboxDateRow {
  id: string;
  creatorId: string;
  pipelineItemId: string | null;
  tripHotelId: string | null;
  hotelName: string;
  checkIn: string;
  checkOut: string;
}

export interface InboxThreadView {
  id: string;
  href: string;
  hotelName: string;
  hotelId: string;
  pipelineItemId: string;
  displayRef: string | null;
  stage: string;
  when: string;
  summary: string;
  attention: InboxAttention;
  attentionLabel: string;
  source: "gmail";
  active: boolean;
  pitchHref: string | null;
  pipelineHref: string | null;
  stale: boolean;
  suggestions: InboxSuggestionRow[];
  collaborationIds: { id: string; kind: CollaborationSuggestionKind }[];
  dates: DateSuggestionView[];
}

export interface DateSuggestionView {
  id: string;
  hotelName: string;
  checkIn: string;
  checkOut: string;
  target: "opportunity" | "trip";
  pipelineItemId: string | null;
}

export interface InboxReady {
  kind: "ready";
  heading: string;
  lede: string;
  mailbox: InboxMailbox;
  counts: { needsReply: number; followUp: number; waiting: number };
  filter: InboxFilter;
  threads: InboxThreadView[];
  selected: InboxThreadView | null;
  dates: DateSuggestionView[];
  /** A failed stay-date read. An empty list is not proof that none are waiting. */
  datesUnavailable: boolean;
  notices: string[];
  collaborationStatus: "ok" | "paused" | "hidden" | "error";
  sendGate: string;
  /** Linked conversations before the needs-reply filter. */
  linkedCount: number;
  /** Sentence for an empty thread list. Null when threads are shown. */
  emptySentence: string | null;
}

export type InboxScreenModel = InboxReady | { kind: "error"; title: string; body: string };

export interface InboxCollaborationRef {
  id: string;
  creatorId: string;
  pipelineItemId: string;
  kind: CollaborationSuggestionKind;
}

export interface InboxBuildInput {
  profileId: string;
  asOf: string;
  filter: InboxFilter;
  selectedId: string | null;
  mailbox: InboxMailbox;
  threads: readonly InboxThreadRow[];
  suggestions: readonly InboxSuggestionRow[];
  collaborations: readonly InboxCollaborationRef[];
  collaborationStatus: "ok" | "paused" | "hidden" | "error";
  dates: readonly InboxDateRow[];
  threadsCapped: boolean;
  datesCapped: boolean;
  /** The suggestion query returned more rows than this page keeps. */
  suggestionsCapped: boolean;
  suggestionsFailed: boolean;
  datesFailed: boolean;
  collaborationsFailed: boolean;
  /** The scoped Gmail suggestion read returned more rows than its cap. */
  collaborationsTruncated?: boolean;
  /** A row whose creator id is not the caller. The screen must not render it. */
  foreign: boolean;
}

export function parseInboxFilter(value: string | null | undefined): InboxFilter {
  return value === "needs-reply" || value === "needs_reply" ? "needs_reply" : "all";
}

export function classifyMailbox(input: {
  configured: boolean;
  failed: boolean;
  rows: readonly { connectionState: string; email: string | null }[];
}): InboxMailbox {
  if (!input.configured) return { kind: "unconfigured" };
  if (input.failed) return { kind: "error" };
  if (input.rows.length === 0) return { kind: "disconnected" };
  const connected = input.rows.find((row) => row.connectionState === "connected");
  if (connected) {
    const email = connected.email?.trim() ?? "";
    return { kind: "connected", email: email.length > 0 ? email : null };
  }
  if (input.rows.some((row) => row.connectionState === "reauth_required"))
    return { kind: "reauth" };
  if (input.rows.some((row) => row.connectionState === "consent_required"))
    return { kind: "consent" };
  const knownAbsent = new Set([
    "disconnected",
    "disconnecting",
    "deleted",
    "deletion_pending",
    "pending_authorization",
  ]);
  if (input.rows.every((row) => knownAbsent.has(row.connectionState)))
    return { kind: "disconnected" };
  return { kind: "error" };
}

export function threadAttention(input: {
  status: string;
  stale: boolean;
  hasHumanReply: boolean;
  suggestionKinds: readonly string[];
  collaborationKinds: readonly string[];
}): InboxAttention {
  if (input.status === "closed") return "other";
  const pendingReply =
    input.suggestionKinds.includes("mark_replied") ||
    input.collaborationKinds.includes("human_reply");
  const unreadReply =
    input.hasHumanReply &&
    !input.stale &&
    (input.status === "pitched" ||
      input.status === "follow_up" ||
      input.status === "saved" ||
      input.status === "planned");
  if (pendingReply || unreadReply) return "needs_reply";
  if (input.status === "follow_up" || input.suggestionKinds.includes("open_negotiation")) {
    return "follow_up";
  }
  if (
    input.status === "pitched" ||
    input.status === "planned" ||
    input.status === "negotiating" ||
    input.status === "saved" ||
    input.status === "replied" ||
    input.status === "won"
  ) {
    return "waiting";
  }
  return "other";
}

function calendarDay(value: string): string | null {
  const match = YMD.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return value;
}

export function inboxWhenLabel(iso: string, asOf: string): string {
  const ms = Date.parse(iso);
  const now = Date.parse(asOf);
  if (!Number.isFinite(ms) || !Number.isFinite(now)) return "Date unavailable";
  const day = (value: number) => new Date(value).toISOString().slice(0, 10);
  const happened = day(ms);
  const today = day(now);
  if (happened === today) return "Today";
  const yesterday = new Date(Date.parse(`${today}T00:00:00.000Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  if (happened === yesterday) return "Yesterday";
  const delta = Math.round(
    (Date.parse(`${today}T00:00:00.000Z`) - Date.parse(`${happened}T00:00:00.000Z`)) / 86_400_000,
  );
  if (delta > 1 && delta < 30) return `${delta} days`;
  return happened;
}

export function commercialSummary(
  row: Pick<InboxThreadRow, "commercialState" | "readingPresent" | "stale" | "hasRedirect">,
): string {
  if (!row.readingPresent) return INBOX_COPY.noClassification;
  if (row.stale) return INBOX_COPY.stale;
  if (!row.commercialState) return INBOX_COPY.noClassification;
  const base = COMMERCIAL_LABEL[row.commercialState];
  if (row.hasRedirect && row.commercialState !== "declined_observed") {
    return `${base} ${INBOX_COPY.redirect}`;
  }
  return base;
}

function attentionLabel(attention: InboxAttention, status: string): string {
  if (attention === "needs_reply") return "Needs reply";
  if (attention === "follow_up") return "Follow-up";
  if (attention === "waiting") return "Waiting";
  return pipelineStatusLabel(status);
}

function isMachine(value: string | null): value is MachineThreadState | null {
  if (value === null) return true;
  return (MACHINE_THREAD_STATES as readonly string[]).includes(value);
}

function cleanDisplayRef(value: string | null): string | null {
  if (value === null) return null;
  return DISPLAY_REF.test(value) ? value : null;
}

function dateView(row: InboxDateRow): DateSuggestionView | null {
  const checkIn = calendarDay(row.checkIn);
  const checkOut = calendarDay(row.checkOut);
  if (!checkIn || !checkOut || checkOut <= checkIn) return null;
  if (!isUuid(row.id)) return null;
  const name = row.hotelName.trim();
  if (!name) return null;
  if (row.pipelineItemId && row.tripHotelId) return null;
  if (!row.pipelineItemId && !row.tripHotelId) return null;
  if (row.pipelineItemId && !isUuid(row.pipelineItemId)) return null;
  if (row.tripHotelId && !isUuid(row.tripHotelId)) return null;
  return {
    id: row.id,
    hotelName: name,
    checkIn,
    checkOut,
    target: row.pipelineItemId ? "opportunity" : "trip",
    pipelineItemId: row.pipelineItemId,
  };
}

const ATTENTION_RANK: Record<InboxAttention, number> = {
  needs_reply: 0,
  follow_up: 1,
  waiting: 2,
  other: 3,
};

export function buildInboxScreen(input: InboxBuildInput): InboxScreenModel {
  if (!isUuid(input.profileId) || input.foreign) {
    return { kind: "error", title: INBOX_COPY.errorTitle, body: INBOX_COPY.errorBody };
  }

  const suggestionsByItem = new Map<string, InboxSuggestionRow[]>();
  for (const row of input.suggestions) {
    if (row.creatorId !== input.profileId) {
      return { kind: "error", title: INBOX_COPY.errorTitle, body: INBOX_COPY.errorBody };
    }
    if (!isUuid(row.id) || !isUuid(row.pipelineItemId)) {
      return { kind: "error", title: INBOX_COPY.errorTitle, body: INBOX_COPY.errorBody };
    }
    if (!(INBOX_SUGGESTION_KINDS as readonly string[]).includes(row.kind)) {
      return { kind: "error", title: INBOX_COPY.errorTitle, body: INBOX_COPY.errorBody };
    }
    const list = suggestionsByItem.get(row.pipelineItemId) ?? [];
    list.push(row);
    suggestionsByItem.set(row.pipelineItemId, list);
  }

  const collaborationsByItem = new Map<
    string,
    { id: string; kind: CollaborationSuggestionKind }[]
  >();
  if (input.collaborationStatus === "ok") {
    for (const row of input.collaborations) {
      if (row.creatorId !== input.profileId) {
        return { kind: "error", title: INBOX_COPY.errorTitle, body: INBOX_COPY.errorBody };
      }
      if (
        !isUuid(row.id) ||
        !isUuid(row.pipelineItemId) ||
        !(COLLABORATION_SUGGESTION_KINDS as readonly string[]).includes(row.kind)
      ) {
        return { kind: "error", title: INBOX_COPY.errorTitle, body: INBOX_COPY.errorBody };
      }
      const list = collaborationsByItem.get(row.pipelineItemId) ?? [];
      list.push({ id: row.id, kind: row.kind });
      collaborationsByItem.set(row.pipelineItemId, list);
    }
  }

  const dates: DateSuggestionView[] = [];
  if (!input.datesFailed) {
    for (const row of input.dates) {
      if (row.creatorId !== input.profileId) {
        return { kind: "error", title: INBOX_COPY.errorTitle, body: INBOX_COPY.errorBody };
      }
      const view = dateView(row);
      if (!view) return { kind: "error", title: INBOX_COPY.errorTitle, body: INBOX_COPY.errorBody };
      dates.push(view);
    }
  }

  const built: (Omit<InboxThreadView, "href" | "active" | "dates"> & { updatedAt: string })[] = [];
  for (const row of input.threads) {
    if (row.creatorId !== input.profileId) {
      return { kind: "error", title: INBOX_COPY.errorTitle, body: INBOX_COPY.errorBody };
    }
    const name = row.hotelName.trim();
    if (
      !isUuid(row.bindingId) ||
      !isUuid(row.pipelineItemId) ||
      !isUuid(row.hotelId) ||
      !name ||
      !isMachine(row.commercialState) ||
      Date.parse(row.updatedAt) !== Date.parse(row.updatedAt)
    ) {
      return { kind: "error", title: INBOX_COPY.errorTitle, body: INBOX_COPY.errorBody };
    }
    const suggestions = suggestionsByItem.get(row.pipelineItemId) ?? [];
    const collaborationIds = collaborationsByItem.get(row.pipelineItemId) ?? [];
    const pipelineBase = hotelHref(row.hotelId, { kind: "pipeline" });
    const attention = threadAttention({
      status: row.status,
      stale: row.stale,
      hasHumanReply: row.hasHumanReply,
      suggestionKinds: suggestions.map((item) => item.kind),
      collaborationKinds: collaborationIds.map((item) => item.kind),
    });
    built.push({
      id: row.bindingId,
      hotelName: name,
      hotelId: row.hotelId,
      pipelineItemId: row.pipelineItemId,
      displayRef: cleanDisplayRef(row.displayRef),
      stage: pipelineStageLabel(row.status) ?? pipelineStatusLabel(row.status),
      when: inboxWhenLabel(row.updatedAt, input.asOf),
      summary: commercialSummary(row),
      attention,
      attentionLabel: attentionLabel(attention, row.status),
      source: "gmail",
      pitchHref: pitchHref(row.hotelId, row.tripId, { kind: "inbox" }, row.pipelineItemId),
      pipelineHref: pipelineBase
        ? withOpportunityQuery(pipelineBase, row.pipelineItemId, row.tripId)
        : null,
      stale: row.stale,
      suggestions,
      collaborationIds,
      updatedAt: row.updatedAt,
    });
  }

  built.sort((a, b) => {
    const rank = ATTENTION_RANK[a.attention] - ATTENTION_RANK[b.attention];
    if (rank !== 0) return rank;
    const delta = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (delta !== 0) return delta;
    return a.id < b.id ? -1 : 1;
  });

  const counts = {
    needsReply: built.filter((row) => row.attention === "needs_reply").length,
    followUp: built.filter((row) => row.attention === "follow_up").length,
    waiting: built.filter((row) => row.attention === "waiting").length,
  };

  const visible =
    input.filter === "needs_reply" ? built.filter((row) => row.attention === "needs_reply") : built;
  const selectedId =
    input.selectedId && visible.some((row) => row.id === input.selectedId)
      ? input.selectedId
      : (visible[0]?.id ?? null);

  const emptySentence =
    visible.length > 0
      ? null
      : built.length > 0
        ? INBOX_COPY.emptyNeedsReply
        : input.mailbox.kind === "connected" || input.mailbox.kind === "reauth"
          ? INBOX_COPY.emptyConnected
          : INBOX_COPY.emptyDisconnected;

  const threads: InboxThreadView[] = visible.map((row) => {
    const { updatedAt: _updatedAt, ...rest } = row;
    return {
      ...rest,
      href: inboxHref(input.filter, row.id),
      active: row.id === selectedId,
      dates: dates.filter((date) => date.pipelineItemId === row.pipelineItemId),
    };
  });

  const notices: string[] = [];
  if (input.threadsCapped) notices.push(INBOX_COPY.truncated);
  if (input.datesCapped) notices.push(INBOX_COPY.datesTruncated);
  if (input.suggestionsCapped) notices.push(INBOX_COPY.suggestionsTruncated);
  if (input.suggestionsFailed) notices.push(INBOX_COPY.suggestionsError);
  if (input.datesFailed) notices.push(INBOX_COPY.datesError);
  if (input.collaborationsFailed || input.collaborationStatus === "error") {
    notices.push(INBOX_COPY.gmailError);
  }
  if (input.collaborationStatus === "paused") notices.push(INBOX_COPY.gmailPaused);
  if (input.collaborationsTruncated) notices.push(INBOX_COPY.gmailTruncated);

  const reviewFailed =
    input.suggestionsFailed || input.collaborationsFailed || input.collaborationStatus === "error";
  const reviewIncomplete = input.suggestionsCapped || input.collaborationsTruncated === true;
  let heading = "Nothing in these conversations needs a reply.";
  if (built.length === 0) heading = "No linked conversations yet.";
  else if (counts.needsReply > 0) {
    heading =
      counts.needsReply === 1
        ? "One conversation needs a reply."
        : `${counts.needsReply} conversations need a reply.`;
  } else if (reviewFailed) heading = INBOX_COPY.reviewUnavailable;
  else if (reviewIncomplete) heading = INBOX_COPY.suggestionsCappedHeading;
  else if (counts.followUp > 0) {
    heading =
      counts.followUp === 1
        ? "One follow-up is waiting."
        : `${counts.followUp} follow-ups are waiting.`;
  }

  return {
    kind: "ready",
    heading,
    lede: INBOX_COPY.lede,
    mailbox: input.mailbox,
    counts,
    filter: input.filter,
    threads,
    selected: threads.find((row) => row.active) ?? null,
    dates,
    datesUnavailable: input.datesFailed,
    notices,
    collaborationStatus: input.collaborationStatus,
    sendGate: INBOX_SEND_GATE,
    linkedCount: built.length,
    emptySentence,
  };
}

export function datePanelState(input: {
  datesUnavailable: boolean;
  dateCount: number;
}): { kind: "unavailable"; text: string } | { kind: "empty"; text: string } | { kind: "list" } {
  if (input.datesUnavailable) return { kind: "unavailable", text: INBOX_COPY.datesError };
  if (input.dateCount === 0) return { kind: "empty", text: INBOX_COPY.datesEmpty };
  return { kind: "list" };
}

/**
 * A revoked mailbox with no linked conversation is an authorization failure.
 * It is not an empty inbox. The rest of the page, including date decisions, still renders.
 */
export function revokedEmptyInbox(model: InboxReady): { title: string; body: string } | null {
  if (model.mailbox.kind !== "reauth" || model.linkedCount > 0) return null;
  return REVOKED_INBOX_COPY;
}

export function inboxHref(filter: InboxFilter, threadId?: string | null): string {
  const params = new URLSearchParams();
  if (filter === "needs_reply") params.set("filter", "needs-reply");
  if (threadId && isUuid(threadId)) params.set("thread", threadId);
  const query = params.toString();
  return query ? `/app/inbox?${query}` : "/app/inbox";
}

const DATE_RESULTS = new Set([
  "accepted",
  "rejected",
  "overlap",
  "not_pending",
  "not_found",
  "invalid_input",
  "creator_profile_missing",
  "error",
]);

export function mapDateDecision(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "error";
  const result = (payload as { result?: unknown }).result;
  return typeof result === "string" && DATE_RESULTS.has(result) ? result : "error";
}

export function dateDecisionMessage(result: string): string {
  if (result === "accepted") {
    return "Accepted. Those dates are now on that one record. Night status was not changed.";
  }
  if (result === "rejected") return "Rejected. The stored dates are unchanged.";
  if (result === "overlap") {
    return "Those dates overlap another open opportunity. The suggestion stays pending and the stored dates are unchanged.";
  }
  if (result === "not_pending") return "That suggestion is no longer waiting. Nothing was changed.";
  if (result === "not_found" || result === "creator_profile_missing") {
    return "That suggestion is not on your account. Nothing was changed.";
  }
  return "That suggestion could not be saved. Nothing was changed.";
}

export function suggestionKindLabel(kind: InboxSuggestionKind): string {
  return SUGGESTION_LABEL[kind];
}
