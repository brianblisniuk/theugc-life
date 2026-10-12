import "server-only";

import { isUuid } from "@/lib/hotels/ids";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import {
  mapInboxWrite,
  parseInboxUnity,
  type InboxLoad,
  type InboxWriteResult,
  type MailboxLoad,
} from "./contract";

async function callRpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc(name, args);
  if (error || data === null || data === undefined) return null;
  return data;
}

/**
 * Inbox link for one pipeline cycle. The cookie-bound client runs the read,
 * so RLS hides another creator's row. A missing id and a foreign id are both
 * not_found.
 */
export async function getInboxUnity(pipelineItemId: string): Promise<InboxLoad> {
  if (!isUuid(pipelineItemId)) return { status: "not_found" };
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("read_pipeline_inbox_unity", {
      p_pipeline_item_id: pipelineItemId,
    });
    if (error) return { status: "error" };
    if (!data || typeof data !== "object") return { status: "error" };
    const result = (data as { result?: string }).result;
    if (result === "not_found") return { status: "not_found" };
    if (result !== "ok") return { status: "error" };
    const unity = parseInboxUnity(data);
    if (!unity) return { status: "error" };
    return { status: "ok", unity };
  } catch {
    return { status: "error" };
  }
}

export async function listConnectedMailboxes(): Promise<MailboxLoad> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("mail_accounts")
      .select("id, email_address")
      .eq("connection_state", "connected");
    if (error) return { status: "error" };
    const mailboxes = (data ?? []).map((row: { id: string; email_address: string | null }) => ({
      id: row.id,
      emailAddress: row.email_address,
    }));
    return { status: "ok", mailboxes };
  } catch {
    return { status: "error" };
  }
}

export async function bindInboxThread(
  userId: string,
  pipelineItemId: string,
  mailAccountId: string,
  providerThreadId: string,
): Promise<InboxWriteResult> {
  if (!isUuid(userId) || !isUuid(pipelineItemId) || !isUuid(mailAccountId)) {
    return { result: "invalid_input" };
  }
  const data = await callRpc("bind_pipeline_inbox_thread", {
    p_user_id: userId,
    p_pipeline_item_id: pipelineItemId,
    p_mail_account_id: mailAccountId,
    p_provider_thread_id: providerThreadId,
  });
  return mapInboxWrite(data);
}

export async function unbindInboxThread(
  userId: string,
  pipelineItemId: string,
): Promise<InboxWriteResult> {
  if (!isUuid(userId) || !isUuid(pipelineItemId)) return { result: "invalid_input" };
  const data = await callRpc("unbind_pipeline_inbox_thread", {
    p_user_id: userId,
    p_pipeline_item_id: pipelineItemId,
  });
  return mapInboxWrite(data);
}

export async function dismissInboxSuggestion(
  userId: string,
  pipelineItemId: string,
  suggestionId: string,
): Promise<InboxWriteResult> {
  if (!isUuid(userId) || !isUuid(pipelineItemId) || !isUuid(suggestionId)) {
    return { result: "invalid_input" };
  }
  const data = await callRpc("dismiss_pipeline_inbox_suggestion", {
    p_user_id: userId,
    p_pipeline_item_id: pipelineItemId,
    p_suggestion_id: suggestionId,
  });
  return mapInboxWrite(data);
}

export async function acceptInboxSuggestion(
  userId: string,
  pipelineItemId: string,
  suggestionId: string,
  sentiment: string | null,
  eventAt: string | null,
): Promise<InboxWriteResult> {
  if (!isUuid(userId) || !isUuid(pipelineItemId) || !isUuid(suggestionId)) {
    return { result: "invalid_input" };
  }
  const data = await callRpc("accept_pipeline_inbox_suggestion", {
    p_user_id: userId,
    p_pipeline_item_id: pipelineItemId,
    p_suggestion_id: suggestionId,
    p_sentiment: sentiment,
    p_event_at: eventAt,
  });
  return mapInboxWrite(data);
}
