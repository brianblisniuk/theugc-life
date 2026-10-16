/**
 * Inbox reads for the signed-in creator (V2-S4).
 *
 * The cookie-bound client is the boundary. Message bodies and OAuth tokens
 * are not selected. Opening this loader does not start a Gmail sync and does
 * not send mail. A row owned by someone else is an error, not a list item.
 */
import "server-only";

import { isGmailOAuthConfigured } from "@/lib/gmail/env.server";
import { parseOwnGmailSuggestions } from "@/lib/home/next-actions";
import { LIST_OWN_GMAIL_SUGGESTIONS_RPC } from "@/lib/home/queries";
import { isUuid } from "@/lib/hotels/ids";
import {
  INBOX_SUGGESTION_KINDS,
  MACHINE_THREAD_STATES,
  type InboxSuggestionKind,
  type MachineThreadState,
} from "@/lib/inbox-pipeline/contract";
import { resolveOwnProfile } from "@/lib/onboarding/first-run";
import { createClient } from "@/lib/supabase/server";

import {
  INBOX_COPY,
  INBOX_DATE_CAP,
  INBOX_SUGGESTION_CAP,
  INBOX_THREAD_CAP,
  buildInboxScreen,
  classifyMailbox,
  parseInboxFilter,
  type InboxBuildInput,
  type InboxCollaborationRef,
  type InboxDateRow,
  type InboxMailbox,
  type InboxScreenModel,
  type InboxSuggestionRow,
  type InboxThreadRow,
} from "./model";

type QueryResult = { data: unknown; error: { message?: string } | null };

export type InboxQueryClient = {
  from: (table: string) => {
    select: (columns: string) => InboxQueryChain;
  };
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message?: string } | null }>;
};

type InboxQueryChain = {
  eq: (column: string, value: string) => InboxQueryChain;
  in: (column: string, values: readonly string[]) => InboxQueryChain;
  order: (column: string, options?: { ascending?: boolean }) => InboxQueryChain;
  limit: (count: number) => InboxQueryChain;
  maybeSingle: () => Promise<QueryResult>;
  then: PromiseLike<QueryResult>["then"];
};

const PROFILE_COLUMNS = "id, user_id, display_name";
const BINDING_COLUMNS =
  "id, creator_id, pipeline_item_id, updated_at, pipeline_item:pipeline_items(id, creator_id, status, display_ref, hotel_id, hotel:hotels(id, name))";
const READING_COLUMNS =
  "binding_id, creator_id, commercial_state, stale, has_human_reply, has_redirect, has_rejection";
const SUGGESTION_COLUMNS = "id, creator_id, pipeline_item_id, kind, applies_crm, status";
const DATE_COLUMNS =
  "id, creator_id, pipeline_item_id, trip_hotel_id, suggested_check_in, suggested_check_out, source, status, pipeline_item:pipeline_items(hotel:hotels(name)), trip_hotel:trip_hotels(hotel:hotels(name))";
const MAIL_COLUMNS = "user_id, connection_state, email_address";

function asRecords(data: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(data)) return null;
  const rows: Record<string, unknown>[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") return null;
    rows.push(row as Record<string, unknown>);
  }
  return rows;
}

function one(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") return null;
  return row as Record<string, unknown>;
}

async function clientOr(injected?: InboxQueryClient): Promise<InboxQueryClient> {
  if (injected) return injected;
  return (await createClient()) as unknown as InboxQueryClient;
}

function hotelName(value: unknown): string | null {
  const hotel = one(value);
  if (!hotel || typeof hotel.name !== "string") return null;
  const name = hotel.name.trim();
  return name.length > 0 ? name : null;
}

