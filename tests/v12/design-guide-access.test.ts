/**
 * The Midnight UI guide is staff-only. A creator session is redirected.
 * Admin and editor sessions are allowed. Removing requireRole fails this.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  role: null as "creator" | "editor" | "admin" | null,
}));

class Redirected extends Error {
  constructor(public target: string) {
    super(`redirect:${target}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (target: string) => {
    throw new Redirected(target);
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () =>
        state.role
          ? { data: { user: { id: "user-1", email: "a@test.local" } }, error: null }
          : {
              data: { user: null },
              error: { name: "AuthSessionMissingError", message: "Auth session missing!" },
            },
    },
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () =>
          state.role
            ? { data: { role: state.role, email: "a@test.local" }, error: null }
            : { data: null, error: null },
      };
      return builder;
    },
  }),
}));

const { default: DesignGuidePage } = await import("@/app/(app)/app/design/page");

describe("/app/design staff gate", () => {
  beforeEach(() => {
    state.role = null;
  });

  it("redirects a creator and allows admin and editor", async () => {
    state.role = "creator";
    await expect(DesignGuidePage()).rejects.toMatchObject({ target: "/app" });

    state.role = "admin";
    await expect(DesignGuidePage()).resolves.toBeTruthy();

    state.role = "editor";
    await expect(DesignGuidePage()).resolves.toBeTruthy();
  });

  it("sends an anonymous visitor to login with the guide as the return path", async () => {
    state.role = null;
    await expect(DesignGuidePage()).rejects.toMatchObject({
      target: "/login?redirect=%2Fapp%2Fdesign",
    });
  });
});
