/**
 * Boolean contact existence for the hotels already on a Discover page.
 * The cookie client calls the RPC. The RPC does not return an address.
 */
import "server-only";

import { createClient } from "@/lib/supabase/server";

import { parseContactFlags } from "./contact-exists";
import { isUuid } from "./ids";

export async function listCatalogContactFlags(
  hotelIds: readonly string[],
): Promise<{ status: "ok"; flags: Map<string, boolean> } | { status: "error" }> {
  const ids = [...new Set(hotelIds.filter((id) => isUuid(id)))].slice(0, 50);
  if (ids.length === 0) return { status: "ok", flags: new Map() };
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("catalog_contact_exists", {
      p_hotel_ids: ids,
    });
    if (error) return { status: "error" };
    const flags = parseContactFlags(data);
    if (!flags) return { status: "error" };
    return { status: "ok", flags };
  } catch {
    return { status: "error" };
  }
}
