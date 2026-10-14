"use server";

/**
 * Assistant draft for the signed-in creator (D141–D145).
 *
 * The form does not post a user id. Free and a Destination Pass never reach
 * the model. A saved row is a pitch draft. This action does not send mail.
 */

import { revalidatePath } from "next/cache";

import { resolveSession } from "@/lib/auth/guards";
import { bindServerActions } from "@/lib/entitlements/inventory";
import { getHotelById } from "@/lib/hotels/queries";
import { isUuid } from "@/lib/hotels/ids";
import { FACT_KEYS, type FactKey } from "@/lib/pitch/contract";
import { loadPitchContext } from "@/lib/pitch/queries";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { composePitch, type ComposeDeps } from "./compose.server";
import { readAnthropicApiKey } from "./env.server";
import type { OutreachFacts, SelectedMail } from "./prompt";
import { parsePitchBrief } from "./structured";

bindServerActions(["plans.full_ai_email"]);

export type AssistantActionResult =
  | {
      result: "drafted";
      draftId: string | null;
      subject: string;
      body: string;
      warning?: "budget_80";
    }
  | { result: "templates_only" }
  | { result: "out_of_credits" }
  | { result: "monthly_limit" }
  | { result: "pool_exhausted" }
  | { result: "rate_limited" }
  | { result: "paused" }
  | { result: "off_topic" }
  | { result: "invalid_input"; message: string }
  | { result: "not_found" }
  | { result: "error" };

function readField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function selectedIds(formData: FormData): string[] | null {
  const raw = formData.getAll("messageId");
  const ids: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || value.trim() === "") continue;
    if (!isUuid(value)) return null;
    if (!ids.includes(value)) ids.push(value);
    if (ids.length > 3) return null;
  }
  return ids;
}

function factKeys(facts: OutreachFacts): FactKey[] {
  const present = new Set<string>();
  if (facts.creatorName) present.add("creator_name");
  if (facts.niche) present.add("niche");
  if (facts.instagramHandle) present.add("instagram_handle");
  if (facts.hotelName) present.add("hotel_name");
  if (facts.destinationName) present.add("destination_name");
  if (facts.tripName) present.add("trip_name");
  if (facts.tripStart) present.add("trip_start");
  if (facts.tripEnd) present.add("trip_end");
  if (facts.portfolioTitle) present.add("portfolio_title");
  if (facts.portfolioUrl) present.add("portfolio_url");
  if (facts.contactName) present.add("contact_name");
  if (facts.intelligenceNote) present.add("intelligence_note");
  if (facts.pastCollaboration) present.add("past_collaboration");
  return FACT_KEYS.filter((key) => present.has(key));
}

async function selectedMail(ids: readonly string[]): Promise<SelectedMail[] | null> {
  if (ids.length === 0) return [];
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("read_own_selected_gmail_plain", {
    p_message_ids: ids,
  });
  if (error || !Array.isArray(data)) return null;
  const mail: SelectedMail[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const record = row as { message_id?: unknown; plain_text?: unknown };
    if (typeof record.message_id !== "string" || typeof record.plain_text !== "string") continue;
    if (!ids.includes(record.message_id)) continue;
    mail.push({ id: record.message_id, text: record.plain_text });
  }
  return mail;
}

