/**
 * Extra Home reads (V2-S4): night coverage, outreach, and mailbox state.
 *
 * Cookie-bound reads only. A foreign creator id is an error and is not rendered.
 * This module does not write and does not call Gmail or a model.
 */
import "server-only";

import { isGmailOAuthConfigured } from "@/lib/gmail/env.server";
import { parseOwnGmailSuggestions } from "@/lib/home/next-actions";
import { LIST_OWN_GMAIL_SUGGESTIONS_RPC } from "@/lib/home/queries";
import { isUuid } from "@/lib/hotels/ids";
import { classifyMailbox, type InboxMailbox } from "@/lib/inbox/model";
import { resolveOwnProfile } from "@/lib/onboarding/first-run";
import { createClient } from "@/lib/supabase/server";

import {
  CONTACTED_STATUSES,
  OUTREACH_LIST_CAP,
  outreachFromCounts,
  parseNightCoverage,
  type NightCoverageLoad,
  type OutreachCount,
  type OutreachInitiativeRow,
  type OutreachLoad,
} from "./dashboard";

type QueryResult = { data: unknown; error: { message?: string } | null };

export type HomeSignalClient = {
  from: (table: string) => {
    select: (columns: string) => HomeSignalChain;
  };
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message?: string } | null }>;
};

type HomeSignalChain = {
  eq: (column: string, value: string) => HomeSignalChain;
  order: (column: string, options?: { ascending?: boolean }) => HomeSignalChain;
  limit: (count: number) => HomeSignalChain;
  maybeSingle: () => Promise<QueryResult>;
  then: PromiseLike<QueryResult>["then"];
};

const PROFILE_COLUMNS = "id, user_id, display_name";
const MAIL_COLUMNS = "user_id, connection_state, email_address";
const INITIATIVE_COLUMNS = "id, creator_id, name";
const HOTEL_COUNT_COLUMNS = "id";
const HOTEL_CONTACTED_COLUMNS = "id, pipeline_item:pipeline_items!inner(status)";

export type HomeGmailSignal =
  | { status: "ok"; count: number; truncated: boolean }
  | { status: "paused" }
  | { status: "hidden" }
  | { status: "error" };

export interface HomeSignals {
  mailbox: InboxMailbox;
  coverage: NightCoverageLoad;
  outreach: OutreachLoad;
  gmail: HomeGmailSignal;
}

function asRecords(data: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(data)) return null;
  const rows: Record<string, unknown>[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") return null;
    rows.push(row as Record<string, unknown>);
  }
  return rows;
}

type CountChain = {
  eq: (column: string, value: string) => CountChain;
  in: (column: string, values: readonly string[]) => CountChain;
  then: PromiseLike<{ count: number | null; error: { message?: string } | null }>["then"];
};

async function exactCount(
  supabase: HomeSignalClient,
  table: string,
  columns: string,
  apply: (query: CountChain) => CountChain,
): Promise<number | "error"> {
  const client = supabase as unknown as {
    from: (name: string) => {
      select: (cols: string, options: { count: "exact"; head: true }) => CountChain;
    };
  };
  const result = await apply(client.from(table).select(columns, { count: "exact", head: true }));
  if (
    result.error ||
    typeof result.count !== "number" ||
    !Number.isInteger(result.count) ||
    result.count < 0
  ) {
    return "error";
  }
  return result.count;
}

async function clientOr(injected?: HomeSignalClient): Promise<HomeSignalClient> {
  if (injected) return injected;
  return (await createClient()) as unknown as HomeSignalClient;
}

function mailboxOf(
  configured: boolean,
  result: QueryResult | null,
  authUserId: string,
): InboxMailbox {
  if (!configured) return { kind: "unconfigured" };
  if (!result || result.error || !Array.isArray(result.data)) {
    return classifyMailbox({ configured: true, failed: true, rows: [] });
  }
  const rows: { connectionState: string; email: string | null }[] = [];
  for (const entry of result.data) {
    if (!entry || typeof entry !== "object") {
      return classifyMailbox({ configured: true, failed: true, rows: [] });
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.user_id !== "string" || typeof row.connection_state !== "string") {
      return classifyMailbox({ configured: true, failed: true, rows: [] });
    }
    if (row.user_id !== authUserId) continue;
    rows.push({
      connectionState: row.connection_state,
      email: typeof row.email_address === "string" ? row.email_address : null,
    });
  }
  return classifyMailbox({ configured: true, failed: false, rows });
}

