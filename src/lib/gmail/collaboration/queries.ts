import "server-only";

import { assertCollaborationClassifier } from "@/lib/gmail/collaboration/classifier";
import { isUuid } from "@/lib/hotels/ids";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { parseCollaborationSuggestions, type CollaborationSuggestionLoad } from "./contract";

async function adminRpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc(name, args);
  if (error || data === null || data === undefined) return null;
  return data;
}

export async function getCollaborationSuggestions(
  pipelineItemId: string,
): Promise<CollaborationSuggestionLoad> {
  if (!isUuid(pipelineItemId)) return { status: "hidden" };
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("read_gmail_collaboration_suggestions", {
      p_pipeline_item_id: pipelineItemId,
    });
    if (error) return { status: "error" };
    return parseCollaborationSuggestions(data);
  } catch {
    return { status: "error" };
  }
}

export async function refreshCollaborationByProviderThread(
  userId: string,
  mailAccountId: string,
  providerThreadId: string,
): Promise<{ result: string }> {
  assertCollaborationClassifier();
  if (!isUuid(userId) || !isUuid(mailAccountId) || providerThreadId.trim().length === 0) {
    return { result: "invalid_input" };
  }
  const data = await adminRpc("refresh_gmail_collaboration_by_provider_thread", {
    p_user_id: userId,
    p_mail_account_id: mailAccountId,
    p_provider_thread_id: providerThreadId.trim(),
  });
  const result = (data as { result?: unknown } | null)?.result;
  return { result: typeof result === "string" ? result : "error" };
}

export async function confirmCollaborationSuggestion(
  userId: string,
  pipelineItemId: string,
  suggestionId: string,
  sentiment: string | null,
): Promise<{ result: string; kind: string | null }> {
  if (!isUuid(userId) || !isUuid(pipelineItemId) || !isUuid(suggestionId)) {
    return { result: "invalid_input", kind: null };
  }
  const data = await adminRpc("confirm_gmail_collaboration_suggestion", {
    p_user_id: userId,
    p_pipeline_item_id: pipelineItemId,
    p_suggestion_id: suggestionId,
    p_sentiment: sentiment,
  });
  if (!data || typeof data !== "object") return { result: "error", kind: null };
  const result = (data as { result?: unknown }).result;
  const kind = (data as { kind?: unknown }).kind;
  return {
    result: typeof result === "string" ? result : "error",
    kind: typeof kind === "string" ? kind : null,
  };
}

export async function dismissCollaborationSuggestion(
  userId: string,
  pipelineItemId: string,
  suggestionId: string,
): Promise<{ result: string }> {
  if (!isUuid(userId) || !isUuid(pipelineItemId) || !isUuid(suggestionId)) {
    return { result: "invalid_input" };
  }
  const data = await adminRpc("dismiss_gmail_collaboration_suggestion", {
    p_user_id: userId,
    p_pipeline_item_id: pipelineItemId,
    p_suggestion_id: suggestionId,
  });
  const result = (data as { result?: unknown } | null)?.result;
  return { result: typeof result === "string" ? result : "error" };
}
