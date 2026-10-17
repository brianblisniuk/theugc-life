"use server";

import { revalidatePath } from "next/cache";

import { resolveSession } from "@/lib/auth/guards";
import { isAdminOrEditor } from "@/lib/auth/roles";
import { bindServerActions } from "@/lib/entitlements/inventory";
import { isUuid } from "@/lib/hotels/ids";
import { createClient } from "@/lib/supabase/server";

bindServerActions(["admin.staff"]);

export type HidePhotoResult = { result: "hidden" | "forbidden" | "missing" };

/**
 * D189 takedown. Admin and editor only. The database function checks the role
 * again and sets status=hidden. A creator's call hides nothing.
 */
export async function hideHotelPhotoAction(formData: FormData): Promise<HidePhotoResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated" || !isAdminOrEditor(resolution.session.role)) {
    return { result: "forbidden" };
  }
  const mediaId = formData.get("mediaId");
  const hotelId = formData.get("hotelId");
  if (typeof mediaId !== "string" || !isUuid(mediaId)) return { result: "missing" };
  if (typeof hotelId !== "string" || !isUuid(hotelId)) return { result: "missing" };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("hide_hotel_media", { p_id: mediaId });
  if (error || data !== true) return { result: "missing" };
  revalidatePath(`/app/hotels/${hotelId}`);
  revalidatePath("/app/discover");
  return { result: "hidden" };
}
