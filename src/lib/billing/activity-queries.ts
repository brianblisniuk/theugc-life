/**
 * The signed-in account's ledger, subscriptions, and purchases.
 * `userId` comes from the server session. RLS still applies. A failed read
 * is not an empty ledger. These rows are not access.
 */
import "server-only";

import { isUuid } from "@/lib/hotels/ids";
import { createClient } from "@/lib/supabase/server";

import {
  commerceActivity,
  ledgerActivity,
  type CommerceActivity,
  type LedgerActivity,
} from "./activity";

const LEDGER_LIMIT = 50;

export async function loadOwnLedger(userId: string): Promise<LedgerActivity> {
  if (!isUuid(userId)) return { kind: "error" };
  try {
    const supabase = await createClient();
    const counted = await supabase
      .from("credit_ledger")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);
    const listed = await supabase
      .from("credit_ledger")
      .select("id, user_id, delta, reason, idempotency_key, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(LEDGER_LIMIT);
    if (
      counted.error ||
      typeof counted.count !== "number" ||
      listed.error ||
      !Array.isArray(listed.data)
    ) {
      return { kind: "error" };
    }
    return ledgerActivity(listed.data, userId, counted.count, LEDGER_LIMIT);
  } catch {
    return { kind: "error" };
  }
}

export async function loadOwnCommerce(userId: string): Promise<CommerceActivity> {
  if (!isUuid(userId)) return { kind: "error" };
  try {
    const supabase = await createClient();
    const subscriptions = await supabase
      .from("subscriptions")
      .select("id, user_id, plan_code, status, price_paid, currency, started_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20);
    const purchases = await supabase
      .from("purchases")
      .select(
        "id, user_id, product_type, product_reference, amount, currency, status, purchased_at, refunded_at, created_at",
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20);
    if (
      subscriptions.error ||
      !Array.isArray(subscriptions.data) ||
      purchases.error ||
      !Array.isArray(purchases.data)
    ) {
      return { kind: "error" };
    }
    return commerceActivity(subscriptions.data, purchases.data, userId);
  } catch {
    return { kind: "error" };
  }
}
