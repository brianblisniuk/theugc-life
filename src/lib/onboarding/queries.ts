/**
 * Home activation reads. The cookie-bound client is the boundary: RLS already
 * hides another creator's rows. The probes below still drop a row whose owner
 * id is not the session's, so a mixed payload cannot complete someone else's step.
 */
import "server-only";

import { createClient } from "@/lib/supabase/server";
import { isGmailOAuthConfigured } from "@/lib/gmail/env.server";

import { gmailProbe, ownedExistence, resolveOwnProfile, type ActivationFacts } from "./activation";
import { GMAIL_PROBE_COLUMNS, PROFILE_COLUMNS } from "@/lib/surfaces/lists";

type QueryResult = {
  data: unknown;
  error: { message?: string } | null;
  count?: number | null;
};

export type OwnedQueryClient = {
  from: (table: string) => {
    select: (columns: string, options?: { count?: "exact"; head?: boolean }) => QueryChain;
  };
};

type QueryChain = {
  eq: (column: string, value: string) => QueryChain;
  not: (column: string, operator: string, value: null) => QueryChain;
  order: (column: string, options: { ascending: boolean }) => QueryChain;
  limit: (count: number) => QueryChain;
  maybeSingle: () => Promise<QueryResult>;
  then: PromiseLike<QueryResult>["then"];
};

export type HomeProgress = {
  displayName: string | null;
  facts: ActivationFacts;
};

function asRecords(data: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(data)) return null;
  const rows: Record<string, unknown>[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") return null;
    rows.push(row as Record<string, unknown>);
  }
  return rows;
}

function mapGmail(
  result: QueryResult | null,
  configured: boolean,
  authUserId: string,
): ActivationFacts["gmail"] {
  if (!configured || result === null) return gmailProbe([], false, authUserId);
  const rows = asRecords(result.data);
  if (result.error !== null || rows === null) return gmailProbe(null, true, authUserId);
  const mapped = [];
  for (const row of rows) {
    if (typeof row.user_id !== "string" || typeof row.connection_state !== "string") {
      return gmailProbe(null, true, authUserId);
    }
    mapped.push({ userId: row.user_id, connectionState: row.connection_state });
  }
  return gmailProbe(mapped, false, authUserId);
}

function mapOwners(result: QueryResult, profileId: string): ActivationFacts["trip"] {
  const rows = asRecords(result.data);
  if (result.error !== null || rows === null) return ownedExistence(null, true, profileId);
  const mapped = [];
  for (const row of rows) {
    if (typeof row.creator_id !== "string") return ownedExistence(null, true, profileId);
    mapped.push({ creatorId: row.creator_id });
  }
  return ownedExistence(mapped, false, profileId);
}

async function clientOr(injected?: OwnedQueryClient): Promise<OwnedQueryClient> {
  if (injected) return injected;
  return (await createClient()) as unknown as OwnedQueryClient;
}

export async function loadHomeProgress(
  authUserId: string,
  injected?: { client?: OwnedQueryClient; gmailConfigured?: boolean },
): Promise<HomeProgress> {
  const gmailConfigured = injected?.gmailConfigured ?? isGmailOAuthConfigured();
  try {
    const supabase = await clientOr(injected?.client);
    const profileQuery = supabase
      .from("creator_profiles")
      .select(PROFILE_COLUMNS)
      .eq("user_id", authUserId)
      .maybeSingle();
    const gmailQuery = gmailConfigured
      ? supabase.from("mail_accounts").select(GMAIL_PROBE_COLUMNS).eq("user_id", authUserId)
      : Promise.resolve(null);

    const [profileResult, gmailResult] = await Promise.all([profileQuery, gmailQuery]);
    const profile = resolveOwnProfile(profileResult.data, profileResult.error !== null, authUserId);

    const gmail = mapGmail(gmailResult, gmailConfigured, authUserId);

    if (profile.status !== "ok") {
      return {
        displayName: null,
        facts: { gmailConfigured, gmail, trip: "error", saved: "error", followUp: "error" },
      };
    }

    const [trips, saved, followUps] = await Promise.all([
      supabase.from("trips").select("id, creator_id").eq("creator_id", profile.profileId).limit(1),
      supabase
        .from("pipeline_items")
        .select("id, creator_id")
        .eq("creator_id", profile.profileId)
        .limit(1),
      supabase
        .from("pipeline_items")
        .select("id, creator_id, next_followup_at")
        .eq("creator_id", profile.profileId)
        .not("next_followup_at", "is", null)
        .limit(1),
    ]);

    return {
      displayName: profile.displayName,
      facts: {
        gmailConfigured,
        gmail,
        trip: mapOwners(trips, profile.profileId),
        saved: mapOwners(saved, profile.profileId),
        followUp: mapOwners(followUps, profile.profileId),
      },
    };
  } catch {
    return {
      displayName: null,
      facts: {
        gmailConfigured,
        gmail: gmailConfigured ? "error" : "no",
        trip: "error",
        saved: "error",
        followUp: "error",
      },
    };
  }
}
