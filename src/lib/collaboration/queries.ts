import "server-only";

import { isUuid } from "@/lib/hotels/ids";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import {
  parseWorkspacePayload,
  type CollaborationWorkspace,
  type CompensationInput,
  type DeliverableInput,
} from "./contract";

export type WorkspaceLoad =
  | { status: "ok"; workspace: CollaborationWorkspace }
  | { status: "not_found" }
  | { status: "error" };

type RpcResult = { result?: string; deliverable_id?: string };

async function callRpc(name: string, args: Record<string, unknown>): Promise<RpcResult | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc(name, args);
  if (error || !data || typeof data !== "object") return null;
  return data as RpcResult;
}

/**
 * Derived deliverable values for one collaboration. Runs as the signed-in
 * creator, so RLS is the row boundary. A payload that calls unknown zero, or
 * that does not add up, is a load error.
 */
export async function getCollaborationWorkspace(pipelineItemId: string): Promise<WorkspaceLoad> {
  if (!isUuid(pipelineItemId)) return { status: "not_found" };
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("collaboration_deliverable_values", {
      p_pipeline_item_id: pipelineItemId,
    });
    if (error) return { status: "error" };
    if (!data || typeof data !== "object") return { status: "error" };
    const result = (data as { result?: string }).result;
    if (result === "not_found") return { status: "not_found" };
    if (result !== "ok") return { status: "error" };
    const workspace = parseWorkspacePayload(data);
    if (!workspace) return { status: "error" };
    return { status: "ok", workspace };
  } catch {
    return { status: "error" };
  }
}

export type CompensationWriteResult =
  | { result: "saved" }
  | { result: "not_found" }
  | { result: "collaboration_not_found" }
  | { result: "invalid_input" }
  | { result: "error" };

export async function saveCollaborationCompensation(
  userId: string,
  pipelineItemId: string,
  input: CompensationInput,
): Promise<CompensationWriteResult> {
  if (!isUuid(userId) || !isUuid(pipelineItemId)) return { result: "invalid_input" };
  const data = await callRpc("upsert_collaboration_compensation", {
    p_user_id: userId,
    p_pipeline_item_id: pipelineItemId,
    p_structure: input.structure,
    p_cash_amount_minor: input.cashAmountMinor,
    p_cash_currency: input.cashCurrency,
    p_in_kind_description: input.inKindDescription,
    p_in_kind_estimate_minor: input.inKindEstimateMinor,
    p_in_kind_estimate_currency: input.inKindEstimateCurrency,
    p_payment_status: input.paymentStatus,
  });
  return mapWrite(data);
}

export type DeliverableWriteResult =
  | { result: "saved"; deliverableId: string }
  | { result: "deleted" }
  | { result: "not_found" }
  | { result: "collaboration_not_found" }
  | { result: "invalid_input" }
  | { result: "error" };

export async function saveCollaborationDeliverable(
  userId: string,
  pipelineItemId: string,
  input: DeliverableInput,
): Promise<DeliverableWriteResult> {
  if (!isUuid(userId) || !isUuid(pipelineItemId)) return { result: "invalid_input" };
  const data = await callRpc("upsert_collaboration_deliverable", {
    p_user_id: userId,
    p_pipeline_item_id: pipelineItemId,
    p_deliverable_id: input.deliverableId,
    p_deliverable_type: input.deliverableType,
    p_quantity: input.quantity,
    p_platform: input.platform,
    p_due_on: input.dueOn,
    p_status: input.status,
    p_proof_url: input.proofUrl,
    p_notes: input.notes,
  });
  if (!data?.result) {
    logger.warn("deliverable_rpc", { result: "empty" });
    return { result: "error" };
  }
  // The row is stored when SQL says saved. The id is only echoed back; a
  // missing id must not be reported as a failed write.
  if (data.result === "saved") {
    if (typeof data.deliverable_id !== "string") {
      logger.warn("deliverable_rpc", { result: "saved", idType: typeof data.deliverable_id });
    }
    return {
      result: "saved",
      deliverableId: typeof data.deliverable_id === "string" ? data.deliverable_id : "",
    };
  }
  if (data.result === "not_found") return { result: "not_found" };
  if (data.result === "collaboration_not_found") return { result: "collaboration_not_found" };
  if (data.result === "invalid_input") return { result: "invalid_input" };
  return { result: "error" };
}

export async function deleteCollaborationDeliverable(
  userId: string,
  pipelineItemId: string,
  deliverableId: string,
): Promise<DeliverableWriteResult> {
  if (!isUuid(userId) || !isUuid(pipelineItemId) || !isUuid(deliverableId)) {
    return { result: "invalid_input" };
  }
  const data = await callRpc("delete_collaboration_deliverable", {
    p_user_id: userId,
    p_pipeline_item_id: pipelineItemId,
    p_deliverable_id: deliverableId,
  });
  if (data?.result === "deleted") return { result: "deleted" };
  if (data?.result === "not_found") return { result: "not_found" };
  return { result: "error" };
}

export type PrefillResult =
  | { result: "suggested"; structure: string }
  | { result: "no_current_machine_compensation" }
  | { result: "not_found" }
  | { result: "collaboration_not_found" }
  | { result: "invalid_input" }
  | { result: "error" };

export async function prefillCollaborationCompensation(
  userId: string,
  pipelineItemId: string,
  mailAccountId: string,
  providerThreadId: string,
): Promise<PrefillResult> {
  if (!isUuid(userId) || !isUuid(pipelineItemId) || !isUuid(mailAccountId)) {
    return { result: "invalid_input" };
  }
  const data = await callRpc("prefill_collaboration_compensation_suggestion", {
    p_user_id: userId,
    p_pipeline_item_id: pipelineItemId,
    p_mail_account_id: mailAccountId,
    p_provider_thread_id: providerThreadId,
  });
  if (!data?.result) return { result: "error" };
  if (data.result === "suggested") {
    const structure = (data as { structure?: unknown }).structure;
    if (typeof structure !== "string") return { result: "error" };
    return { result: "suggested", structure };
  }
  if (
    data.result === "no_current_machine_compensation" ||
    data.result === "not_found" ||
    data.result === "collaboration_not_found" ||
    data.result === "invalid_input"
  ) {
    return { result: data.result };
  }
  return { result: "error" };
}

function mapWrite(data: RpcResult | null): CompensationWriteResult {
  if (!data?.result) return { result: "error" };
  if (data.result === "saved") return { result: "saved" };
  if (data.result === "not_found") return { result: "not_found" };
  if (data.result === "collaboration_not_found") return { result: "collaboration_not_found" };
  if (data.result === "invalid_input") return { result: "invalid_input" };
  return { result: "error" };
}
