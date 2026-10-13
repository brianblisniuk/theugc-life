"use server";

/**
 * Owner writes for the travel portfolio (D125).
 *
 * The session is the caller. No action accepts another creator's id.
 * Publishing is the explicit approval. A Gmail detection is not an input.
 */
import { revalidatePath } from "next/cache";

import { resolveSession } from "@/lib/auth/guards";
import { bindServerActions } from "@/lib/entitlements/inventory";
import { isUuid } from "@/lib/hotels/ids";
import { createClient } from "@/lib/supabase/server";

import { isPortfolioTemplate } from "./portfolio-contract";

bindServerActions(["profile.portfolio"]);

export type PortfolioWriteResult =
  | { result: "saved" | "published" | "dismissed" | "withdrawn" }
  | { result: "invalid_input"; message: string }
  | { result: "not_found" | "not_confirmed" | "error" };

function readField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

async function authedClient() {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return null;
  return createClient();
}

function revalidatePortfolio() {
  revalidatePath("/app/profile/portfolio");
  revalidatePath("/app/profile");
}

export async function setPortfolioTemplate(formData: FormData): Promise<PortfolioWriteResult> {
  const template = readField(formData, "template");
  if (!isPortfolioTemplate(template)) {
    return { result: "invalid_input", message: "Choose Journey, Destinations, or Highlights." };
  }
  const supabase = await authedClient();
  if (!supabase) return { result: "error" };
  try {
    const { data, error } = await supabase.rpc("set_creator_portfolio_template", {
      p_template: template,
    });
    if (error) return { result: "error" };
    const row = data as { result?: string } | null;
    if (row?.result === "saved") {
      revalidatePortfolio();
      return { result: "saved" };
    }
    if (row?.result === "invalid_input") {
      return { result: "invalid_input", message: "Choose Journey, Destinations, or Highlights." };
    }
    if (row?.result === "not_found") return { result: "not_found" };
    return { result: "error" };
  } catch {
    return { result: "error" };
  }
}

async function decide(
  collaborationId: string,
  rpc:
    | "publish_creator_portfolio_entry"
    | "dismiss_creator_portfolio_entry"
    | "withdraw_creator_portfolio_entry",
  ok: "published" | "dismissed" | "withdrawn",
): Promise<PortfolioWriteResult> {
  if (!isUuid(collaborationId)) {
    return { result: "invalid_input", message: "That collaboration could not be used." };
  }
  const supabase = await authedClient();
  if (!supabase) return { result: "error" };
  try {
    const { data, error } = await supabase.rpc(rpc, { p_collaboration_id: collaborationId });
    if (error) return { result: "error" };
    const row = data as { result?: string } | null;
    if (row?.result === ok) {
      revalidatePortfolio();
      return { result: ok };
    }
    if (row?.result === "not_found") return { result: "not_found" };
    if (row?.result === "not_confirmed") return { result: "not_confirmed" };
    if (row?.result === "invalid_input") {
      return { result: "invalid_input", message: "That collaboration could not be used." };
    }
    return { result: "error" };
  } catch {
    return { result: "error" };
  }
}

export async function publishPortfolioEntry(formData: FormData): Promise<PortfolioWriteResult> {
  return decide(
    readField(formData, "collaborationId"),
    "publish_creator_portfolio_entry",
    "published",
  );
}

export async function dismissPortfolioEntry(formData: FormData): Promise<PortfolioWriteResult> {
  return decide(
    readField(formData, "collaborationId"),
    "dismiss_creator_portfolio_entry",
    "dismissed",
  );
}

export async function withdrawPortfolioEntry(formData: FormData): Promise<PortfolioWriteResult> {
  return decide(
    readField(formData, "collaborationId"),
    "withdraw_creator_portfolio_entry",
    "withdrawn",
  );
}
