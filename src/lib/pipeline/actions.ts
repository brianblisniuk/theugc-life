"use server";

/**
 * Save-to-Pipeline server action (PRD §7.3, PERMISSIONS.md §5).
 *
 * The browser never calls the privileged RPC. It posts a hotel id; identity is
 * resolved here from the authenticated session, so a forged `creator_id` or
 * `user_id` field is impossible — those inputs are not read at all.
 *
 * The returned value is a typed, sanitized result; no SQL or driver text is
 * ever sent to the client.
 */
import { revalidatePath } from "next/cache";

import { getSessionContext } from "@/lib/auth/guards";

import { saveHotelToPipeline } from "./queries";
import { isSaveSuccessful, type SaveResult } from "./types";

export async function saveHotelAction(formData: FormData): Promise<SaveResult> {
  // Identity comes ONLY from the session cookie.
  const session = await getSessionContext();
  if (!session) return { result: "error" };

  const hotelId = formData.get("hotelId");
  if (typeof hotelId !== "string") return { result: "error" };

  const result = await saveHotelToPipeline(session.userId, hotelId);

  if (isSaveSuccessful(result)) {
    // Reflect the new Saved state immediately on both surfaces.
    revalidatePath(`/app/hotels/${hotelId}`);
    revalidatePath("/app/pipeline");
  }

  return result;
}
