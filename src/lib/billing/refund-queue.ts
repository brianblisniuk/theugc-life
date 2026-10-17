import "server-only";

import { createClient } from "@/lib/supabase/server";

export interface RefundQueueRow {
  paymentId: string;
  subscriptionId: string | null;
  paymentLinkId: string | null;
  amount: string;
  currency: string;
  createdAt: string;
}

function amountText(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

/**
 * Admin refund alerts. A failed read is not an empty queue.
 * The rows carry amount and provider ids. They do not carry a user id.
 */
export async function listAdminRefundQueue(): Promise<
  { status: "ok"; rows: RefundQueueRow[] } | { status: "error" }
> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("read_admin_rebill_refund_queue", { p_limit: 50 });
    if (error || !Array.isArray(data)) return { status: "error" };
    const rows: RefundQueueRow[] = [];
    for (const row of data) {
      if (!row || typeof row !== "object") continue;
      const record = row as {
        payment_id?: unknown;
        subscription_id?: unknown;
        payment_link_id?: unknown;
        amount?: unknown;
        currency?: unknown;
        status?: unknown;
        created_at?: unknown;
      };
      const amount = amountText(record.amount);
      if (record.status !== "refund_required") continue;
      if (typeof record.payment_id !== "string" || !amount) continue;
      if (typeof record.currency !== "string" || typeof record.created_at !== "string") continue;
      rows.push({
        paymentId: record.payment_id,
        subscriptionId: typeof record.subscription_id === "string" ? record.subscription_id : null,
        paymentLinkId: typeof record.payment_link_id === "string" ? record.payment_link_id : null,
        amount,
        currency: record.currency,
        createdAt: record.created_at,
      });
    }
    return { status: "ok", rows };
  } catch {
    return { status: "error" };
  }
}
