"use server";

import { revalidatePath } from "next/cache";

import { resolveSession } from "@/lib/auth/guards";
import { bindServerActions } from "@/lib/entitlements/inventory";
import { isUuid } from "@/lib/hotels/ids";
import { createAdminClient } from "@/lib/supabase/admin";

import { mapDateDecision } from "./model";

bindServerActions(["inbox.own"]);

function suggestionId(formData: FormData): string | null {
  const value = formData.get("suggestionId");
  return typeof value === "string" && isUuid(value) ? value : null;
}

async function decide(
  formData: FormData,
  fn: "accept_stay_date_suggestion" | "reject_stay_date_suggestion",
): Promise<{ result: string }> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const id = suggestionId(formData);
  if (!id) return { result: "invalid_input" };
  const admin = createAdminClient();
  const { data, error } = await admin.rpc(fn, {
    p_user_id: resolution.session.userId,
    p_suggestion_id: id,
  });
  if (error) return { result: "error" };
  const result = mapDateDecision(data);
  if (result === "accepted" || result === "rejected") {
    revalidatePath("/app/inbox");
    revalidatePath("/app");
    revalidatePath("/app/trips");
  }
  return { result };
}

export async function acceptStayDateSuggestionAction(
  formData: FormData,
): Promise<{ result: string }> {
  return decide(formData, "accept_stay_date_suggestion");
}

export async function rejectStayDateSuggestionAction(
  formData: FormData,
): Promise<{ result: string }> {
  return decide(formData, "reject_stay_date_suggestion");
}
