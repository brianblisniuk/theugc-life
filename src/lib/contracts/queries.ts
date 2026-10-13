import "server-only";

import { isUuid } from "@/lib/hotels/ids";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { isContractKind, type ContractDraft, type ContractKind } from "./text";

export type ContractListLoad =
  { status: "ok"; drafts: ContractDraft[] } | { status: "error" } | { status: "hidden" };

type RpcResult = {
  result?: string;
  contract_id?: string;
  title?: string;
  kind?: string;
  body?: string;
};

async function callRpc(name: string, args: Record<string, unknown>): Promise<RpcResult | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc(name, args);
  if (error || !data || typeof data !== "object") return null;
  return data as RpcResult;
}

/**
 * Drafts for one deal. The read uses the signed-in creator, so RLS returns
 * only that creator's rows. An id that is not theirs is an empty list.
 */
export async function listCollaborationContracts(
  pipelineItemId: string,
): Promise<ContractListLoad> {
  if (!isUuid(pipelineItemId)) return { status: "hidden" };
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("collaboration_contracts")
      .select("id, kind, title, body, updated_at")
      .eq("pipeline_item_id", pipelineItemId)
      .order("updated_at", { ascending: false });
    if (error) return { status: "error" };
    const drafts: ContractDraft[] = [];
    for (const row of data ?? []) {
      if (
        typeof row.id !== "string" ||
        typeof row.kind !== "string" ||
        !isContractKind(row.kind) ||
        typeof row.title !== "string" ||
        typeof row.body !== "string" ||
        typeof row.updated_at !== "string"
      ) {
        return { status: "error" };
      }
      drafts.push({
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        updatedAt: row.updated_at,
      });
    }
    return { status: "ok", drafts };
  } catch {
    return { status: "error" };
  }
}

export type GenerateContractResult =
  | { result: "created"; contractId: string; title: string; body: string; kind: ContractKind }
  | { result: "not_found" }
  | { result: "not_won" }
  | { result: "collaboration_not_found" }
  | { result: "invalid_input" }
  | { result: "too_long" }
  | { result: "integrity_error" }
  | { result: "creator_profile_missing" }
  | { result: "error" };

export async function generateCollaborationContract(
  userId: string,
  pipelineItemId: string,
  kind: ContractKind,
): Promise<GenerateContractResult> {
  if (!isUuid(userId) || !isUuid(pipelineItemId)) return { result: "invalid_input" };
  const data = await callRpc("generate_collaboration_contract", {
    p_user_id: userId,
    p_pipeline_item_id: pipelineItemId,
    p_kind: kind,
  });
  if (!data?.result) {
    logger.warn("contract_generate", { result: "empty" });
    return { result: "error" };
  }
  if (data.result === "created") {
    if (
      typeof data.contract_id !== "string" ||
      typeof data.title !== "string" ||
      typeof data.body !== "string" ||
      typeof data.kind !== "string" ||
      !isContractKind(data.kind)
    ) {
      logger.warn("contract_generate", { result: "created_shape" });
      return { result: "error" };
    }
    return {
      result: "created",
      contractId: data.contract_id,
      title: data.title,
      body: data.body,
      kind: data.kind,
    };
  }
  if (
    data.result === "not_found" ||
    data.result === "not_won" ||
    data.result === "collaboration_not_found" ||
    data.result === "invalid_input" ||
    data.result === "too_long" ||
    data.result === "integrity_error" ||
    data.result === "creator_profile_missing"
  ) {
    return { result: data.result };
  }
  logger.warn("contract_generate", { result: "unexpected" });
  return { result: "error" };
}

export type SaveContractResult =
  | { result: "saved" }
  | { result: "not_found" }
  | { result: "invalid_input" }
  | { result: "disclaimer_required" }
  | { result: "too_long" }
  | { result: "creator_profile_missing" }
  | { result: "error" };

export async function saveCollaborationContract(
  userId: string,
  contractId: string,
  title: string,
  body: string,
): Promise<SaveContractResult> {
  if (!isUuid(userId) || !isUuid(contractId)) return { result: "invalid_input" };
  const data = await callRpc("update_collaboration_contract", {
    p_user_id: userId,
    p_contract_id: contractId,
    p_title: title,
    p_body: body,
  });
  if (!data?.result) return { result: "error" };
  if (
    data.result === "saved" ||
    data.result === "not_found" ||
    data.result === "invalid_input" ||
    data.result === "disclaimer_required" ||
    data.result === "too_long" ||
    data.result === "creator_profile_missing"
  ) {
    return { result: data.result };
  }
  return { result: "error" };
}

export type DeleteContractResult =
  | { result: "deleted" }
  | { result: "not_found" }
  | { result: "invalid_input" }
  | { result: "creator_profile_missing" }
  | { result: "error" };

export async function deleteCollaborationContract(
  userId: string,
  contractId: string,
): Promise<DeleteContractResult> {
  if (!isUuid(userId) || !isUuid(contractId)) return { result: "invalid_input" };
  const data = await callRpc("delete_collaboration_contract", {
    p_user_id: userId,
    p_contract_id: contractId,
  });
  if (!data?.result) return { result: "error" };
  if (
    data.result === "deleted" ||
    data.result === "not_found" ||
    data.result === "invalid_input" ||
    data.result === "creator_profile_missing"
  ) {
    return { result: data.result };
  }
  return { result: "error" };
}
