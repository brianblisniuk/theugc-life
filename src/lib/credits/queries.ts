import "server-only";

import { createClient } from "@/lib/supabase/server";

import { CREDITS_CONFIG } from "./config";
import type { PendingContactReport } from "./types";

export type { PendingContactReport };

export type CreditBalanceResult = { status: "ok"; balance: number } | { status: "error" };

/**
 * The signed-in user's balance. A failed read is an error, not zero.
 */
export async function getOwnCreditBalance(): Promise<CreditBalanceResult> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("own_credit_balance");
    if (error || typeof data !== "number" || !Number.isInteger(data)) {
      return { status: "error" };
    }
    return { status: "ok", balance: data };
  } catch {
    return { status: "error" };
  }
}

/** Cache email only when the database says this caller may see it. */
export async function getUnlockedCacheEmail(hotelId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("read_own_unlocked_contact", {
    p_hotel_id: hotelId,
  });
  if (error || !data || typeof data !== "object") return null;
  const email = (data as { email?: unknown }).email;
  return typeof email === "string" && email.length > 0 ? email : null;
}

export function configuredUnlockCost(): number {
  return CREDITS_CONFIG.unlockCost;
}

export async function listPendingContactReports(): Promise<
  { status: "ok"; reports: PendingContactReport[] } | { status: "error" }
> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("contact_reports")
      .select("id, user_id, hotel_id, reason")
      .eq("status", "pending");
    if (error) return { status: "error" };
    const reports = (data ?? []).map((row) => {
      const record = row as { id: string; user_id: string; hotel_id: string; reason: string };
      return {
        id: record.id,
        userId: record.user_id,
        hotelId: record.hotel_id,
        reason: record.reason,
      };
    });
    return { status: "ok", reports };
  } catch {
    return { status: "error" };
  }
}
