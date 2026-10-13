/**
 * Server-side premium hotel gate.
 *
 * The inventory names the helper. The database answers it, for auth.uid()
 * only. A failed call is an error, not a denial and not Free (D059).
 * Denied and error both skip the premium query.
 */
import "server-only";

import { mapContactAccess, type ContactAccessResult } from "@/lib/hotels/access";
import { isUuid } from "@/lib/hotels/ids";
import { createClient } from "@/lib/supabase/server";

import { featureById, PREMIUM_HOTEL_RPC } from "./inventory";

export async function enforcePremiumHotelAccess(hotelId: string): Promise<ContactAccessResult> {
  const contacts = featureById("hotel.premium_contacts");
  const intelligence = featureById("hotel.premium_intelligence");
  if (
    intelligence.enforcement.kind !== "premium_intelligence" ||
    !intelligence.rpcs.includes(PREMIUM_HOTEL_RPC) ||
    contacts.rule.kind !== "credit_unlock" ||
    contacts.rpcs.includes(PREMIUM_HOTEL_RPC)
  ) {
    throw new Error(
      "premium intelligence stays on has_premium_hotel_access; contacts are an unlock",
    );
  }

  if (!isUuid(hotelId)) return { status: "denied" };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(PREMIUM_HOTEL_RPC, { hotel_id: hotelId });
  return mapContactAccess({ data, error });
}
