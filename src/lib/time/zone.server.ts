import "server-only";

import { isUuid } from "@/lib/hotels/ids";
import { createClient } from "@/lib/supabase/server";

import { civilDate } from "./civil-date";

/**
 * The signed-in user's stored zone. A blank or invalid name is UTC, the same
 * fallback the database uses for calendar math.
 */
export async function readOwnTimeZone(userId: string): Promise<string> {
  if (!isUuid(userId)) return "UTC";
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("users")
      .select("timezone")
      .eq("id", userId)
      .maybeSingle();
    if (error || !data) return "UTC";
    const zone = (data as { timezone?: unknown }).timezone;
    if (typeof zone !== "string" || zone.trim().length === 0) return "UTC";
    return civilDate(new Date(), zone) ? zone.trim() : "UTC";
  } catch {
    return "UTC";
  }
}