export async function draftPitchWithAssistantAction(
  formData: FormData,
): Promise<AssistantActionResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const userId = resolution.session.userId;

  const hotelId = readField(formData, "hotelId");
  const tripId = readField(formData, "tripId");
  if (!isUuid(hotelId)) return { result: "invalid_input", message: "Choose a hotel." };
  if (tripId && !isUuid(tripId))
    return { result: "invalid_input", message: "Choose one of your trips." };
  const messageIds = selectedIds(formData);
  if (!messageIds)
    return { result: "invalid_input", message: "Choose messages from your own list." };

  const hotel = await getHotelById(hotelId);
  if (!hotel) return { result: "not_found" };

  const context = await loadPitchContext({
    userId,
    hotelId,
    hotelName: hotel.hotel.name,
    destinationName: hotel.hotel.destination?.name ?? null,
    requestedTripId: tripId || null,
    preferDraftTrip: false,
  });
  if (context.status !== "ok") return { result: "error" };
  if (tripId && context.selectedTripId !== tripId) {
    return { result: "invalid_input", message: "Choose one of your trips." };
  }

  const brief = parsePitchBrief({
    tone: readField(formData, "tone"),
    language: readField(formData, "language"),
    keyPoints: formData
      .getAll("keyPoint")
      .filter((value): value is string => typeof value === "string"),
  });
  if (!brief.ok) return { result: "invalid_input", message: brief.message };

  const mail = await selectedMail(messageIds);
  if (!mail) return { result: "error" };

  const facts: OutreachFacts = {
    language: context.primaryLanguage,
    creatorName: context.facts.creator_name ?? null,
    niche: context.facts.niche ?? null,
    instagramHandle: context.facts.instagram_handle ?? null,
    hotelName: context.facts.hotel_name ?? hotel.hotel.name,
    destinationName: context.facts.destination_name ?? null,
    tripName: context.facts.trip_name ?? null,
    tripStart: context.facts.trip_start ?? null,
    tripEnd: context.facts.trip_end ?? null,
    portfolioTitle: context.facts.portfolio_title ?? null,
    portfolioUrl: context.facts.portfolio_url ?? null,
    contactName: context.facts.contact_name ?? null,
    intelligenceNote: context.facts.intelligence_note ?? null,
    pastCollaboration: context.facts.past_collaboration ?? null,
    pipelineStatus: context.relationshipStatus,
    selectedMail: mail,
  };

  const supabase = await createClient();
  const features = await supabase.rpc("own_plan_features");
  if (features.error || !features.data || typeof features.data !== "object") {
    return { result: "error" };
  }
  const flags = features.data as { full_ai_email?: unknown; priority_ai?: unknown };
  const balance = await supabase.rpc("own_credit_balance");
  if (balance.error || typeof balance.data !== "number") return { result: "error" };

  const deps: ComposeDeps = {
    fullAi: flags.full_ai_email === true,
    priority: flags.priority_ai === true,
    balance: balance.data,
    apiKey: readAnthropicApiKey(),
    hotelId,
    brief: brief.brief,
    facts,
    charge: async (idempotencyKey) => {
      const charged = await supabase.rpc("charge_own_ai_draft", {
        p_idempotency_key: idempotencyKey,
      });
      if (charged.error || !charged.data || typeof charged.data !== "object") return "error";
      const status = (charged.data as { status?: unknown }).status;
      if (
        status === "charged" ||
        status === "already_charged" ||
        status === "out_of_credits" ||
        status === "forbidden"
      ) {
        return status;
      }
      return "error";
    },
    prepare: async (input) => {
      const admin = createAdminClient();
      const prepared = await admin.rpc("prepare_ai_usage", {
        p_user_id: userId,
        p_request_id: input.requestId,
        p_model: input.model,
        p_hotel_id: input.hotelId,
        p_estimate_micros: input.estimateMicros,
        p_user_budget_micros: input.userBudgetMicros,
        p_regen_weight: input.regenWeight,
        p_pool_floor_micros: input.poolFloorMicros,
        p_pool_percent_bps: input.poolPercentBps,
      });
      if (prepared.error || !prepared.data || typeof prepared.data !== "object") return "error";
      const row = prepared.data as { status?: unknown; warning?: unknown; weight?: unknown };
      const status = row.status;
      const weight = typeof row.weight === "number" && Number.isInteger(row.weight) ? row.weight : 1;
      if (status === "reserved" || status === "already_reserved") {
        return {
          status,
          weight,
          ...(row.warning === "budget_80" ? { warning: "budget_80" as const } : {}),
        };
      }
      if (
        status === "budget" ||
        status === "pool" ||
        status === "rate_limited" ||
        status === "paused" ||
        status === "not_unlocked"
      ) {
        return status;
      }
      return "error";
    },
    finish: async (input) => {
      const admin = createAdminClient();
      const finished = await admin.rpc("finish_ai_usage", {
        p_user_id: userId,
        p_request_id: input.requestId,
        p_model: input.model,
        p_input_tokens: input.inputTokens,
        p_output_tokens: input.outputTokens,
        p_cost_micros: input.costMicros,
        p_status: input.status,
        p_pool_floor_micros: input.poolFloorMicros,
        p_pool_percent_bps: input.poolPercentBps,
      });
      if (finished.error) throw new Error("ai usage was not recorded");
    },
  };

  let outcome: Awaited<ReturnType<typeof composePitch>>;
  try {
    outcome = await composePitch(deps);
  } catch {
    return { result: "error" };
  }
  if (outcome.status === "injection") {
    const admin = createAdminClient();
    await admin.rpc("record_abuse_flag", {
      p_user_id: userId,
      p_hotel_id: hotelId,
      p_signal: "injection_attempt",
    });
    return { result: "invalid_input", message: "That draft couldn't be created." };
  }
  if (outcome.status !== "drafted" || !outcome.subject || !outcome.body) {
    if (outcome.status === "templates_only") return { result: "templates_only" };
    if (outcome.status === "out_of_credits") return { result: "out_of_credits" };
    if (outcome.status === "monthly_limit") return { result: "monthly_limit" };
    if (outcome.status === "pool_exhausted") return { result: "pool_exhausted" };
    if (outcome.status === "rate_limited") return { result: "rate_limited" };
    if (outcome.status === "paused") return { result: "paused" };
    if (outcome.status === "off_topic") return { result: "off_topic" };
    if (outcome.status === "not_unlocked") return { result: "not_found" };
    if (outcome.status === "invalid_input") {
      return { result: "invalid_input", message: "Choose a tone, a language, and key points." };
    }
    return { result: "error" };
  }

  const { data, error } = await supabase
    .from("pitch_drafts")
    .insert({
      hotel_id: hotelId,
      trip_id: tripId || null,
      template_id: null,
      system_template_key: null,
      subject: outcome.subject,
      body: outcome.body,
      variables_used: factKeys(facts),
      delivery: "unsent",
      origin: "assistant",
    })
    .select("id")
    .single();
  revalidatePath(`/app/hotels/${hotelId}/pitch`);
  return {
    result: "drafted",
    warning: outcome.warning,
    draftId: error || typeof data?.id !== "string" ? null : data.id,
    subject: outcome.subject,
    body: outcome.body,
  };
}
