"use server";

/**
 * Owner writes for the hotel share link.
 *
 * The session is resolved here. No action accepts another creator's id, and
 * none of them stores the raw token.
 */
import { revalidatePath } from "next/cache";

import { resolveSession } from "@/lib/auth/guards";
import { isUuid } from "@/lib/hotels/ids";
import { createClient } from "@/lib/supabase/server";

import {
  parseEngagement,
  parseFollowerCount,
  parseShareExpiry,
  optInsFromForm,
} from "./share-contract";

export type ShareWriteResult =
  { result: "saved" } | { result: "invalid_input"; message: string } | { result: "error" };

export type ShareLinkResult =
  | { result: "created" | "rotated"; token: string }
  | { result: "revoked" }
  | { result: "active_link_exists" }
  | { result: "not_found" }
  | { result: "invalid_input"; message: string }
  | { result: "error" };

function readField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

async function authedClient() {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return null;
  const supabase = await createClient();
  return supabase;
}

export async function saveSelfReportedAudience(formData: FormData): Promise<ShareWriteResult> {
  const supabase = await authedClient();
  if (!supabase) return { result: "error" };
  const followers = parseFollowerCount(readField(formData, "selfReportedFollowers"));
  if (!followers.ok) {
    return {
      result: "invalid_input",
      message: "Followers must be a whole number, or blank if you don’t know.",
    };
  }
  const engagement = parseEngagement(readField(formData, "selfReportedEngagement"));
  if (!engagement.ok) {
    return { result: "invalid_input", message: "Engagement must be 40 characters or fewer." };
  }
  try {
    const { data, error } = await supabase.rpc("set_creator_self_reported_audience", {
      p_follower_count: followers.value,
      p_engagement: engagement.value,
    });
    if (error) return { result: "error" };
    const row = data as { result?: string } | null;
    if (row?.result !== "saved") return { result: "error" };
  } catch {
    return { result: "error" };
  }
  revalidatePath("/app/profile");
  return { result: "saved" };
}

export async function saveShareOptIns(formData: FormData): Promise<ShareWriteResult> {
  const supabase = await authedClient();
  if (!supabase) return { result: "error" };
  try {
    const { data, error } = await supabase.rpc("set_creator_profile_field_opt_ins", {
      p_opted_in: optInsFromForm(formData),
    });
    if (error) return { result: "error" };
    const row = data as { result?: string } | null;
    if (row?.result !== "saved") return { result: "error" };
  } catch {
    return { result: "error" };
  }
  revalidatePath("/app/profile");
  return { result: "saved" };
}

async function issueLink(
  name: "create_creator_share_link" | "rotate_creator_share_link",
  formData: FormData,
): Promise<ShareLinkResult> {
  const supabase = await authedClient();
  if (!supabase) return { result: "error" };
  const expiry = parseShareExpiry(readField(formData, "expiresOn"));
  if (!expiry.ok) return { result: "invalid_input", message: expiry.message };
  try {
    const { data, error } = await supabase.rpc(name, { p_expires_at: expiry.expiresAt });
    if (error) return { result: "error" };
    const row = data as { result?: string; token?: string } | null;
    if (row?.result === "created" || row?.result === "rotated") {
      if (typeof row.token !== "string" || !/^[0-9a-f]{64}$/.test(row.token))
        return { result: "error" };
      revalidatePath("/app/profile");
      return { result: row.result, token: row.token };
    }
    if (row?.result === "active_link_exists") return { result: "active_link_exists" };
    if (row?.result === "not_found") return { result: "not_found" };
    if (row?.result === "invalid_input") {
      return { result: "invalid_input", message: "Expiry must be a future date." };
    }
    return { result: "error" };
  } catch {
    return { result: "error" };
  }
}

export async function createShareLink(formData: FormData): Promise<ShareLinkResult> {
  return issueLink("create_creator_share_link", formData);
}

export async function rotateShareLink(formData: FormData): Promise<ShareLinkResult> {
  return issueLink("rotate_creator_share_link", formData);
}

export async function revokeShareLink(): Promise<ShareLinkResult> {
  const supabase = await authedClient();
  if (!supabase) return { result: "error" };
  try {
    const { data, error } = await supabase.rpc("revoke_creator_share_link");
    if (error) return { result: "error" };
    const row = data as { result?: string } | null;
    if (row?.result === "revoked") {
      revalidatePath("/app/profile");
      return { result: "revoked" };
    }
    if (row?.result === "not_found") return { result: "not_found" };
    return { result: "error" };
  } catch {
    return { result: "error" };
  }
}

export async function setCollaborationShareable(
  id: string,
  shareable: boolean,
): Promise<ShareWriteResult> {
  if (!isUuid(id)) return { result: "error" };
  const supabase = await authedClient();
  if (!supabase) return { result: "error" };
  try {
    const { data, error } = await supabase.rpc("set_collaboration_share_mark", {
      p_collaboration_id: id,
      p_shareable: shareable,
    });
    if (error) return { result: "error" };
    const row = data as { result?: string } | null;
    if (row?.result !== "saved") return { result: "error" };
  } catch {
    return { result: "error" };
  }
  revalidatePath("/app/profile");
  return { result: "saved" };
}

export async function setDeliverableShareable(
  id: string,
  shareable: boolean,
): Promise<ShareWriteResult> {
  if (!isUuid(id)) return { result: "error" };
  const supabase = await authedClient();
  if (!supabase) return { result: "error" };
  try {
    const { data, error } = await supabase.rpc("set_deliverable_share_mark", {
      p_deliverable_id: id,
      p_shareable: shareable,
    });
    if (error) return { result: "error" };
    const row = data as { result?: string } | null;
    if (row?.result !== "saved") return { result: "error" };
  } catch {
    return { result: "error" };
  }
  revalidatePath("/app/profile");
  return { result: "saved" };
}
