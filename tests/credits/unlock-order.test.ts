/**
 * A balance below unlock_cost must not ask Hunter, even if the first RPC
 * still says needs_provider. Claude and Rebill are not involved.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findHotelEmail = vi.hoisted(() => vi.fn());
const rpc = vi.hoisted(() => vi.fn());

vi.mock("next/cache", () => ({
  revalidatePath: () => undefined,
}));

vi.mock("@/lib/auth/guards", () => ({
  resolveSession: async () => ({
    status: "authenticated",
    session: {
      userId: "c05a0000-0000-4000-8000-0000000000ee",
      email: null,
      role: "creator",
    },
  }),
}));

vi.mock("@/lib/contacts/provider", () => ({
  domainFromWebsite: () => null,
  getContactProvider: () => ({ findHotelEmail }),
  unlockFollowUp: () => ({ kind: "stop", status: "unavailable" }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc,
    from: () => {
      throw new Error("hotel read should not run");
    },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async () => {
      throw new Error("cache write should not run");
    },
  }),
}));

import { unlockHotelContactAction } from "@/lib/credits/actions";

const HOTEL = "c05f0000-0000-4000-8000-0000000000ee";

function form() {
  const data = new FormData();
  data.set("hotelId", HOTEL);
  return data;
}

describe("unlock action credit gate", () => {
  beforeEach(() => {
    findHotelEmail.mockReset();
    rpc.mockReset();
  });

  it("returns insufficient_credits before a provider call", async () => {
    rpc.mockResolvedValue({
      data: { status: "insufficient_credits", email: null, balance: 0, pipeline_added: false },
      error: null,
    });
    const result = await unlockHotelContactAction(form());
    expect(result).toEqual({ status: "insufficient_credits", email: null, balance: 0 });
    expect(findHotelEmail).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("does not call Hunter when needs_provider arrives with a balance below the cost", async () => {
    rpc.mockResolvedValue({
      data: { status: "needs_provider", email: null, balance: 0, pipeline_added: false },
      error: null,
    });
    const result = await unlockHotelContactAction(form());
    expect(result).toEqual({ status: "insufficient_credits", email: null, balance: 0 });
    expect(findHotelEmail).not.toHaveBeenCalled();
  });
});
