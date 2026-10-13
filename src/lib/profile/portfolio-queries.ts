/**
 * Owner portfolio read (D125).
 *
 * The cookie-bound client is the caller. The function takes no user id.
 * A failed read is not an empty list of suggestions.
 */
import "server-only";

import { createClient } from "@/lib/supabase/server";

import { mapOwnPortfolio, type OwnPortfolioLoad } from "./portfolio-contract";

export async function getOwnPortfolio(): Promise<OwnPortfolioLoad> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("read_own_creator_portfolio");
    if (error) return { status: "error" };
    return mapOwnPortfolio(data);
  } catch {
    return { status: "error" };
  }
}
