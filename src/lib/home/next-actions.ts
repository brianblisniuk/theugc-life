/**
 * Home next actions (D112).
 *
 * A fixed order over rows the caller already owns. There is no composite
 * score and no model. A failed read is an error notice, not an empty list.
 * A paused Gmail read contributes no suggestion ids.
 */
import { CREDITS_CONFIG, OUT_OF_CREDITS_COPY, creditsLeftLabel } from "@/lib/credits/config";
import { isUuid } from "@/lib/hotels/ids";
import { civilDate } from "@/lib/time/civil-date";
import { PIPELINE_STATUSES, type PipelineStatus } from "@/lib/pipeline/types";
import { hotelHref, withOpportunityQuery } from "@/lib/shell/navigation";

import {
  COLLABORATION_SUGGESTION_KINDS,
  type CollaborationSuggestionKind,
} from "@/lib/gmail/collaboration/contract";

export const HOME_NEXT_ACTION_CAP = 8;
export const HOME_PIPELINE_READ_LIMIT = 80;
export const HOME_DELIVERABLE_READ_LIMIT = 80;
export const HOME_GMAIL_READ_LIMIT = 100;

const GMAIL_KIND_ORDER: readonly CollaborationSuggestionKind[] = [
  "human_reply",
  "pitch_sent",
  "collaboration",
];

const PIPELINE_ATTENTION_ORDER: readonly PipelineStatus[] = [
  "negotiating",
  "replied",
  "follow_up",
  "pitched",
  "won",
  "planned",
  "saved",
];

const DELIVERABLE_STATUSES = [
  "pending",
  "submitted",
  "revision_requested",
  "approved",
  "rejected",
] as const;
type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];

const DUE_DELIVERABLE_STATUSES: readonly DeliverableStatus[] = ["pending", "rejected"];

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

export const HOME_NEXT_COPY = {
  blocked: "We could not review your next actions. This is not an empty list.",
  followUps: "We could not review follow-ups. This does not mean nothing is due.",
  deliverables: "We could not review deliverables. This does not mean nothing is due.",
  gmail: "We could not review Gmail suggestions. This does not mean there are none.",
  pipeline: "We could not review your pipeline. This is not an empty pipeline.",
  pipelineCapped:
    "The pipeline list we read is capped. The follow-up count on this page is not the database total.",
  deliverablesCapped: "The deliverable list we read is capped. It is not the database total.",
  gmailTruncated:
    "There are more Gmail suggestions than this page lists. It does not say how many.",
  credits: "We could not read your credits. This is not zero.",
  empty: "No pending action in the data we could read.",
  open: "Open",
  followUpTitle: (name: string) => `Follow up with ${name}`,
  followUpDetail: (when: string) => `Due ${when}. Silence is not ghosting.`,
  deliverableTitle: (name: string) => `Deliverable due at ${name}`,
  deliverableDetail: (when: string) => `The date was ${when}.`,
  gmailTitle: {
    human_reply: (name: string) => `Human reply from ${name}`,
    pitch_sent: (name: string) => `Pitch detected to ${name}`,
    collaboration: (name: string) => `Collaboration suggestion with ${name}`,
  },
  gmailDetail: {
    human_reply:
      "This is a suggestion. Confirm it with your own reading. An auto-reply does not count. No email is sent.",
    pitch_sent: "This is a suggestion. Confirming records it on your pipeline. No email is sent.",
    collaboration:
      "Confirming does not create the collaboration or a hotel fact. No email is sent.",
  },
  pipelineTitle: {
    negotiating: (name: string) => `Open negotiation with ${name}`,
    replied: (name: string) => `${name} replied`,
    follow_up: (name: string) => `${name} is in follow-up`,
    pitched: (name: string) => `Pitch sent to ${name}`,
    won: (name: string) => `Agreement with ${name}`,
    planned: (name: string) => `Pitch planned for ${name}`,
    saved: (name: string) => `Saved hotel: ${name}`,
  } satisfies Record<Exclude<PipelineStatus, "closed">, (name: string) => string>,
  pipelineDetail: "Open the cycle and choose the next step. This page does not change the status.",
  catalogTrip: "Hotels from your next trip",
  catalogOnboarding: "Recommended discovery",
  catalogNote: "From the published catalog. No ranking and no model.",
  hidden: (count: number) =>
    count === 1 ? "1 more action is in your data." : `${count} more actions are in your data.`,
  followUpCount: (count: number) =>
    count === 1 ? "1 follow-up is due." : `${count} follow-ups are due.`,
  creditAvailable: (cost: number) =>
    cost === 1
      ? "Unlocking a new contact costs 1 credit."
      : `Unlocking a new contact costs ${cost} credits.`,
} as const;

