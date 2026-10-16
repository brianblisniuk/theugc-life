/**
 * Home next actions (D112).
 *
 * A fixed order over rows the caller already owns. There is no composite
 * score and no model. A failed read is an error notice, not an empty list.
 * A paused Gmail read contributes no suggestion ids.
 */
import { CREDITS_CONFIG, OUT_OF_CREDITS_COPY, creditsLeftLabel } from "@/lib/credits/config";
import { isUuid } from "@/lib/hotels/ids";
import { PIPELINE_STATUSES, type PipelineStatus } from "@/lib/pipeline/types";
import { hotelHref } from "@/lib/shell/navigation";

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
  blocked: "No pudimos revisar tus próximas acciones. Esto no es una lista vacía.",
  followUps: "No pudimos revisar seguimientos. Esto no es que no haya nada pendiente.",
  deliverables: "No pudimos revisar entregas. Esto no es que no haya nada pendiente.",
  gmail: "No pudimos revisar sugerencias de Gmail. Esto no es que no haya ninguna.",
  pipeline: "No pudimos revisar tu pipeline. Esto no es un pipeline vacío.",
  pipelineCapped:
    "La lista de pipeline que leímos tiene un tope. El conteo de seguimientos de esta página no es el total de la base.",
  deliverablesCapped: "La lista de entregas que leímos tiene un tope. No es el total de la base.",
  gmailTruncated:
    "Hay más sugerencias de Gmail que las que esta página lista. Esto no dice cuántas.",
  credits: "No pudimos leer tus créditos. Esto no es cero.",
  empty: "No hay una acción pendiente con los datos que pudimos leer.",
  open: "Abrir",
  followUpTitle: (name: string) => `Seguimiento a ${name}`,
  followUpDetail: (when: string) => `Venció el ${when}. El silencio no es ghosting.`,
  deliverableTitle: (name: string) => `Entrega pendiente en ${name}`,
  deliverableDetail: (when: string) => `La fecha era ${when}.`,
  gmailTitle: {
    human_reply: (name: string) => `Respuesta humana de ${name}`,
    pitch_sent: (name: string) => `Pitch detectado a ${name}`,
    collaboration: (name: string) => `Sugerencia de colaboración con ${name}`,
  },
  gmailDetail: {
    human_reply:
      "Es una sugerencia. Confirmala con tu lectura. Un auto-responder no cuenta. No se envía ningún mail.",
    pitch_sent: "Es una sugerencia. Confirmar lo anota en tu pipeline. No se envía ningún mail.",
    collaboration:
      "Confirmar no crea la colaboración ni un hecho del hotel. No se envía ningún mail.",
  },
  pipelineTitle: {
    negotiating: (name: string) => `Negociación abierta con ${name}`,
    replied: (name: string) => `${name} respondió`,
    follow_up: (name: string) => `${name} está en seguimiento`,
    pitched: (name: string) => `Pitch enviado a ${name}`,
    won: (name: string) => `Acuerdo con ${name}`,
    planned: (name: string) => `Pitch planificado a ${name}`,
    saved: (name: string) => `Hotel guardado: ${name}`,
  } satisfies Record<Exclude<PipelineStatus, "closed">, (name: string) => string>,
  pipelineDetail: "Abrí el ciclo y elegí el próximo paso. Esta página no cambia el estado.",
  catalogTrip: "Hoteles de tu próximo viaje",
  catalogOnboarding: "Descubrimiento recomendado",
  catalogNote: "Del catálogo publicado. Sin ranking y sin un modelo.",
  hidden: (count: number) =>
    count === 1 ? "Hay 1 acción más en tus datos." : `Hay ${count} acciones más en tus datos.`,
  followUpCount: (count: number) =>
    count === 1 ? "1 seguimiento vencido." : `${count} seguimientos vencidos.`,
  creditAvailable: (cost: number) =>
    cost === 1
      ? "Desbloquear un contacto nuevo cuesta 1 crédito."
      : `Desbloquear un contacto nuevo cuesta ${cost} créditos.`,
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

function pipelineHref(hotelId: string): string | null {
  return hotelHref(hotelId, { kind: "pipeline" });
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
    seen.add(row.id);
    clean.push({ ...row, hotelName: name });
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
        const href = pipelineHref(row.hotelId);
        const when = instantMs(row.nextFollowupAt!);
        if (!href || when === null) {
          dueOk = false;
          break;
        }
        dueActions.push({
          id: `follow-up:${row.id}`,
          kind: "follow_up_due",
          title: HOME_NEXT_COPY.followUpTitle(row.hotelName),
          detail: HOME_NEXT_COPY.followUpDetail(new Date(when).toISOString().slice(0, 10)),
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
        const href = pipelineHref(row.hotelId);
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
    const href = hotelHref(row.hotelId, { kind: "inbox" }, "activity");
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
