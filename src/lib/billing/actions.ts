"use server";

import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/guards";
import {
  createHostedPaymentLink,
  ensureRebillPlan,
  hostedCheckoutAllowed,
  readRebillOrganization,
} from "@/lib/billing/rebill-checkout";
import {
  isRebillPlanProduct,
  isRebillProductCode,
  readRebillEnv,
} from "@/lib/billing/rebill-catalog";
import { getClientEnv } from "@/env";
import { bindServerActions } from "@/lib/entitlements/inventory";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

bindServerActions(["commerce.grant"]);

/**
 * Starts a hosted Rebill checkout for the signed-in account.
 * The form may name a product. It may not name an account. The price is the
 * database catalog. Live mode is required before a productive org is used.
 */
export async function startRebillCheckoutAction(formData: FormData): Promise<void> {
  const session = await requireUser("/app/billing");
  if (!session.userId) redirect("/login?redirect=%2Fapp%2Fbilling");
  const productField = formData.get("product");
  const product = typeof productField === "string" ? productField : "";
  if (!isRebillProductCode(product)) {
    redirect("/app/billing?checkout=invalid_product");
  }

  const env = readRebillEnv();
  const organization = await readRebillOrganization(env, fetch);
  const allowed = hostedCheckoutAllowed(organization, env);
  if (allowed.result !== "allowed") {
    redirect(`/app/billing?checkout=${allowed.result}`);
  }

  const supabase = await createClient();
  const created = await supabase.rpc("create_own_rebill_checkout", { p_product_code: product });
  const row = created.data as {
    result?: string;
    checkout_id?: string;
    amount_usd?: number;
  } | null;
  if (created.error || !row || row.result !== "created" || !row.checkout_id || !row.amount_usd) {
    redirect("/app/billing?checkout=provider_error");
  }

  let planId: string | null = null;
  if (isRebillPlanProduct(product)) {
    const admin = createAdminClient();
    const existing = await admin
      .from("rebill_catalog")
      .select("provider_plan_id")
      .eq("product_code", product)
      .maybeSingle();
    const stored =
      existing.data && typeof existing.data.provider_plan_id === "string"
        ? existing.data.provider_plan_id
        : null;
    planId = await ensureRebillPlan({
      env,
      product,
      amountUsd: row.amount_usd,
      existingPlanId: stored,
      fetchImpl: fetch,
    });
    if (!planId) redirect("/app/billing?checkout=provider_error");
    const recorded = await admin.rpc("record_rebill_plan_id", {
      p_product_code: product,
      p_plan_id: planId,
    });
    if (recorded.error || typeof recorded.data !== "string") {
      redirect("/app/billing?checkout=provider_error");
    }
    planId = recorded.data;
  }

  const link = await createHostedPaymentLink({
    env,
    product,
    checkoutId: row.checkout_id,
    amountUsd: row.amount_usd,
    planId,
    siteUrl: getClientEnv().NEXT_PUBLIC_SITE_URL,
    fetchImpl: fetch,
  });
  if (link.result !== "ready") {
    redirect(`/app/billing?checkout=${link.result}`);
  }

  const attached = await supabase.rpc("attach_own_rebill_checkout_link", {
    p_checkout_id: row.checkout_id,
    p_link_id: link.linkId,
  });
  const attachResult = (attached.data as { result?: string } | null)?.result;
  if (attached.error || attachResult !== "attached") {
    redirect("/app/billing?checkout=provider_error");
  }

  redirect(link.url);
}