export interface NextAction {
  id: string;
  kind: "follow_up_due" | "deliverable_due" | "gmail_suggestion" | "pipeline" | "credits";
  title: string;
  detail: string;
  href: string | null;
}

export interface NextActionNotice {
  id: string;
  text: string;
}

export interface NextActionBoard {
  actions: NextAction[];
  hiddenCount: number;
  /** Null when the follow-up read failed. A successful zero stays zero. */
  followUpsDue: number | null;
  notices: NextActionNotice[];
  credits: NextAction | null;
  empty: string | null;
}

export interface OwnedPipelineItem {
  id: string;
  creatorId: string;
  status: string;
  hotelId: string;
  hotelName: string;
  nextFollowupAt: string | null;
  lastActivityAt: string | null;
  tripId: string | null;
}

export interface OwnedDeliverable {
  id: string;
  creatorId: string;
  status: string;
  hotelId: string;
  hotelName: string;
  dueOn: string | null;
}

export interface OwnedGmailSuggestion {
  id: string;
  creatorId: string;
  kind: CollaborationSuggestionKind;
  pipelineItemId: string;
  hotelId: string;
  hotelName: string;
}

export type GmailSource =
  | { status: "ok"; suggestions: OwnedGmailSuggestion[]; truncated: boolean }
  | { status: "paused" }
  | { status: "hidden" }
  | { status: "error" };

export type CreditSource = { status: "ok"; balance: number } | { status: "error" };

export interface NextActionInput {
  profileId: string;
  asOf: string;
  /** IANA zone for the follow-up due label. Due detection still uses the instant. */
  timeZone?: string | null;
  pipeline: { status: "ok"; items: OwnedPipelineItem[]; capped: boolean } | { status: "error" };
  deliverables: { status: "ok"; items: OwnedDeliverable[]; capped: boolean } | { status: "error" };
  gmail: GmailSource;
  credits: CreditSource;
}

export function blockedNextActionBoard(): NextActionBoard {
  return {
    actions: [],
    hiddenCount: 0,
    followUpsDue: null,
    notices: [{ id: "home", text: HOME_NEXT_COPY.blocked }],
    credits: null,
    empty: null,
  };
}

export function recommendationDestination(
  tripSlug: string | null | undefined,
  onboardingSlug: string | null | undefined,
): { slug: string | null; source: "trip" | "onboarding" | "none" } {
  const trip = typeof tripSlug === "string" ? tripSlug.trim() : "";
  if (trip) return { slug: trip, source: "trip" };
  const onboarding = typeof onboardingSlug === "string" ? onboardingSlug.trim() : "";
  if (onboarding) return { slug: onboarding, source: "onboarding" };
  return { slug: null, source: "none" };
}

