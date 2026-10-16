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
  outreachCards,
  parseNightCoverage,
  type NightCoverageLoad,
  type OutreachHotelRow,
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
const HOTEL_COLUMNS = "creator_id, initiative_id, hotel_id, pipeline_item:pipeline_items(status)";

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

function one(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") return null;
  return row as Record<string, unknown>;
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

    const [coverage, initiativeResult, hotelResult, gmailResult] = await Promise.all([
      coveragePromise,
      supabase
        .from("outreach_initiatives")
        .select(INITIATIVE_COLUMNS)
        .eq("creator_id", profile.profileId)
        .order("created_at", { ascending: false })
        .limit(8),
      supabase
        .from("outreach_initiative_hotels")
        .select(HOTEL_COLUMNS)
        .eq("creator_id", profile.profileId)
        .limit(200),
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

    if (initiativeResult.error || hotelResult.error) {
      return { mailbox, coverage, outreach: { status: "error" }, gmail };
    }
    const initiativeRows = asRecords(initiativeResult.data);
    const hotelRows = asRecords(hotelResult.data);
    if (!initiativeRows || !hotelRows) {
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
    const hotels: OutreachHotelRow[] = [];
    for (const row of hotelRows) {
      if (
        typeof row.creator_id !== "string" ||
        typeof row.initiative_id !== "string" ||
        typeof row.hotel_id !== "string"
      ) {
        return { mailbox, coverage, outreach: { status: "error" }, gmail };
      }
      const pipeline = one(row.pipeline_item);
      const status = pipeline && typeof pipeline.status === "string" ? pipeline.status : null;
      hotels.push({
        creatorId: row.creator_id,
        initiativeId: row.initiative_id,
        hotelId: row.hotel_id,
        pipelineStatus: status,
      });
    }
    const outreach = outreachCards(profile.profileId, initiatives, hotels);
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
  hotels: HOTEL_COLUMNS,
} as const;
