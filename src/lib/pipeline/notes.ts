import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/hotels/ids";

export type NotesResult =
  | { result: "updated" }
  | { result: "preserved" }
  | { result: "not_found_or_forbidden" }
  | { result: "error" }
  | { result: "invalid_input" };

/**
 * An empty save keeps the stored note unless the caller says the creator
 * cleared the field they were shown. Whitespace alone is not a clear.
 */
export function notesWritePlan(
  notes: string,
  explicitClear: boolean,
): { action: "invalid" } | { action: "preserve" } | { action: "write"; notes: string } {
  if (notes.length > 8000) return { action: "invalid" };
  const trimmed = notes.trim();
  if (trimmed.length === 0 && !explicitClear) return { action: "preserve" };
  return { action: "write", notes: trimmed };
}

export async function updatePipelinePrivateNotes(
  userId: string,
  pipelineItemId: string,
  notes: string,
  explicitClear = false,
): Promise<NotesResult> {
  if (!isUuid(userId) || !isUuid(pipelineItemId)) return { result: "invalid_input" };
  const plan = notesWritePlan(notes, explicitClear);
  if (plan.action === "invalid") return { result: "invalid_input" };
  if (plan.action === "preserve") return { result: "preserved" };

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("update_pipeline_private_notes", {
    p_user_id: userId,
    p_pipeline_item_id: pipelineItemId,
    p_notes: plan.notes,
  });

  if (error) return { result: "error" };
  const result = (data as { result?: string } | null)?.result;
  if (result === "updated") return { result: "updated" };
  if (result === "not_found_or_forbidden") return { result: "not_found_or_forbidden" };
  return { result: "error" };
}
