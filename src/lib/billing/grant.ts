import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/hotels/ids";
import { PRICING } from "@/lib/config";

export type GrantResult =
  | { result: "granted"; entitlementId: string }
  | { result: "already_granted"; entitlementId: string }
  | { result: "source_reference_conflict" }
  | { result: "error" }
  | { result: "invalid_input" };

type RpcRow = { result?: string; entitlement_id?: string } | null;

/** Maps the RPC's jsonb result to a typed result. Never forwards another row's id
 *  on conflict (the RPC does not return one either). */
export function mapGrantRpcResult(row: RpcRow): GrantResult {
  if (row?.result === "granted" && row.entitlement_id) {
    return { result: "granted", entitlementId: row.entitlement_id };
  }
  if (row?.result === "already_granted" && row.entitlement_id) {
    return { result: "already_granted", entitlementId: row.entitlement_id };
  }
  if (row?.result === "source_reference_conflict") return { result: "source_reference_conflict" };
  if (
    row?.result === "invalid_input" ||
    row?.result === "source_required" ||
    row?.result === "invalid_access_type" ||
    row?.result === "destination_required" ||
    row?.result === "pro_cannot_have_destination"
  ) {
    return { result: "invalid_input" };
  }
  return { result: "error" };
}

export async function grantDestinationPass(
  userId: string,
  destinationId: string,
  sourceReference: string,
): Promise<GrantResult> {
  if (!isUuid(userId) || !isUuid(destinationId) || !sourceReference)
    return { result: "invalid_input" };

  const starts = new Date();
  const expires = new Date(
    starts.getTime() + PRICING.destinationPass.durationDays * 24 * 60 * 60 * 1000,
  );

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("grant_access_entitlement", {
    p_user_id: userId,
    p_access_type: "destination",
    p_destination_id: destinationId,
    p_source: "manual_or_webhook",
    p_source_reference: sourceReference,
    p_starts_at: starts.toISOString(),
    p_expires_at: expires.toISOString(),
  });

  if (error) return { result: "error" };
  return mapGrantRpcResult(data as RpcRow);
}

export async function grantPro(userId: string, sourceReference: string): Promise<GrantResult> {
  if (!isUuid(userId) || !sourceReference) return { result: "invalid_input" };

  const starts = new Date();
  const expires = new Date(starts.getTime() + PRICING.pro.durationDays * 24 * 60 * 60 * 1000);

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("grant_access_entitlement", {
    p_user_id: userId,
    p_access_type: "pro",
    p_destination_id: null,
    p_source: "manual_or_webhook",
    p_source_reference: sourceReference,
    p_starts_at: starts.toISOString(),
    p_expires_at: expires.toISOString(),
  });

  if (error) return { result: "error" };
  return mapGrantRpcResult(data as RpcRow);
}
