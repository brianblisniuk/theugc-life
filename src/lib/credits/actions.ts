"use server";

/**
 * Credit and contact actions (D100).
 *
 * The browser posts a hotel id. The session is the user. A forged user id is
 * not read. The service-role client writes the cache only after the database
 * has asked for a provider, and only the fake provider is called.
 */
import { revalidatePath } from "next/cache";

import { resolveSession } from "@/lib/auth/guards";
import { domainFromWebsite, getContactProvider } from "@/lib/contacts/provider";
import { bindServerActions } from "@/lib/entitlements/inventory";
import { isUuid } from "@/lib/hotels/ids";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import type {
  AdminGrantResult,
  ReportActionResult,
  ReviewReportResult,
  UnlockActionResult,
} from "./types";

bindServerActions(["hotel.premium_contacts", "admin.staff"]);

function readField(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === "string" ? value : null;
}

interface UnlockPayload {
  status?: string;
  email?: unknown;
  balance?: unknown;
}

function asPayload(data: unknown): UnlockPayload | null {
  if (!data || typeof data !== "object") return null;
  return data as UnlockPayload;
}

function balanceOf(payload: UnlockPayload | null): number | null {
  return typeof payload?.balance === "number" && Number.isInteger(payload.balance)
    ? payload.balance
    : null;
}

function ownedEmail(payload: UnlockPayload | null): string | null {
  return typeof payload?.email === "string" && payload.email.length > 0 ? payload.email : null;
}

function refreshCreditSurfaces(hotelId: string): void {
  revalidatePath("/app", "layout");
  revalidatePath(`/app/hotels/${hotelId}`);
  revalidatePath("/app/onboarding/hotels");
  revalidatePath("/admin");
}

export async function unlockHotelContactAction(formData: FormData): Promise<UnlockActionResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { status: "unauthenticated", email: null };
  const hotelId = readField(formData, "hotelId");
  if (!hotelId || !isUuid(hotelId)) return { status: "error", email: null };

  const supabase = await createClient();
  const idempotencyKey = `unlock:${hotelId}`;
  const first = await supabase.rpc("unlock_hotel_contact", {
    p_hotel_id: hotelId,
    p_idempotency_key: idempotencyKey,
  });
  if (first.error) return { status: "error", email: null };
  let payload = asPayload(first.data);
  if (!payload?.status) return { status: "error", email: null };

  if (payload.status === "needs_provider") {
    const hotel = await supabase
      .from("hotels")
      .select("name, website_url")
      .eq("id", hotelId)
      .maybeSingle();
    if (hotel.error || !hotel.data) return { status: "error", email: null };
    const row = hotel.data as { name?: string | null; website_url?: string | null };
    const provider = getContactProvider();
    const found = await provider.findHotelEmail({
      hotelId,
      name: row.name ?? "",
      domain: domainFromWebsite(row.website_url),
    });
    const admin = createAdminClient();
    const written = await admin.rpc("upsert_contact_cache", {
      p_hotel_id: hotelId,
      p_email: found.email,
      p_status: found.status,
      p_raw: found.raw,
    });
    if (written.error) return { status: "error", email: null };
    const second = await supabase.rpc("unlock_hotel_contact", {
      p_hotel_id: hotelId,
      p_idempotency_key: idempotencyKey,
    });
    if (second.error) return { status: "error", email: null };
    payload = asPayload(second.data);
    if (!payload?.status || payload.status === "needs_provider") {
      return { status: "error", email: null };
    }
  }

  if (payload.status === "insufficient_credits") {
    return { status: "insufficient_credits", email: null, balance: balanceOf(payload) };
  }
  if (payload.status === "not_found") {
    return { status: "not_found", email: null, balance: balanceOf(payload) };
  }
  if (payload.status === "hotel_missing") return { status: "hotel_missing", email: null };
  if (payload.status === "unlocked" || payload.status === "already_unlocked") {
    refreshCreditSurfaces(hotelId);
    return {
      status: payload.status,
      email: ownedEmail(payload),
      balance: balanceOf(payload),
    };
  }
  return { status: "error", email: null };
}

export async function reportContactAction(formData: FormData): Promise<ReportActionResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { status: "unauthenticated" };
  const hotelId = readField(formData, "hotelId");
  const reason = readField(formData, "reason")?.trim() ?? "";
  if (!hotelId || !isUuid(hotelId) || reason.length < 1 || reason.length > 500) {
    return { status: "error" };
  }
  const supabase = await createClient();
  const { error } = await supabase.from("contact_reports").insert({
    user_id: resolution.session.userId,
    hotel_id: hotelId,
    reason,
    status: "pending",
  });
  if (error) return { status: "error" };
  revalidatePath(`/app/hotels/${hotelId}`);
  revalidatePath("/admin");
  return { status: "reported" };
}

export async function adminGrantCreditsAction(formData: FormData): Promise<AdminGrantResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") {
    return { status: "unauthenticated", balance: null };
  }
  if (resolution.session.role !== "admin") return { status: "forbidden", balance: null };
  const userId = readField(formData, "userId");
  const amountRaw = readField(formData, "amount");
  const key = readField(formData, "idempotencyKey");
  const amount = amountRaw ? Number(amountRaw) : NaN;
  if (!userId || !isUuid(userId) || !Number.isInteger(amount) || amount <= 0 || !key) {
    return { status: "error", balance: null };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_grant_credits", {
    p_user_id: userId,
    p_amount: amount,
    p_idempotency_key: key,
  });
  if (error) return { status: "error", balance: null };
  const payload = asPayload(data);
  if (payload?.status === "user_missing") return { status: "user_missing", balance: null };
  if (payload?.status !== "granted") return { status: "error", balance: null };
  revalidatePath("/admin");
  revalidatePath("/app", "layout");
  return { status: "granted", balance: balanceOf(payload) };
}

export async function reviewContactReportAction(formData: FormData): Promise<ReviewReportResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { status: "unauthenticated" };
  if (resolution.session.role !== "admin") return { status: "forbidden" };
  const reportId = readField(formData, "reportId");
  const decision = readField(formData, "decision");
  if (!reportId || !isUuid(reportId) || (decision !== "accept" && decision !== "reject")) {
    return { status: "error" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("review_contact_report", {
    p_report_id: reportId,
    p_decision: decision,
  });
  if (error) return { status: "error" };
  const payload = asPayload(data);
  if (payload?.status === "not_found") return { status: "not_found" };
  if (payload?.status !== "accepted" && payload?.status !== "rejected") return { status: "error" };

  revalidatePath("/admin");
  return { status: payload.status };
}
