"use server";

import { revalidatePath } from "next/cache";

import { resolveSession } from "@/lib/auth/guards";
import { bindServerActions } from "@/lib/entitlements/inventory";
import { logger } from "@/lib/logger";

bindServerActions(["collaborations.contracts"]);

import {
  deleteCollaborationContract,
  generateCollaborationContract,
  saveCollaborationContract,
  type DeleteContractResult,
  type GenerateContractResult,
  type SaveContractResult,
} from "./queries";
import { isContractKind } from "./text";

function readField(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === "string" ? value : null;
}

function revalidate(hotelId: string | null) {
  if (hotelId) revalidatePath(`/app/hotels/${hotelId}`);
  revalidatePath("/app/collaborations");
}

export async function generateContractAction(formData: FormData): Promise<GenerateContractResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const pipelineItemId = readField(formData, "pipelineItemId");
  const kind = readField(formData, "kind");
  if (!pipelineItemId || !kind || !isContractKind(kind)) return { result: "invalid_input" };
  const result = await generateCollaborationContract(
    resolution.session.userId,
    pipelineItemId,
    kind,
  );
  logger.info("contract_generate", { result: result.result });
  if (result.result === "created") revalidate(readField(formData, "hotelId"));
  return result;
}

export async function saveContractAction(formData: FormData): Promise<SaveContractResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const contractId = readField(formData, "contractId");
  const title = readField(formData, "title");
  const body = readField(formData, "body");
  if (!contractId || title === null || body === null) return { result: "invalid_input" };
  const result = await saveCollaborationContract(
    resolution.session.userId,
    contractId,
    title,
    body,
  );
  logger.info("contract_save", { result: result.result });
  if (result.result === "saved") revalidate(readField(formData, "hotelId"));
  return result;
}

export async function deleteContractAction(formData: FormData): Promise<DeleteContractResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const contractId = readField(formData, "contractId");
  if (!contractId) return { result: "invalid_input" };
  const result = await deleteCollaborationContract(resolution.session.userId, contractId);
  logger.info("contract_delete", { result: result.result });
  if (result.result === "deleted") revalidate(readField(formData, "hotelId"));
  return result;
}
