"use server";

/**
 * Account deletion request (D151).
 * The session is the caller. This action does not accept another user's id.
 */
import { revalidatePath } from "next/cache";

import { resolveSession } from "@/lib/auth/guards";
import { readRebillEnv } from "@/lib/billing/rebill-catalog";
import { cancelRebillSubscriptions } from "@/lib/billing/rebill-checkout";
import { bindServerActions } from "@/lib/entitlements/inventory";
import { createAdminClient } from "@/lib/supabase/admin";
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

const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]+$/;

function subscriptionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string" && SUBSCRIPTION_ID.test(id));
}

/**
 * Stops future Rebill charges. The deletion clock stays either way.
 * A result other than cancelled leaves the provider id pending. It is not a refund.
 */
async function cancelAtRebill(ids: unknown): Promise<void> {
  const list = subscriptionIds(ids);
  if (list.length === 0) return;
  const results = await cancelRebillSubscriptions({
    env: readRebillEnv(),
    subscriptionIds: list,
    fetchImpl: fetch,
  });
  try {
    const admin = createAdminClient();
    for (let index = 0; index < list.length; index += 1) {
      const subscriptionId = list[index];
      if (!subscriptionId) continue;
      if (results[index] === "cancelled") {
        await admin.rpc("rebill_finish_provider_cancel", {
          p_subscription_id: subscriptionId,
        });
        continue;
      }
      await admin.rpc("rebill_queue_provider_cancel", {
        p_subscription_id: subscriptionId,
        p_reason: results[index] === "not_configured" ? "not_configured" : "provider_error",
      });
    }
  } catch {
    // The clock is already set. Pending rows stay for the erasure job.
  }
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
    await cancelAtRebill(row?.subscription_ids);
    revalidatePath("/app/account");
    return { result, deletionRequestedAt, deleteAfter };
  }
  return { result: "error" };
}
