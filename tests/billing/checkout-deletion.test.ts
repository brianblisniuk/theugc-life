/**
 * A deletion-pending account is sent back to billing before a payment link
 * is created. The provider is not asked for a new pack.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

vi.mock("@/lib/auth/guards", () => ({
  requireUser: async () => ({
    userId: "d106c000-0000-4000-8000-000000000004",
    email: null,
    role: "creator",
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("admin client should not run");
  },
}));

import { startRebillCheckoutAction } from "@/lib/billing/actions";

function form() {
  const data = new FormData();
  data.set("product", "pack_50");
  return data;
}

describe("checkout refuses a deletion-pending account", () => {
  beforeEach(() => {
    rpc.mockReset();
    vi.unstubAllEnvs();
    vi.stubEnv("REBILL_SECRET_KEY", "sk_test_secret");
    vi.stubEnv("REBILL_LIVE", "false");
  });

  it("redirects and does not create a payment link", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(String(url));
        if (String(url).endsWith("/organizations/me")) {
          return Response.json({ environment: "sandbox" });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    rpc.mockResolvedValue({ data: { result: "deletion_pending" }, error: null });

    await expect(startRebillCheckoutAction(form())).rejects.toThrow(
      "REDIRECT:/app/billing?checkout=deletion_pending",
    );
    expect(rpc).toHaveBeenCalledWith("create_own_rebill_checkout", { p_product_code: "pack_50" });
    expect(urls).toEqual(["https://api.rebill.com/v3/organizations/me"]);
  });
});
