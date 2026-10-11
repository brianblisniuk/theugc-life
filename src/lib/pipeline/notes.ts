import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/hotels/ids";

export type NotesResult = { result: "updated" } | { result: "not_found_or_forbidden" } | { result: "error" } | { result: "invalid_input" };

export async function updatePipelinePrivateNotes(
  userId: string,
  pipelineItemId: string,
  notes: string,
): Promise<NotesResult> {
  if (!isUuid(userId) || !isUuid(pipelineItemId)) return { result: "invalid_input" };
  if (notes.length > 8000) return { result: "invalid_input" };

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("update_pipeline_private_notes", {
    p_user_id: userId,
    p_pipeline_item_id: pipelineItemId,
    p_notes: notes,
  });

  if (error) return { result: "error" };
  const result = (data as { result?: string } | null)?.result;
  if (result === "updated") return { result: "updated" };
  if (result === "not_found_or_forbidden") return { result: "not_found_or_forbidden" };
  return { result: "error" };
}