function instantMs(value: string): number | null {
  if (typeof value !== "string" || value.length < 10 || value.trim() !== value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
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

function asOfParts(asOf: string): { ms: number; day: string } | null {
  const ms = instantMs(asOf);
  if (ms === null) return null;
  return { ms, day: new Date(ms).toISOString().slice(0, 10) };
}

function isPipelineStatus(value: string): value is PipelineStatus {
  return (PIPELINE_STATUSES as readonly string[]).includes(value);
}

function cleanName(value: string): string | null {
  const name = value.trim();
  return name.length > 0 ? name : null;
}

function owned<T extends { creatorId: string }>(rows: readonly T[], profileId: string): T[] {
  return rows.filter((row) => row.creatorId === profileId);
}

function pipelineHref(
  hotelId: string,
  opportunityId: string,
  tripId: string | null,
): string | null {
  const href = hotelHref(hotelId, { kind: "pipeline" });
  return href ? withOpportunityQuery(href, opportunityId, tripId) : null;
}

function creditAction(balance: number): NextAction {
  const out = balance < CREDITS_CONFIG.unlockCost;
  return {
    id: "credits",
    kind: "credits",
    title: creditsLeftLabel(balance),
    detail: out ? OUT_OF_CREDITS_COPY : HOME_NEXT_COPY.creditAvailable(CREDITS_CONFIG.unlockCost),
    href: null,
  };
}

/**
 * Pending suggestions for the signed-in owner. `paused` drops every id that
 * arrived with the payload. `not_found` is hidden. A bad row is an error and
 * the returned value has no ids.
 */
export function parseOwnGmailSuggestions(data: unknown, profileId: string): GmailSource {
  if (!isUuid(profileId) || !data || typeof data !== "object") return { status: "error" };
  const result = (data as { result?: unknown }).result;
  if (result === "paused") return { status: "paused" };
  if (result === "not_found") return { status: "hidden" };
  if (result !== "ok") return { status: "error" };
  const raw = (data as { suggestions?: unknown }).suggestions;
  const truncated = (data as { truncated?: unknown }).truncated;
  if (!Array.isArray(raw) || typeof truncated !== "boolean") return { status: "error" };
  const suggestions: OwnedGmailSuggestion[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    if (!row || typeof row !== "object") return { status: "error" };
    const record = row as Record<string, unknown>;
    const id = record.id;
    const kind = record.kind;
    const pipelineItemId = record.pipeline_item_id;
    const hotelId = record.hotel_id;
    const hotelName = record.hotel_name;
    if (
      typeof id !== "string" ||
      !isUuid(id) ||
      typeof pipelineItemId !== "string" ||
      !isUuid(pipelineItemId) ||
      typeof hotelId !== "string" ||
      !isUuid(hotelId) ||
      typeof hotelName !== "string" ||
      !cleanName(hotelName) ||
      !COLLABORATION_SUGGESTION_KINDS.includes(kind as CollaborationSuggestionKind)
    ) {
      return { status: "error" };
    }
    if (seen.has(id)) return { status: "error" };
    seen.add(id);
    suggestions.push({
      id,
      creatorId: profileId,
      kind: kind as CollaborationSuggestionKind,
      pipelineItemId,
      hotelId,
      hotelName: cleanName(hotelName)!,
    });
  }
  return { status: "ok", suggestions, truncated };
}

function validatePipeline(
  items: readonly OwnedPipelineItem[],
  profileId: string,
): { ok: true; items: OwnedPipelineItem[] } | { ok: false } {
  const rows = owned(items, profileId);
  const seen = new Set<string>();
  const clean: OwnedPipelineItem[] = [];
  for (const row of rows) {
    const name = cleanName(row.hotelName);
    if (
      !isUuid(row.id) ||
      !isUuid(row.hotelId) ||
      !name ||
      !isPipelineStatus(row.status) ||
      seen.has(row.id)
    ) {
      return { ok: false };
    }
    if (row.nextFollowupAt !== null && instantMs(row.nextFollowupAt) === null) return { ok: false };
    if (row.lastActivityAt !== null && instantMs(row.lastActivityAt) === null) return { ok: false };
    if (row.tripId !== null && !isUuid(row.tripId)) return { ok: false };
    seen.add(row.id);
    clean.push({ ...row, hotelName: name, tripId: row.tripId });
  }
  return { ok: true, items: clean };
}

function validateDeliverables(
  items: readonly OwnedDeliverable[],
  profileId: string,
): { ok: true; items: OwnedDeliverable[] } | { ok: false } {
  const rows = owned(items, profileId);
  const seen = new Set<string>();
  const clean: OwnedDeliverable[] = [];
  for (const row of rows) {
    const name = cleanName(row.hotelName);
    if (
      !isUuid(row.id) ||
      !isUuid(row.hotelId) ||
      !name ||
      !(DELIVERABLE_STATUSES as readonly string[]).includes(row.status) ||
      seen.has(row.id)
    ) {
      return { ok: false };
    }
    if (row.dueOn !== null && calendarDay(row.dueOn) === null) return { ok: false };
    seen.add(row.id);
    clean.push({ ...row, hotelName: name, dueOn: row.dueOn });
  }
  return { ok: true, items: clean };
}

function validateGmail(
  source: GmailSource,
  profileId: string,
): { ok: true; suggestions: OwnedGmailSuggestion[]; truncated: boolean } | { ok: false } {
  if (source.status === "paused" || source.status === "hidden") {
    return { ok: true, suggestions: [], truncated: false };
  }
  if (source.status === "error") return { ok: false };
  const rows = owned(source.suggestions, profileId);
  const seen = new Set<string>();
  const clean: OwnedGmailSuggestion[] = [];
  for (const row of rows) {
    const name = cleanName(row.hotelName);
    if (
      !isUuid(row.id) ||
      !isUuid(row.pipelineItemId) ||
      !isUuid(row.hotelId) ||
      !name ||
      !COLLABORATION_SUGGESTION_KINDS.includes(row.kind) ||
      seen.has(row.id)
    ) {
      return { ok: false };
    }
    seen.add(row.id);
    const href = hotelHref(row.hotelId, { kind: "inbox" }, "activity");
    if (!href) return { ok: false };
    clean.push({ ...row, hotelName: name });
  }
  return { ok: true, suggestions: clean, truncated: source.truncated };
}

/**
 * Order is the kind order below, then a date or a status inside that kind.
 * Credits stay off the capped list. Gmail ids appear only when the source is ok.
 */
export function prioritizeNextActions(input: NextActionInput): NextActionBoard {
  if (!isUuid(input.profileId)) return blockedNextActionBoard();
  const clock = asOfParts(input.asOf);
  const notices: NextActionNotice[] = [];
  const operational: NextAction[] = [];

  let followUpsDue: number | null = null;
  const followUpIds = new Set<string>();

  if (!clock || input.pipeline.status === "error") {
    notices.push({ id: "follow-ups", text: HOME_NEXT_COPY.followUps });
    notices.push({ id: "pipeline", text: HOME_NEXT_COPY.pipeline });
  } else {
    const pipeline = validatePipeline(input.pipeline.items, input.profileId);
    if (!pipeline.ok) {
      notices.push({ id: "follow-ups", text: HOME_NEXT_COPY.followUps });
      notices.push({ id: "pipeline", text: HOME_NEXT_COPY.pipeline });
    } else {
      if (input.pipeline.capped) {
        notices.push({ id: "pipeline-capped", text: HOME_NEXT_COPY.pipelineCapped });
      }
      const due = pipeline.items
        .filter((row) => {
          if (row.status === "closed" || row.nextFollowupAt === null) return false;
          const ms = instantMs(row.nextFollowupAt);
          return ms !== null && ms <= clock.ms;
        })
        .sort((a, b) => {
          const delta = instantMs(a.nextFollowupAt!)! - instantMs(b.nextFollowupAt!)!;
          if (delta !== 0) return delta;
          return a.id < b.id ? -1 : 1;
        });
      const dueActions: NextAction[] = [];
      let dueOk = true;
      for (const row of due) {
        const href = pipelineHref(row.hotelId, row.id, row.tripId);
        const when = instantMs(row.nextFollowupAt!);
        const dueDay =
          when === null ? null : civilDate(new Date(when).toISOString(), input.timeZone ?? "UTC");
        if (!href || when === null || !dueDay) {
          dueOk = false;
          break;
        }
        dueActions.push({
          id: `follow-up:${row.id}`,
          kind: "follow_up_due",
          title: HOME_NEXT_COPY.followUpTitle(row.hotelName),
          detail: HOME_NEXT_COPY.followUpDetail(dueDay),
          href,
        });
      }
      if (!dueOk) {
        notices.push({ id: "follow-ups", text: HOME_NEXT_COPY.followUps });
      } else {
        followUpsDue = due.length;
        for (const row of due) followUpIds.add(row.id);
        operational.push(...dueActions);
      }
    }
  }

  if (!clock || input.deliverables.status === "error") {
    notices.push({ id: "deliverables", text: HOME_NEXT_COPY.deliverables });
  } else {
    const deliverables = validateDeliverables(input.deliverables.items, input.profileId);
    if (!deliverables.ok) {
      notices.push({ id: "deliverables", text: HOME_NEXT_COPY.deliverables });
    } else {
      if (input.deliverables.capped) {
        notices.push({ id: "deliverables-capped", text: HOME_NEXT_COPY.deliverablesCapped });
      }
      const due = deliverables.items
        .filter((row) => {
          if (row.dueOn === null) return false;
          if (!(DUE_DELIVERABLE_STATUSES as readonly string[]).includes(row.status)) return false;
          return row.dueOn <= clock.day;
        })
        .sort((a, b) => {
          if (a.dueOn !== b.dueOn) return a.dueOn! < b.dueOn! ? -1 : 1;
          return a.id < b.id ? -1 : 1;
        });
      const dueActions: NextAction[] = [];
      let dueOk = true;
      for (const row of due) {
        const href = hotelHref(row.hotelId, { kind: "collaboration" }, "collaboration");
        if (!href || row.dueOn === null) {
          dueOk = false;
          break;
        }
        dueActions.push({
          id: `deliverable:${row.id}`,
          kind: "deliverable_due",
          title: HOME_NEXT_COPY.deliverableTitle(row.hotelName),
          detail: HOME_NEXT_COPY.deliverableDetail(row.dueOn),
          href,
        });
      }
      if (!dueOk) {
        notices.push({ id: "deliverables", text: HOME_NEXT_COPY.deliverables });
      } else {
        operational.push(...dueActions);
      }
    }
  }

  const gmail = validateGmail(input.gmail, input.profileId);
  if (!gmail.ok) {
    notices.push({ id: "gmail", text: HOME_NEXT_COPY.gmail });
  } else {
    if (gmail.truncated) {
      notices.push({ id: "gmail-truncated", text: HOME_NEXT_COPY.gmailTruncated });
    }
    const gmailActions = gmailActionsFor(gmail.suggestions);
    if (gmailActions === null) {
      notices.push({ id: "gmail", text: HOME_NEXT_COPY.gmail });
    } else {
      operational.push(...gmailActions);
    }
  }

  if (
    clock &&
    input.pipeline.status === "ok" &&
    !notices.some((notice) => notice.id === "pipeline")
  ) {
    const pipeline = validatePipeline(input.pipeline.items, input.profileId);
    if (pipeline.ok) {
      const attention = pipeline.items
        .filter((row) => row.status !== "closed" && !followUpIds.has(row.id))
        .sort((a, b) => {
          const rank =
            PIPELINE_ATTENTION_ORDER.indexOf(a.status as PipelineStatus) -
            PIPELINE_ATTENTION_ORDER.indexOf(b.status as PipelineStatus);
          if (rank !== 0) return rank;
          const aMs = a.lastActivityAt === null ? null : instantMs(a.lastActivityAt);
          const bMs = b.lastActivityAt === null ? null : instantMs(b.lastActivityAt);
          if (aMs === null && bMs !== null) return 1;
          if (aMs !== null && bMs === null) return -1;
          if (aMs !== null && bMs !== null && aMs !== bMs) return aMs - bMs;
          return a.id < b.id ? -1 : 1;
        });
      for (const row of attention) {
        const href = pipelineHref(row.hotelId, row.id, row.tripId);
        const title =
          row.status === "closed"
            ? null
            : HOME_NEXT_COPY.pipelineTitle[row.status as Exclude<PipelineStatus, "closed">];
        if (!href || !title) continue;
        operational.push({
          id: `pipeline:${row.id}`,
          kind: "pipeline",
          title: title(row.hotelName),
          detail: HOME_NEXT_COPY.pipelineDetail,
          href,
        });
      }
    }
  }

  let credits: NextAction | null = null;
  if (input.credits.status === "ok" && Number.isSafeInteger(input.credits.balance)) {
    credits = creditAction(input.credits.balance);
  } else {
    notices.push({ id: "credits", text: HOME_NEXT_COPY.credits });
  }

  const actions = operational.slice(0, HOME_NEXT_ACTION_CAP);
  const hiddenCount = operational.length - actions.length;
  return {
    actions,
    hiddenCount,
    followUpsDue,
    notices,
    credits,
    empty: actions.length === 0 && notices.length === 0 ? HOME_NEXT_COPY.empty : null,
  };
}

function gmailActionsFor(suggestions: readonly OwnedGmailSuggestion[]): NextAction[] | null {
  const ordered = [...suggestions].sort((a, b) => {
    const rank = GMAIL_KIND_ORDER.indexOf(a.kind) - GMAIL_KIND_ORDER.indexOf(b.kind);
    if (rank !== 0) return rank;
    return a.id < b.id ? -1 : 1;
  });
  const actions: NextAction[] = [];
  for (const row of ordered) {
    const base = hotelHref(row.hotelId, { kind: "inbox" }, "activity");
    const href = base ? withOpportunityQuery(base, row.pipelineItemId, null) : null;
    if (!href) return null;
    actions.push({
      id: `gmail:${row.id}`,
      kind: "gmail_suggestion",
      title: HOME_NEXT_COPY.gmailTitle[row.kind](row.hotelName),
      detail: HOME_NEXT_COPY.gmailDetail[row.kind],
      href,
    });
  }
  return actions;
}
