"use server";

/**
 * D095 onboarding writes. The session is resolved here. A destination id is
 * checked against the catalog. The write names the caller's profile. It does
 * not create a trip.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { resolveSession } from "@/lib/auth/guards";
import { bindServerActions } from "@/lib/entitlements/inventory";
import { isUuid } from "@/lib/hotels/ids";
import { createClient } from "@/lib/supabase/server";

bindServerActions(["onboarding.activation"]);

export type DestinationSaveResult = { error: string } | { redirectTo: string };

async function ownCreatorId(): Promise<string | null> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return null;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("creator_profiles")
    .select("id")
    .eq("user_id", resolution.session.userId)
    .maybeSingle();
  if (error || !data || typeof (data as { id?: unknown }).id !== "string") return null;
  const id = (data as { id: string }).id;
  return isUuid(id) ? id : null;
}

export async function chooseOnboardingDestination(
  _prev: DestinationSaveResult | null,
  formData: FormData,
): Promise<DestinationSaveResult> {
  const destinationId = formData.get("destinationId");
  if (typeof destinationId !== "string" || !isUuid(destinationId)) {
    return { error: "Elegí un destino de la lista." };
  }
  const creatorId = await ownCreatorId();
  if (!creatorId) return { error: "Tenés que iniciar sesión." };

  const supabase = await createClient();
  const destination = await supabase
    .from("destinations")
    .select("id")
    .eq("id", destinationId)
    .maybeSingle();
  if (destination.error || !destination.data) {
    return { error: "Ese destino no está en nuestra base." };
  }

  const { error } = await supabase.from("creator_onboarding_state").upsert(
    { creator_id: creatorId, destination_id: destinationId },
    { onConflict: "creator_id" },
  );
  if (error) return { error: "No pudimos guardar el destino. Probá de nuevo." };

  revalidatePath("/app");
  revalidatePath("/app/onboarding");
  redirect("/app/onboarding/hotels");
}

export async function dismissOnboardingChecklist(
  _prev: { error: string } | { ok: true } | null,
  _formData: FormData,
): Promise<{ error: string } | { ok: true }> {
  const creatorId = await ownCreatorId();
  if (!creatorId) return { error: "Tenés que iniciar sesión." };
  const supabase = await createClient();
  const { error } = await supabase.from("creator_onboarding_state").upsert(
    { creator_id: creatorId, checklist_dismissed_at: new Date().toISOString() },
    { onConflict: "creator_id" },
  );
  if (error) return { error: "No pudimos ocultar la lista. Probá de nuevo." };
  revalidatePath("/app");
  return { ok: true };
}
