/**
 * Owner read of deliverable deadlines (D115).
 *
 * The cookie-bound client calls `list_own_deliverable_deadlines`, which takes
 * no user id. A failed read is an error board, not an empty reminder list.
 */
import "server-only";

import { isUuid } from "@/lib/hotels/ids";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

import {
  DEADLINE_READ_LIMIT,
  buildDeadlineBoard,
  errorDeadlineBoard,
  parseDeadlinePayload,
  type DeadlineBoard,
} from "./deadlines";

export async function loadDeliverableDeadlineBoard(
  authUserId: string,
  asOf: string,
): Promise<DeadlineBoard> {
  if (!isUuid(authUserId)) return errorDeadlineBoard();
  try {
    const supabase = await createClient();
    const profileResult = await supabase
      .from("creator_profiles")
      .select("id, user_id")
      .eq("user_id", authUserId)
      .maybeSingle();
    if (profileResult.error || !profileResult.data) return errorDeadlineBoard();
    const profile = profileResult.data as { id?: unknown; user_id?: unknown };
    if (profile.user_id !== authUserId || typeof profile.id !== "string" || !isUuid(profile.id)) {
      return errorDeadlineBoard();
    }
    const { data, error } = await supabase.rpc("list_own_deliverable_deadlines", {
      p_limit: DEADLINE_READ_LIMIT,
    });
    if (error) {
      logger.warn("deliverable_deadlines", { result: "rpc_error" });
      return errorDeadlineBoard();
    }
    const source = parseDeadlinePayload(data, profile.id);
    if (source.status === "error") {
      const result =
        data && typeof data === "object" && "result" in data
          ? String((data as { result?: unknown }).result ?? "unreadable")
          : "unreadable";
      logger.warn("deliverable_deadlines", { result });
    }
    return buildDeadlineBoard({ asOf, profileId: profile.id, source });
  } catch {
    logger.warn("deliverable_deadlines", { result: "thrown" });
    return errorDeadlineBoard();
  }
}
