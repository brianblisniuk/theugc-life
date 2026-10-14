import "server-only";

import { createClient } from "@/lib/supabase/server";

import { CREDITS_CONFIG } from "./config";
import type { PendingContactReport } from "./types";

export type { PendingContactReport };

export type CreditBalanceResult = { status: "ok"; balance: number } | { status: "error" };

/**
 * The signed-in user's balance. A failed read is an error, not zero.
 */
/** Refreshes this session's grants. A failure is not a zero balance. */
export async function refreshOwnGrants(): Promise<void> {
  try {
    const supabase = await createClient();
    await supabase.rpc("ensure_own_credit_grants");
  } catch {
    // The following balance read still distinguishes an error from zero.
  }
}

export async function getOwnCreditBalance(): Promise<CreditBalanceResult> {
  try {
    const supabase = await createClient();
    await supabase.rpc("ensure_own_credit_grants");
    const { data, error } = await supabase.rpc("own_credit_balance");
    if (error || typeof data !== "number" || !Number.isInteger(data)) {
      return { status: "error" };
    }
    return { status: "ok", balance: data };
  } catch {
    return { status: "error" };
  }
}

/**
 * Cache emails for pipeline cards. The database drops hotels this caller has
 * not unlocked. A failed read is an empty map, not another creator's address.
 */
export async function readUnlockedContactEmails(
  hotelIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(hotelIds.filter((id) => id.length > 0))];
  if (ids.length === 0) return new Map();
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("read_own_unlocked_contacts", {
      p_hotel_ids: ids,
    });
    if (error || !Array.isArray(data)) return new Map();
    const emails = new Map<string, string>();
    for (const row of data) {
      if (!row || typeof row !== "object") continue;
      const hotelId = (row as { hotel_id?: unknown }).hotel_id;
      const email = (row as { email?: unknown }).email;
      if (typeof hotelId === "string" && typeof email === "string" && email.length > 0) {
        emails.set(hotelId, email);
      }
    }
    return emails;
  } catch {
    return new Map();
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
