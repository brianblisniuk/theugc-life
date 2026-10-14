/**
 * The signed-in creator's deletion clock (D151, D152).
 * The read takes no user id. A failed read is not "no request".
 */
import "server-only";

import { createClient } from "@/lib/supabase/server";

export type OwnAccountDeletion =
  | { status: "none" }
  | { status: "scheduled"; deletionRequestedAt: string; deleteAfter: string }
  | { status: "error" };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTime(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function getOwnAccountDeletion(): Promise<OwnAccountDeletion> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("read_own_account_deletion");
    if (error) return { status: "error" };
    const row = asRecord(data);
    if (!row) return { status: "error" };
    if (row.result === "none") return { status: "none" };
    if (row.result !== "scheduled") return { status: "error" };
    const deletionRequestedAt = asTime(row.deletion_requested_at);
    const deleteAfter = asTime(row.delete_after);
    if (!deletionRequestedAt || !deleteAfter) return { status: "error" };
    return { status: "scheduled", deletionRequestedAt, deleteAfter };
  } catch {
    return { status: "error" };
  }
}