export async function loadHomeSignals(
  authUserId: string,
  tripId: string | null,
  injected?: { client?: HomeSignalClient; gmailConfigured?: boolean },
): Promise<HomeSignals> {
  const failed: HomeSignals = {
    mailbox: { kind: "error" },
    coverage: { status: "error" },
    outreach: { status: "error" },
    gmail: { status: "error" },
  };
  if (!isUuid(authUserId)) return failed;
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
    const mailbox = mailboxOf(gmailConfigured, mailResult, authUserId);
    if (profile.status !== "ok") {
      return {
        mailbox,
        coverage: { status: "error" },
        outreach: { status: "error" },
        gmail: { status: "error" },
      };
    }

    const coveragePromise: Promise<NightCoverageLoad> =
      tripId && isUuid(tripId)
        ? supabase.rpc("trip_night_coverage", { p_trip_id: tripId }).then((result) => {
            if (result.error) return { status: "error" as const };
            return parseNightCoverage(result.data);
          })
        : Promise.resolve({ status: "none" as const });

    const [coverage, initiativeTotal, initiativeResult, gmailResult] = await Promise.all([
      coveragePromise,
      exactCount(supabase, "outreach_initiatives", "id", (query) =>
        query.eq("creator_id", profile.profileId),
      ),
      supabase
        .from("outreach_initiatives")
        .select(INITIATIVE_COLUMNS)
        .eq("creator_id", profile.profileId)
        .order("created_at", { ascending: false })
        .limit(OUTREACH_LIST_CAP),
      supabase.rpc(LIST_OWN_GMAIL_SUGGESTIONS_RPC),
    ]);

    let gmail: HomeGmailSignal = { status: "error" };
    if (!gmailResult.error) {
      const parsed = parseOwnGmailSuggestions(gmailResult.data, profile.profileId);
      if (parsed.status === "ok") {
        gmail = { status: "ok", count: parsed.suggestions.length, truncated: parsed.truncated };
      } else if (
        parsed.status === "paused" ||
        parsed.status === "hidden" ||
        parsed.status === "error"
      ) {
        gmail = { status: parsed.status };
      }
    }

    if (initiativeTotal === "error" || initiativeResult.error) {
      return { mailbox, coverage, outreach: { status: "error" }, gmail };
    }
    const initiativeRows = asRecords(initiativeResult.data);
    if (!initiativeRows || initiativeRows.length > initiativeTotal) {
      return { mailbox, coverage, outreach: { status: "error" }, gmail };
    }
    const initiatives: OutreachInitiativeRow[] = [];
    for (const row of initiativeRows) {
      if (
        typeof row.id !== "string" ||
        typeof row.creator_id !== "string" ||
        typeof row.name !== "string"
      ) {
        return { mailbox, coverage, outreach: { status: "error" }, gmail };
      }
      initiatives.push({ id: row.id, creatorId: row.creator_id, name: row.name });
    }
    const totals: OutreachCount[] = [];
    for (const initiative of initiatives) {
      const [hotelCount, contactedCount, replyCount] = await Promise.all([
        exactCount(supabase, "outreach_initiative_hotels", HOTEL_COUNT_COLUMNS, (query) =>
          query.eq("creator_id", profile.profileId).eq("initiative_id", initiative.id),
        ),
        exactCount(supabase, "outreach_initiative_hotels", HOTEL_CONTACTED_COLUMNS, (query) =>
          query
            .eq("creator_id", profile.profileId)
            .eq("initiative_id", initiative.id)
            .in("pipeline_item.status", CONTACTED_STATUSES),
        ),
        exactCount(supabase, "outreach_initiative_hotels", HOTEL_CONTACTED_COLUMNS, (query) =>
          query
            .eq("creator_id", profile.profileId)
            .eq("initiative_id", initiative.id)
            .eq("pipeline_item.status", "replied"),
        ),
      ]);
      if (hotelCount === "error" || contactedCount === "error" || replyCount === "error") {
        return { mailbox, coverage, outreach: { status: "error" }, gmail };
      }
      totals.push({ initiativeId: initiative.id, hotelCount, contactedCount, replyCount });
    }
    const outreach = outreachFromCounts(profile.profileId, initiatives, totals, initiativeTotal);
    if (outreach === "foreign") {
      return {
        mailbox,
        coverage: { status: "error" },
        outreach: { status: "error" },
        gmail: { status: "error" },
      };
    }
    return { mailbox, coverage, outreach, gmail };
  } catch {
    return failed;
  }
}

export const HOME_SIGNAL_COLUMNS = {
  mail: MAIL_COLUMNS,
  initiatives: INITIATIVE_COLUMNS,
  hotels: HOTEL_COUNT_COLUMNS,
  contacted: HOTEL_CONTACTED_COLUMNS,
} as const;