function mapThreads(
  bindings: Record<string, unknown>[],
  readings: Record<string, unknown>[],
  profileId: string,
): { foreign: boolean; threads: InboxThreadRow[] } | null {
  const readingByBinding = new Map<string, Record<string, unknown>>();
  for (const row of readings) {
    if (row.creator_id !== profileId) return { foreign: true, threads: [] };
    if (typeof row.binding_id !== "string" || !isUuid(row.binding_id)) return null;
    readingByBinding.set(row.binding_id, row);
  }
  const threads: InboxThreadRow[] = [];
  for (const row of bindings) {
    if (typeof row.creator_id !== "string" || row.creator_id !== profileId) {
      return { foreign: true, threads: [] };
    }
    const item = one(row.pipeline_item);
    if (!item || item.creator_id !== profileId) return { foreign: true, threads: [] };
    const name = hotelName(item.hotel);
    const hotelId = typeof item.hotel_id === "string" ? item.hotel_id : "";
    const status = typeof item.status === "string" ? item.status : "";
    const displayRef = typeof item.display_ref === "string" ? item.display_ref : null;
    const bindingId = typeof row.id === "string" ? row.id : "";
    const pipelineItemId = typeof row.pipeline_item_id === "string" ? row.pipeline_item_id : "";
    const updatedAt = typeof row.updated_at === "string" ? row.updated_at : "";
    if (!name || !isUuid(hotelId) || !isUuid(bindingId) || !isUuid(pipelineItemId)) return null;
    const reading = readingByBinding.get(bindingId) ?? null;
    let commercialState: MachineThreadState | null = null;
    let stale = false;
    let hasHumanReply = false;
    let hasRedirect = false;
    if (reading) {
      const state = reading.commercial_state;
      if (
        state !== null &&
        (typeof state !== "string" || !(MACHINE_THREAD_STATES as readonly string[]).includes(state))
      ) {
        return null;
      }
      if (typeof reading.stale !== "boolean") return null;
      if (typeof reading.has_human_reply !== "boolean") return null;
      if (typeof reading.has_redirect !== "boolean") return null;
      commercialState = state as MachineThreadState | null;
      stale = reading.stale;
      hasHumanReply = reading.has_human_reply;
      hasRedirect = reading.has_redirect;
    }
    threads.push({
      bindingId,
      creatorId: profileId,
      pipelineItemId,
      hotelId,
      hotelName: name,
      displayRef,
      status,
      updatedAt,
      commercialState,
      readingPresent: reading !== null,
      stale,
      hasHumanReply,
      hasRedirect,
    });
  }
  return { foreign: false, threads };
}

function mapSuggestions(
  rows: Record<string, unknown>[],
  profileId: string,
): InboxSuggestionRow[] | "foreign" | null {
  const suggestions: InboxSuggestionRow[] = [];
  for (const row of rows) {
    if (row.creator_id !== profileId) return "foreign";
    if (row.status !== "pending") continue;
    const kind = row.kind;
    if (typeof row.id !== "string" || typeof row.pipeline_item_id !== "string") return null;
    if (!(INBOX_SUGGESTION_KINDS as readonly string[]).includes(kind as string)) return null;
    if (typeof row.applies_crm !== "boolean") return null;
    suggestions.push({
      id: row.id,
      creatorId: profileId,
      pipelineItemId: row.pipeline_item_id,
      kind: kind as InboxSuggestionKind,
      appliesCrm: row.applies_crm,
    });
  }
  return suggestions;
}

function mapDates(
  rows: Record<string, unknown>[],
  profileId: string,
): InboxDateRow[] | "foreign" | null {
  const dates: InboxDateRow[] = [];
  for (const row of rows) {
    if (row.creator_id !== profileId) return "foreign";
    if (row.status !== "pending" || row.source !== "gmail") return null;
    const pipelineItemId =
      row.pipeline_item_id === null
        ? null
        : typeof row.pipeline_item_id === "string"
          ? row.pipeline_item_id
          : "";
    const tripHotelId =
      row.trip_hotel_id === null
        ? null
        : typeof row.trip_hotel_id === "string"
          ? row.trip_hotel_id
          : "";
    if (pipelineItemId === "" || tripHotelId === "") return null;
    const fromPipeline = hotelName(one(row.pipeline_item)?.hotel);
    const fromTrip = hotelName(one(row.trip_hotel)?.hotel);
    const name = fromPipeline ?? fromTrip;
    if (!name || typeof row.id !== "string") return null;
    if (typeof row.suggested_check_in !== "string" || typeof row.suggested_check_out !== "string")
      return null;
    dates.push({
      id: row.id,
      creatorId: profileId,
      pipelineItemId,
      tripHotelId,
      hotelName: name,
      checkIn: row.suggested_check_in,
      checkOut: row.suggested_check_out,
    });
  }
  return dates;
}

