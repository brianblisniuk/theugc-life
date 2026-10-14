"use server";

/**
 * Account deletion request (D151).
 * The session is the caller. This action does not accept another user's id.
 */
import { revalidatePath } from "next/cache";

import { resolveSession } from "@/lib/auth/guards";
import { bindServerActions } from "@/lib/entitlements/inventory";
import { createClient } from "@/lib/supabase/server";

bindServerActions(["account.settings"]);

export type AccountDeletionActionResult =
  | {
      result: "scheduled" | "already_scheduled";
      deletionRequestedAt: string;
      deleteAfter: string;
    }
  | { result: "confirmation_required" | "not_creator" | "not_found" | "error" };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export async function requestAccountDeletion(
  formData: FormData,
): Promise<AccountDeletionActionResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  if (resolution.session.role !== "creator") return { result: "not_creator" };

  const confirmation = formData.get("confirmation");
  const phrase = typeof confirmation === "string" ? confirmation : "";

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("request_own_account_deletion", {
    p_confirmation: phrase,
  });
  if (error) return { result: "error" };

  const row = asRecord(data);
  const result = typeof row?.result === "string" ? row.result : "";
  if (result === "confirmation_required" || result === "not_creator" || result === "not_found") {
    return { result };
  }
  if (result === "scheduled" || result === "already_scheduled") {
    const deletionRequestedAt = row?.deletion_requested_at;
    const deleteAfter = row?.delete_after;
    if (typeof deletionRequestedAt !== "string" || typeof deleteAfter !== "string") {
      return { result: "error" };
    }
    revalidatePath("/app/account");
    return { result, deletionRequestedAt, deleteAfter };
  }
  return { result: "error" };
}
