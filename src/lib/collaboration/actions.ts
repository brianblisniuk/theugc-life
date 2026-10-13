"use server";

import { revalidatePath } from "next/cache";

import { resolveSession } from "@/lib/auth/guards";
import { bindServerActions } from "@/lib/entitlements/inventory";
import { logger } from "@/lib/logger";

// Load-time binding. A "use server" module may export only async functions.
bindServerActions(["collaborations.compensation"]);

import { parseCompensationForm, parseDeliverableForm, parsePrefillForm } from "./contract";
import {
  deleteCollaborationDeliverable,
  prefillCollaborationCompensation,
  saveCollaborationCompensation,
  saveCollaborationDeliverable,
  type CompensationWriteResult,
  type DeliverableWriteResult,
  type PrefillResult,
} from "./queries";

function readField(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === "string" ? value : null;
}

function revalidate(hotelId: string | null) {
  if (hotelId) revalidatePath(`/app/hotels/${hotelId}`);
  revalidatePath("/app/pipeline");
}

export async function saveCompensationAction(formData: FormData): Promise<CompensationWriteResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const pipelineItemId = readField(formData, "pipelineItemId");
  if (!pipelineItemId) return { result: "invalid_input" };
  const parsed = parseCompensationForm({
    structure: readField(formData, "structure"),
    cashAmount: readField(formData, "cashAmount"),
    cashCurrency: readField(formData, "cashCurrency"),
    inKindDescription: readField(formData, "inKindDescription"),
    inKindEstimate: readField(formData, "inKindEstimate"),
    inKindEstimateCurrency: readField(formData, "inKindEstimateCurrency"),
    paymentStatus: readField(formData, "paymentStatus"),
  });
  if (!parsed.ok) return { result: "invalid_input" };
  const result = await saveCollaborationCompensation(
    resolution.session.userId,
    pipelineItemId,
    parsed.value,
  );
  if (result.result === "saved") revalidate(readField(formData, "hotelId"));
  return result;
}

export async function saveDeliverableAction(formData: FormData): Promise<DeliverableWriteResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const pipelineItemId = readField(formData, "pipelineItemId");
  if (!pipelineItemId) return { result: "invalid_input" };
  const parsed = parseDeliverableForm({
    deliverableId: readField(formData, "deliverableId"),
    deliverableType: readField(formData, "deliverableType"),
    quantity: readField(formData, "quantity"),
    platform: readField(formData, "platform"),
    dueOn: readField(formData, "dueOn"),
    status: readField(formData, "status"),
    proofUrl: readField(formData, "proofUrl"),
    notes: readField(formData, "notes"),
  });
  if (!parsed.ok) return { result: "invalid_input" };
  const result = await saveCollaborationDeliverable(
    resolution.session.userId,
    pipelineItemId,
    parsed.value,
  );
  // Result code only. Platform, notes, and proof URLs stay out of the log.
  logger.info("deliverable_write", { result: result.result });
  if (result.result === "saved") revalidate(readField(formData, "hotelId"));
  return result;
}

export async function deleteDeliverableAction(formData: FormData): Promise<DeliverableWriteResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const pipelineItemId = readField(formData, "pipelineItemId");
  const deliverableId = readField(formData, "deliverableId");
  if (!pipelineItemId || !deliverableId) return { result: "invalid_input" };
  const result = await deleteCollaborationDeliverable(
    resolution.session.userId,
    pipelineItemId,
    deliverableId,
  );
  if (result.result === "deleted") revalidate(readField(formData, "hotelId"));
  return result;
}

export async function prefillCompensationAction(formData: FormData): Promise<PrefillResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const pipelineItemId = readField(formData, "pipelineItemId");
  if (!pipelineItemId) return { result: "invalid_input" };
  const parsed = parsePrefillForm({
    mailAccountId: readField(formData, "mailAccountId"),
    providerThreadId: readField(formData, "providerThreadId"),
  });
  if (!parsed.ok) return { result: "invalid_input" };
  const result = await prefillCollaborationCompensation(
    resolution.session.userId,
    pipelineItemId,
    parsed.value.mailAccountId,
    parsed.value.providerThreadId,
  );
  if (result.result === "suggested") revalidate(readField(formData, "hotelId"));
  return result;
}
