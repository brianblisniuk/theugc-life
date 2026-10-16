/**
 * E2E-4 application regressions: redirects, cookies, signup text, headers,
 * share-page rate limit, dispatch errors, and sync RPC errors.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(),
}));

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

import { createServerClient } from "@supabase/ssr";

import { GET } from "@/app/auth/callback/route";
import { resetClientEnvCache } from "@/env";
import { signUp, updatePassword } from "@/lib/auth/actions";
import { safeRedirect, safeSameOriginPath } from "@/lib/auth/safe-redirect";
import { createClient } from "@/lib/supabase/server";
import { updateSession } from "@/lib/supabase/middleware";
import { AUTH_COOKIE_OPTIONS } from "@/lib/supabase/cookie-options";
import { runAccountSync } from "@/lib/gmail/sync/worker";
import { consumeShareLinkRequest, resetShareLinkRateLimit } from "@/lib/profile/share-rate-limit";

const SITE = "http://localhost:3000";

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === ".next") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
}

describe("same-origin redirects", () => {
  it("rejects a backslash, a protocol-relative path, and a control character", () => {
    expect(safeSameOriginPath("/\\evil.example", SITE)).toBeNull();
    expect(safeSameOriginPath("//evil.example", SITE)).toBeNull();
    expect(safeSameOriginPath("/app\t", SITE)).toBeNull();
    expect(safeSameOriginPath("/app\u0000", SITE)).toBeNull();
    expect(safeRedirect("/\\evil.example", SITE)).toBe("/app");
    expect(safeRedirect("//evil.example/phish", SITE)).toBe("/app");
    expect(safeSameOriginPath("/onboarding?next=1#done", SITE)).toBe("/onboarding?next=1#done");
    expect(safeSameOriginPath("https://evil.example/app", SITE)).toBeNull();
  });
});

describe("auth callback redirect", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon-test-key";
    process.env.NEXT_PUBLIC_SITE_URL = SITE;
    resetClientEnvCache();
  });

  it("sends a hostile next and a failed callback to the site origin", async () => {
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        exchangeCodeForSession: async () => ({ error: null }),
        getUser: async () => ({ data: { user: null } }),
      },
    } as never);
    const hostile = await GET(
      new NextRequest(
        `https://evil.example/auth/callback?code=one-time&next=${encodeURIComponent("/\\evil.example")}`,
      ),
    );
    expect(hostile.headers.get("location")).toBe(`${SITE}/app`);

    const failed = await GET(new NextRequest("https://evil.example/auth/callback"));
    expect(failed.headers.get("location")).toBe(`${SITE}/login?error=auth_callback`);

    const kept = await GET(
      new NextRequest("https://evil.example/auth/callback?code=one-time&next=/onboarding"),
    );
    expect(kept.headers.get("location")).toBe(`${SITE}/onboarding`);
  });
});

describe("signup and password errors", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon-test-key";
    process.env.NEXT_PUBLIC_SITE_URL = SITE;
    resetClientEnvCache();
  });

  it("returns one fixed signup string for different provider failures", async () => {
    const messages = [
      "User already registered for secret@hotel.test",
      "Password should be at least 8 characters: hunter2",
    ];
    for (const message of messages) {
      vi.mocked(createClient).mockResolvedValue({
        auth: {
          signUp: async () => ({
            data: { session: null, user: null },
            error: { message, code: "signup_rejected", name: "AuthApiError" },
          }),
        },
      } as never);
      const form = new FormData();
      form.set("email", "ada@example.test");
      form.set("password", "long-enough");
      const shown = await signUp({}, form);
      expect(shown.error).toBe("Could not create the account.");
      expect(JSON.stringify(shown)).not.toContain(message);
    }
  });

  it("does not return the provider password-update message", async () => {
    const leaked = "token eyJhbGciOi is expired";
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: async () => ({ data: { user: { id: "user-1" } } }),
        updateUser: async () => ({ error: { message: leaked, code: "weak_password" } }),
      },
    } as never);
    const form = new FormData();
    form.set("password", "long-enough");
    const shown = await updatePassword({}, form);
    expect(shown.error).toBe("Could not update the password.");
    expect(JSON.stringify(shown)).not.toContain(leaked);
  });
});

describe("session cookie and auth outage headers", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon-test-key";
    process.env.NEXT_PUBLIC_SITE_URL = SITE;
    resetClientEnvCache();
    vi.mocked(createServerClient).mockReset();
  });

  it("sets httpOnly secure lax cookies and still decorates a getUser failure", async () => {
    expect(AUTH_COOKIE_OPTIONS).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
    vi.mocked(createServerClient).mockImplementation(
      () =>
        ({
          auth: {
            getUser: async () => {
              throw new Error("auth down");
            },
          },
        }) as never,
    );
    const response = await updateSession(
      new NextRequest("https://app.example/app", {
        headers: { "x-forwarded-proto": "https, http" },
      }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=63072000; includeSubDomains",
    );
    expect(response.headers.get("permissions-policy")).toContain("geolocation=()");
    const options = vi.mocked(createServerClient).mock.calls[0]?.[2] as {
      cookieOptions?: typeof AUTH_COOKIE_OPTIONS;
    };
    expect(options.cookieOptions).toEqual(AUTH_COOKIE_OPTIONS);

    const httpOnly = await updateSession(new NextRequest("http://localhost:3000/login"));
    expect(httpOnly.headers.get("strict-transport-security")).toBeNull();
  });

  it("forwards the script nonce on the request and the response without unsafe-inline", async () => {
    vi.mocked(createServerClient).mockImplementation(
      (_url, _key, options) =>
        ({
          auth: {
            getUser: async () => {
              options?.cookies.setAll?.([
                { name: "sb-access-token", value: "token", options: { path: "/" } },
              ]);
              return {
                data: { user: { id: "11111111-1111-4111-8111-111111111111" } },
                error: null,
              };
            },
          },
        }) as never,
    );
    const nextSpy = vi.spyOn(NextResponse, "next");
    try {
      const response = await updateSession(new NextRequest("https://app.example/app"));
      const responseCsp = response.headers.get("content-security-policy") ?? "";
      const forwarded = nextSpy.mock.calls
        .map((call) => {
          const headers = call[0]?.request?.headers;
          return headers instanceof Headers ? headers.get("content-security-policy") : null;
        })
        .filter((value): value is string => typeof value === "string");
      expect(forwarded.length).toBeGreaterThan(0);
      expect(new Set(forwarded)).toEqual(new Set([responseCsp]));
      const script =
        responseCsp
          .split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith("script-src ")) ?? "";
      expect(script).toMatch(/'nonce-[A-Za-z0-9+/_-]{16,128}={0,2}'/);
      expect(script).toContain("'strict-dynamic'");
      expect(script).not.toContain("'unsafe-inline'");
      expect(responseCsp).toContain("style-src 'self' 'unsafe-inline'");
    } finally {
      nextSpy.mockRestore();
    }
  });
});

describe("client cookie and profile reads", () => {
  it("does not import the browser client or read document.cookie", () => {
    const files: string[] = [];
    walk(path.join(process.cwd(), "src"), files);
    const browserImports = files.filter((file) =>
      readFileSync(file, "utf8").includes("@/lib/supabase/client"),
    );
    const documentCookie = files.filter((file) =>
      readFileSync(file, "utf8").includes("document.cookie"),
    );
    expect(browserImports).toEqual([]);
    expect(documentCookie).toEqual([]);

    const tableReaders = files.filter((file) =>
      readFileSync(file, "utf8").includes('.from("creator_profiles")'),
    );
    expect(tableReaders.length).toBeGreaterThan(0);
    for (const file of tableReaders) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain("@supabase/supabase-js");
    }
    const middleware = readFileSync(
      path.join(process.cwd(), "src/lib/supabase/middleware.ts"),
      "utf8",
    );
    expect(middleware).toContain(
      'shareLinkClientKey(request.headers.get("x-nf-client-connection-ip"))',
    );
    expect(middleware).not.toContain("x-forwarded-for");
    const server = readFileSync(path.join(process.cwd(), "src/lib/supabase/server.ts"), "utf8");
    expect(server).toContain("cookieOptions: AUTH_COOKIE_OPTIONS");
  });
});

describe("share link map cap", () => {
  it("denies a new key once 5000 live buckets exist", () => {
    resetShareLinkRateLimit();
    for (let i = 0; i < 5000; i += 1) {
      expect(consumeShareLinkRequest(`ip-${i}`, 1_000).allowed).toBe(true);
    }
    expect(consumeShareLinkRequest("new-ip", 1_000).allowed).toBe(false);
    expect(consumeShareLinkRequest("ip-0", 1_000).allowed).toBe(true);
    resetShareLinkRateLimit();
  });
});

describe("sync rpc errors", () => {
  it("throws the step name and not the database message", async () => {
    const secret = "postgres-detail-token";
    const attempt = runAccountSync(
      {
        userId: "11111111-1111-4111-8111-111111111111",
        mailAccountId: "22222222-2222-4222-8222-222222222222",
      },
      {
        db: {
          rpc: async () => ({ data: null, error: { message: secret, code: "XX000" } }),
        } as never,
        gmail: {} as never,
        accessToken: async () => ({ result: "not_connected" }),
        sleep: async () => undefined,
        random: () => 0,
        maxSteps: 1,
        leaseSeconds: 30,
        runPipeline: async () => undefined,
      },
    );
    await expect(attempt).rejects.toMatchObject({
      name: "SyncRpcError",
      message: "gmail_incremental_sync_claim_step failed",
    });
  });
});
