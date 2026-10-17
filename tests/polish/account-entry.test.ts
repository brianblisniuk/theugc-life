/**
 * Favicon, signup confirmation, onboarding copy, and the PKCE landing URL.
 * `next` is a same-origin relative path. A code is not left on the page.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  unstable_rethrow: (error: unknown) => {
    if (error instanceof Error && error.message.startsWith("REDIRECT:")) throw error;
  },
}));

import { GET } from "@/app/auth/callback/route";
import { resetClientEnvCache } from "@/env";
import { resendSignupConfirmation, signUp } from "@/lib/auth/actions";
import { pkceLanding } from "@/lib/auth/pkce-landing";
import {
  CONFIRM_SENTENCE,
  RESEND_COOLDOWN_MS,
  RESEND_ERROR,
  cooldownRemaining,
  resendDecision,
  signupEmailRedirectTo,
  signupResendRequest,
} from "@/lib/auth/signup-confirm";
import { APPLE_ICON_SIZE, ICON_SIZE, MARK_DARK, MARK_LIME } from "@/lib/brand/colors";
import { encodeIco, markPixel } from "@/lib/brand/mark";
import { createClient } from "@/lib/supabase/server";
import { updateSession } from "@/lib/supabase/middleware";

const SITE = "http://localhost:3000";
const ROOT = path.resolve(__dirname, "../..");

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

describe("favicon mark", () => {
  it("is a lime disk on the midnight field, with a 180px apple icon and a real ico", () => {
    expect(ICON_SIZE).toBe(32);
    expect(APPLE_ICON_SIZE).toBe(180);
    expect(MARK_LIME).toBe("#D1FF02");
    expect(MARK_DARK).toBe("#0C1110");
    expect(markPixel(0, 0, 32)).toEqual([0x0c, 0x11, 0x10, 255]);
    expect(markPixel(16, 16, 32)).toEqual([0xd1, 0xff, 0x02, 255]);
    expect(markPixel(90, 90, 180)).toEqual([0xd1, 0xff, 0x02, 255]);

    const ico = readFileSync(path.join(ROOT, "src/app/favicon.ico"));
    expect(ico.subarray(0, 4)).toEqual(Buffer.from([0x00, 0x00, 0x01, 0x00]));
    expect(ico.readUInt16LE(4)).toBe(2);
    expect(Buffer.compare(ico, encodeIco([16, 32]))).toBe(0);

    expect(read("src/app/icon.tsx")).toContain("ICON_SIZE");
    expect(read("src/app/apple-icon.tsx")).toContain("APPLE_ICON_SIZE");
    const image = read("src/lib/brand/mark-image.tsx");
    expect(image).toContain("MARK_LIME");
    expect(image).toContain("MARK_DARK");
  });
});

describe("signup confirmation", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon-test-key";
    process.env.NEXT_PUBLIC_SITE_URL = SITE;
    resetClientEnvCache();
  });

  it("returns the accepted address when confirmation is still required", async () => {
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        signUp: async () => ({
          data: { session: null, user: { id: "user-1" } },
          error: null,
        }),
      },
    } as never);
    const form = new FormData();
    form.set("email", "ada@example.test");
    form.set("password", "long-enough");
    const shown = await signUp({}, form);
    expect(shown.confirmEmail).toBe("ada@example.test");
    expect(shown.message).toBe(CONFIRM_SENTENCE);
    expect(shown.error).toBeUndefined();
    expect(shown.redirectTo).toBeUndefined();
  });

  it("does not ask for email confirmation when a session already exists", async () => {
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        signUp: async () => ({
          data: { session: { access_token: "token" }, user: { id: "user-1" } },
          error: null,
        }),
      },
    } as never);
    const form = new FormData();
    form.set("email", "ada@example.test");
    form.set("password", "long-enough");
    const shown = await signUp({}, form);
    expect(shown.redirectTo).toBe("/onboarding");
    expect(shown.confirmEmail).toBeUndefined();
  });

  it("resends a signup confirmation to that address, with a 60 second cooldown", () => {
    expect(RESEND_COOLDOWN_MS).toBe(60_000);
    expect(signupEmailRedirectTo(SITE)).toBe(`${SITE}/auth/callback?next=/onboarding`);
    expect(signupResendRequest("ada@example.test", SITE)).toEqual({
      type: "signup",
      email: "ada@example.test",
      options: { emailRedirectTo: `${SITE}/auth/callback?next=/onboarding` },
    });
    expect(signupResendRequest("not an email", SITE)).toBeNull();
    expect(signupResendRequest("ada@example.test\n", SITE)).toBeNull();
    expect(cooldownRemaining(0, 60_000)).toBe(60);
    expect(cooldownRemaining(59_001, 60_000)).toBe(1);
    expect(cooldownRemaining(60_000, 60_000)).toBe(0);
    expect(resendDecision({ nowMs: 0, untilMs: 60_000, sending: false })).toBe("wait");
    expect(resendDecision({ nowMs: 60_000, untilMs: 60_000, sending: true })).toBe("wait");
    expect(resendDecision({ nowMs: 60_000, untilMs: 60_000, sending: false })).toBe("send");

    const screen = read("src/components/signup-screen.tsx");
    expect(screen).toContain("Resend email");
    expect(screen).toContain("Use a different email");
    expect(screen).toContain("resendSignupConfirmation");
    expect(screen).not.toContain("@/lib/supabase/client");
    expect(screen).toContain("CONFIRM_SENTENCE");
    expect(screen).toContain("Check your email");
    const action = read("src/lib/auth/actions.ts");
    expect(action).toContain('type: "signup"');
    expect(action).toContain("auth.resend");
  });

  it("calls auth.resend once per address inside the cooldown and hides the provider error", async () => {
    const calls: unknown[] = [];
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        resend: async (args: unknown) => {
          calls.push(args);
          return { error: null };
        },
      },
    } as never);
    const email = "ada-resend@example.test";
    expect(await resendSignupConfirmation(email)).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        type: "signup",
        email,
        options: { emailRedirectTo: `${SITE}/auth/callback?next=/onboarding` },
      },
    ]);
    expect(await resendSignupConfirmation(email)).toEqual({ error: RESEND_ERROR });
    expect(calls).toHaveLength(1);

    const leaked = "mailbox secret@hotel.test is over the limit";
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        resend: async () => ({ error: { message: leaked, code: "over_email_send_rate_limit" } }),
      },
    } as never);
    const failed = await resendSignupConfirmation("bea-resend@example.test");
    expect(failed).toEqual({ error: RESEND_ERROR });
    expect(JSON.stringify(failed)).not.toContain(leaked);
    expect(JSON.stringify(failed)).not.toContain("secret@hotel.test");
  });
});

describe("onboarding copy", () => {
  it("points at the goal and destination picker", () => {
    const page = read("src/app/(auth)/onboarding/page.tsx");
    expect(page).toContain("Next, pick your goal and first destination.");
    expect(page).not.toContain("connect Gmail");
    expect(page).not.toContain("create a trip");
    const home = read("src/app/(app)/app/page.tsx");
    expect(home).toContain("Start");
    expect(home).not.toContain("line-through");
    expect(home).toContain('d="m5 12 5 5L20 7"');
  });
});

describe("pkce landing", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon-test-key";
    process.env.NEXT_PUBLIC_SITE_URL = SITE;
    resetClientEnvCache();
  });

  it("forwards a code that landed on /onboarding and strips it from the final path", () => {
    const landed = pkceLanding({
      pathname: "/onboarding",
      searchParams: new URLSearchParams({
        code: "one-time",
        next: "/onboarding",
      }),
      siteOrigin: SITE,
    });
    expect(landed.kind).toBe("forward");
    if (landed.kind !== "forward") return;
    const forwarded = new URL(landed.location, SITE);
    expect(forwarded.origin).toBe(SITE);
    expect(forwarded.pathname).toBe("/auth/callback");
    expect(forwarded.searchParams.get("code")).toBe("one-time");
    expect(forwarded.searchParams.get("next")).toBe("/onboarding");

    const exchange = pkceLanding({
      pathname: "/auth/callback",
      searchParams: forwarded.searchParams,
      siteOrigin: SITE,
    });
    expect(exchange).toEqual({ kind: "exchange", next: "/onboarding" });
  });

  it("rejects an open redirect and keeps a code off the api and off non-GET requests", () => {
    const hostile = [
      "https://evil.example/onboarding",
      "//evil.example",
      "/\\evil.example",
      "/onboarding\t",
      "/onboarding\u0000",
    ];
    for (const next of hostile) {
      const landing = pkceLanding({
        pathname: "/onboarding",
        searchParams: new URLSearchParams({ code: "one-time", next }),
        siteOrigin: SITE,
      });
      expect(landing.kind).toBe("forward");
      if (landing.kind !== "forward") continue;
      const url = new URL(landing.location, SITE);
      expect(url.origin).toBe(SITE);
      expect(url.searchParams.get("next")).toBe("/onboarding");
      expect(url.searchParams.get("next")).not.toContain("evil");
    }

    expect(
      pkceLanding({
        pathname: "/api/integrations/gmail/oauth/callback",
        searchParams: new URLSearchParams({ code: "gmail-code" }),
        siteOrigin: SITE,
      }),
    ).toEqual({ kind: "none" });

    expect(
      pkceLanding({
        pathname: "/onboarding",
        searchParams: new URLSearchParams({ code: "one-time", next: "/onboarding" }),
        siteOrigin: SITE,
        method: "POST",
      }),
    ).toEqual({ kind: "none" });

    const dirtyNext = pkceLanding({
      pathname: "/auth/callback",
      searchParams: new URLSearchParams({
        code: "one-time",
        next: "/onboarding?code=leftover",
      }),
      siteOrigin: SITE,
    });
    expect(dirtyNext).toEqual({ kind: "exchange", next: "/onboarding" });

    const callbackLoop = pkceLanding({
      pathname: "/auth/callback",
      searchParams: new URLSearchParams({ code: "one-time", next: "/auth/callback?code=again" }),
      siteOrigin: SITE,
    });
    expect(callbackLoop).toEqual({ kind: "exchange", next: "/app" });
  });

  it("keeps an unrelated query when the code lands on that document", () => {
    const landing = pkceLanding({
      pathname: "/app/discover",
      searchParams: new URLSearchParams({ destination: "bali", code: "abc+def/ghi=" }),
      siteOrigin: SITE,
    });
    expect(landing.kind).toBe("forward");
    if (landing.kind !== "forward") return;
    const url = new URL(landing.location, SITE);
    expect(url.searchParams.get("code")).toBe("abc+def/ghi=");
    expect(url.searchParams.get("next")).toBe("/app/discover?destination=bali");
  });

  it("exchanges on the callback and redirects to a clean onboarding URL", async () => {
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        exchangeCodeForSession: async () => ({ error: null }),
        getUser: async () => ({ data: { user: null } }),
      },
    } as never);
    const response = await GET(
      new NextRequest(
        `${SITE}/auth/callback?code=one-time&next=${encodeURIComponent("/onboarding?code=leftover")}`,
      ),
    );
    const location = response.headers.get("location");
    expect(location).toBe(`${SITE}/onboarding`);
    expect(location).not.toContain("code=");
  });

  it("forwards a code that arrived on another host to the site callback", async () => {
    const response = await updateSession(
      new NextRequest(
        `https://evil.example/onboarding?code=one-time&next=${encodeURIComponent("https://evil.example/phish")}`,
      ),
    );
    expect(response.headers.get("location")).toBe(
      `${SITE}/auth/callback?code=one-time&next=%2Fonboarding`,
    );
    expect(response.headers.get("location")).not.toContain("evil.example");
  });
});