function mailboxFromRows(
  configured: boolean,
  result: QueryResult | null,
  authUserId: string,
): InboxMailbox {
  if (!configured) return { kind: "unconfigured" };
  if (!result || result.error || !Array.isArray(result.data))
    return classifyMailbox({ configured, failed: true, rows: [] });
  const rows: { connectionState: string; email: string | null }[] = [];
  for (const entry of result.data) {
    if (!entry || typeof entry !== "object")
      return classifyMailbox({ configured, failed: true, rows: [] });
    const row = entry as Record<string, unknown>;
    if (typeof row.user_id !== "string" || typeof row.connection_state !== "string") {
      return classifyMailbox({ configured, failed: true, rows: [] });
    }
    if (row.user_id !== authUserId) continue;
    const email = typeof row.email_address === "string" ? row.email_address : null;
    rows.push({ connectionState: row.connection_state, email });
  }
  return classifyMailbox({ configured, failed: false, rows });
}

export async function loadInboxWorkspace(
  authUserId: string,
  search: { filter?: string | null; thread?: string | null },
  injected?: { client?: InboxQueryClient; gmailConfigured?: boolean; now?: Date },
): Promise<InboxScreenModel> {
  if (!isUuid(authUserId)) {
    return { kind: "error", title: INBOX_COPY.errorTitle, body: INBOX_COPY.errorBody };
  }
  const gmailConfigured = injected?.gmailConfigured ?? isGmailOAuthConfigured();
  try {
    const supabase = await clientOr(injected?.client);
    const profileResult = await supabase
      .from("creator_profiles")
      .select(PROFILE_COLUMNS)
      .eq("user_id", authUserId)
      .maybeSingle();
    const profile = resolveOwnProfile(profileResult.data, profileResult.error !== null, authUserId);
    const mailResult = gmailConfigured
      ? await supabase.from("mail_accounts").select(MAIL_COLUMNS).eq("user_id", authUserId)
      : null;
    const mailbox = mailboxFromRows(gmailConfigured, mailResult, authUserId);
    if (profile.status !== "ok") {
      return { kind: "error", title: INBOX_COPY.errorTitle, body: INBOX_COPY.errorBody };
    }

    const bindingResult = await supabase
      .from("pipeline_inbox_bindings")
      .select(BINDING_COLUMNS)
      .eq("creator_id", profile.profileId)
      .order("updated_at", { ascending: false })
      .limit(INBOX_THREAD_CAP + 1);
    if (bindingResult.error) {
      return { kind: "error", title: INBOX_COPY.errorTitle, body: INBOX_COPY.errorBody };
    }
    const bindingRows = asRecords(bindingResult.data);
    if (!bindingRows) {
      return { kind: "error", title: INBOX_COPY.errorTitle, body: INBOX_COPY.errorBody };
    }
    const listedBindings = bindingRows.slice(0, INBOX_THREAD_CAP);
    const bindingIds = [
      ...new Set(
        listedBindings
          .map((row) => row.id)
          .filter((id): id is string => typeof id === "string" && isUuid(id)),
      ),
    ];
    const pipelineIds = [
      ...new Set(
        listedBindings
          .map((row) => row.pipeline_item_id)
          .filter((id): id is string => typeof id === "string" && isUuid(id)),
      ),
    ];

    const [readingResult, suggestionResult, dateResult, gmailResult] = await Promise.all([
      bindingIds.length === 0
        ? Promise.resolve({ data: [], error: null })
        : supabase
            .from("pipeline_inbox_readings")
            .select(READING_COLUMNS)
            .eq("creator_id", profile.profileId)
            .in("binding_id", bindingIds),
      pipelineIds.length === 0
        ? Promise.resolve({ data: [], error: null })
        : supabase
            .from("pipeline_inbox_suggestions")
            .select(SUGGESTION_COLUMNS)
            .eq("creator_id", profile.profileId)
            .eq("status", "pending")
            .in("pipeline_item_id", pipelineIds)
            .order("created_at", { ascending: false })
            .order("id", { ascending: true })
            .limit(INBOX_SUGGESTION_CAP + 1),
      supabase
        .from("stay_date_suggestions")
        .select(DATE_COLUMNS)
        .eq("creator_id", profile.profileId)
        .eq("status", "pending")
        .limit(INBOX_DATE_CAP + 1),
      supabase.rpc(LIST_OWN_GMAIL_SUGGESTIONS_RPC, {
        p_pipeline_item_ids: pipelineIds,
      }),
    ]);

    if (readingResult.error) {
      return { kind: "error", title: INBOX_COPY.errorTitle, body: INBOX_COPY.errorBody };
    }
    const readingRows = asRecords(readingResult.data);
    if (!readingRows) {
      return { kind: "error", title: INBOX_COPY.errorTitle, body: INBOX_COPY.errorBody };
    }
    const mappedThreads = mapThreads(listedBindings, readingRows, profile.profileId);
    if (!mappedThreads || mappedThreads.foreign) {
      return { kind: "error", title: INBOX_COPY.errorTitle, body: INBOX_COPY.errorBody };
    }

    let suggestions: InboxSuggestionRow[] = [];
    let suggestionsFailed = false;
    let suggestionsCapped = false;
    if (suggestionResult.error) suggestionsFailed = true;
    else {
      const rows = asRecords(suggestionResult.data);
      if (!rows) suggestionsFailed = true;
      else {
        suggestionsCapped = rows.length > INBOX_SUGGESTION_CAP;
        const mapped = mapSuggestions(rows.slice(0, INBOX_SUGGESTION_CAP), profile.profileId);
        if (mapped === "foreign" || mapped === null) {
          return { kind: "error", title: INBOX_COPY.errorTitle, body: INBOX_COPY.errorBody };
        }
        suggestions = mapped;
      }
    }

    let dates: InboxDateRow[] = [];
    let datesFailed = false;
    let datesCapped = false;
    if (dateResult.error) datesFailed = true;
    else {
      const rows = asRecords(dateResult.data);
      if (!rows) datesFailed = true;
      else {
        datesCapped = rows.length > INBOX_DATE_CAP;
        const mapped = mapDates(rows.slice(0, INBOX_DATE_CAP), profile.profileId);
        if (mapped === "foreign" || mapped === null) {
          return { kind: "error", title: INBOX_COPY.errorTitle, body: INBOX_COPY.errorBody };
        }
        dates = mapped;
      }
    }

    let collaborations: InboxCollaborationRef[] = [];
    let collaborationStatus: InboxBuildInput["collaborationStatus"] = "error";
    let collaborationsFailed = false;
    let collaborationsTruncated = false;
    if (gmailResult.error) {
      collaborationsFailed = true;
      collaborationStatus = "error";
    } else {
      const parsed = parseOwnGmailSuggestions(gmailResult.data, profile.profileId);
      if (parsed.status === "error") {
        collaborationsFailed = true;
        collaborationStatus = "error";
      } else if (parsed.status === "paused" || parsed.status === "hidden") {
        collaborationStatus = parsed.status;
      } else {
        collaborationStatus = "ok";
        collaborationsTruncated = parsed.truncated;
        collaborations = parsed.suggestions.map((row) => ({
          id: row.id,
          creatorId: row.creatorId,
          pipelineItemId: row.pipelineItemId,
          kind: row.kind,
        }));
      }
    }

    const selected = search.thread && isUuid(search.thread) ? search.thread : null;
    return buildInboxScreen({
      profileId: profile.profileId,
      asOf: (injected?.now ?? new Date()).toISOString(),
      filter: parseInboxFilter(search.filter),
      selectedId: selected,
      mailbox,
      threads: mappedThreads.threads,
      suggestions,
      collaborations,
      collaborationStatus,
      dates,
      threadsCapped: bindingRows.length > INBOX_THREAD_CAP,
      datesCapped,
      suggestionsCapped,
      suggestionsFailed,
      datesFailed,
      collaborationsFailed,
      collaborationsTruncated,
      foreign: false,
    });
  } catch {
    return { kind: "error", title: INBOX_COPY.errorTitle, body: INBOX_COPY.errorBody };
  }
}

export const INBOX_QUERY_COLUMNS = {
  bindings: BINDING_COLUMNS,
  readings: READING_COLUMNS,
  suggestions: SUGGESTION_COLUMNS,
  dates: DATE_COLUMNS,
  mail: MAIL_COLUMNS,
} as const;
