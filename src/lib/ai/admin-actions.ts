"use server";

import { revalidatePath } from "next/cache";

import { resolveSession } from "@/lib/auth/guards";
import { bindServerActions } from "@/lib/entitlements/inventory";
import { isUuid } from "@/lib/hotels/ids";
import { createClient } from "@/lib/supabase/server";

bindServerActions(["admin.staff"]);

export type UnpauseResult = { result: "ok" | "forbidden" | "invalid" };

export async function adminUnpauseAction(formData: FormData): Promise<UnpauseResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated" || resolution.session.role !== "admin") {
    return { result: "forbidden" };
  }
  const userId = formData.get("userId");
  const kind = formData.get("kind");
  if (typeof userId !== "string" || !isUuid(userId)) return { result: "invalid" };
  if (kind !== "account" && kind !== "sends") return { result: "invalid" };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc(
    kind === "sends" ? "admin_unpause_sends" : "admin_unpause_account",
    { p_user_id: userId },
  );
  if (error || !data || typeof data !== "object") return { result: "forbidden" };
  if ((data as { result?: unknown }).result !== "ok") return { result: "forbidden" };
  revalidatePath("/admin");
  return { result: "ok" };
}
