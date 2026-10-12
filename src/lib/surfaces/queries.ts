/**
 * Inbox and collaboration lists for the signed-in creator.
 *
 * Reads stay on the cookie-bound client. A row whose creator id is not the
 * caller's profile is not returned to the page. Compensation columns and
 * message bodies are not selected.
 */
import "server-only";

import { isGmailOAuthConfigured } from "@/lib/gmail/env.server";
import { resolveOwnProfile } from "@/lib/onboarding/activation";
import { loadHomeProgress, type OwnedQueryClient } from "@/lib/onboarding/queries";
import { createClient } from "@/lib/supabase/server";

import {
  COLLABORATION_LIST_COLUMNS,
  INBOX_LIST_COLUMNS,
  LIST_CAP,
  PROFILE_COLUMNS,
  collaborationListState,
  inboxListState,
  type MailboxFact,
  type OwnedListState,
  type CollaborationItem,
  type InboxItem,
} from "./lists";

type QueryResult = {
  data: unknown;
  error: { message?: string } | null;
  count?: number | null;
};

async function clientOr(injected?: OwnedQueryClient): Promise<OwnedQueryClient> {
  if (injected) return injected;
  return (await createClient()) as unknown as OwnedQueryClient;
}

async function readOwnedPage(
  supabase: OwnedQueryClient,
  table: string,
  columns: string,
  profileId: string,
): Promise<{ status: "error" } | { status: "ok"; total: number; rows: unknown[] }> {
  const counted: QueryResult = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("creator_id", profileId);
  if (counted.error || typeof counted.count !== "number") return { status: "error" };
  const listed: QueryResult = await supabase
    .from(table)
    .select(columns)
    .eq("creator_id", profileId)
    .order("created_at", { ascending: false })
    .limit(LIST_CAP);
  if (listed.error || !Array.isArray(listed.data)) return { status: "error" };
  return { status: "ok", total: counted.count, rows: listed.data };
}

export async function loadCollaborationList(
  authUserId: string,
  injected?: OwnedQueryClient,
): Promise<OwnedListState<CollaborationItem>> {
  try {
    const supabase = await clientOr(injected);
    const profileResult = await supabase
      .from("creator_profiles")
      .select(PROFILE_COLUMNS)
      .eq("user_id", authUserId)
      .maybeSingle();
    const profile = resolveOwnProfile(profileResult.data, profileResult.error !== null, authUserId);
    if (profile.status !== "ok") {
      return collaborationListState({
        failed: false,
        identityFailed: true,
        total: 0,
        rawRows: [],
        viewerId: null,
      });
    }
    const page = await readOwnedPage(
      supabase,
      "collaborations",
      COLLABORATION_LIST_COLUMNS,
      profile.profileId,
    );
    if (page.status !== "ok") {
      return collaborationListState({
        failed: true,
        identityFailed: false,
        total: null,
        rawRows: [],
        viewerId: profile.profileId,
      });
    }
    return collaborationListState({
      failed: false,
      identityFailed: false,
      total: page.total,
      rawRows: page.rows,
      viewerId: profile.profileId,
    });
  } catch {
    return collaborationListState({
      failed: true,
      identityFailed: false,
      total: null,
      rawRows: [],
      viewerId: null,
    });
  }
}

export async function loadInboxList(
  authUserId: string,
  injected?: { client?: OwnedQueryClient; gmailConfigured?: boolean },
): Promise<OwnedListState<InboxItem>> {
  const gmailConfigured = injected?.gmailConfigured ?? isGmailOAuthConfigured();
  try {
    const supabase = await clientOr(injected?.client);
    const profileResult = await supabase
      .from("creator_profiles")
      .select(PROFILE_COLUMNS)
      .eq("user_id", authUserId)
      .maybeSingle();
    const profile = resolveOwnProfile(profileResult.data, profileResult.error !== null, authUserId);
    const progress = await loadHomeProgress(authUserId, {
      client: supabase,
      gmailConfigured,
    });
    const mailbox: MailboxFact = !gmailConfigured
      ? "unconfigured"
      : progress.facts.gmail === "error"
        ? "error"
        : progress.facts.gmail === "yes"
          ? "connected"
          : "absent";

    if (profile.status !== "ok") {
      return inboxListState({
        failed: false,
        identityFailed: true,
        total: 0,
        rawRows: [],
        viewerId: null,
        authUserId,
        mailbox,
      });
    }

    const page = await readOwnedPage(
      supabase,
      "pipeline_inbox_bindings",
      INBOX_LIST_COLUMNS,
      profile.profileId,
    );
    if (page.status !== "ok") {
      return inboxListState({
        failed: true,
        identityFailed: false,
        total: null,
        rawRows: [],
        viewerId: profile.profileId,
        authUserId,
        mailbox,
      });
    }
    return inboxListState({
      failed: false,
      identityFailed: false,
      total: page.total,
      rawRows: page.rows,
      viewerId: profile.profileId,
      authUserId,
      mailbox,
    });
  } catch {
    return inboxListState({
      failed: true,
      identityFailed: false,
      total: null,
      rawRows: [],
      viewerId: null,
      authUserId,
      mailbox: gmailConfigured ? "error" : "unconfigured",
    });
  }
}
