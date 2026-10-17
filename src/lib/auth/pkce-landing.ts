/**
 * PKCE confirmation codes belong on `/auth/callback`. Supabase sometimes
 * appends `code` to the `next` path instead, which left
 * `/onboarding?code=…&next=%2Fonboarding` in the address bar.
 *
 * A code on any non-API document path is forwarded to `/auth/callback`.
 * The callback exchanges it and redirects to a same-origin relative `next`
 * with `code` removed. `next` is never an absolute or protocol-relative URL.
 */
import { safeSameOriginPath } from "@/lib/auth/safe-redirect";

export const AUTH_CALLBACK_PATH = "/auth/callback";

const MAX_CODE_LENGTH = 2048;

export type PkceLanding =
  { kind: "none" } | { kind: "exchange"; next: string } | { kind: "forward"; location: string };

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function isCallbackPath(pathname: string): boolean {
  return pathname === AUTH_CALLBACK_PATH;
}

/** Drop `code` from a path that already passed the same-origin check. */
function withoutCode(path: string, siteOrigin: string): string | null {
  const safe = safeSameOriginPath(path, siteOrigin);
  if (!safe) return null;
  let url: URL;
  try {
    url = new URL(safe, siteOrigin);
  } catch {
    return null;
  }
  url.searchParams.delete("code");
  const search = url.searchParams.toString();
  const rebuilt = `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
  if (isCallbackPath(url.pathname)) return null;
  return rebuilt;
}

function currentDocument(
  pathname: string,
  params: URLSearchParams,
  siteOrigin: string,
): string | null {
  const kept = new URLSearchParams(params);
  kept.delete("code");
  kept.delete("next");
  const search = kept.toString();
  return withoutCode(`${pathname}${search ? `?${search}` : ""}`, siteOrigin);
}

export function pkceLanding(input: {
  pathname: string;
  searchParams: URLSearchParams;
  siteOrigin: string;
  method?: string;
}): PkceLanding {
  const method = input.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") return { kind: "none" };
  if (isApiPath(input.pathname)) return { kind: "none" };

  const code = input.searchParams.get("code");
  if (!code || code.length > MAX_CODE_LENGTH) return { kind: "none" };
  if (/[\u0000-\u001F\u007F]/.test(code)) return { kind: "none" };

  const requested = input.searchParams.get("next");
  const fromNext = requested ? withoutCode(requested, input.siteOrigin) : null;
  const onCallback = isCallbackPath(input.pathname);
  const next =
    fromNext ??
    (onCallback ? null : currentDocument(input.pathname, input.searchParams, input.siteOrigin)) ??
    "/app";

  if (onCallback) return { kind: "exchange", next };

  let callback: URL;
  try {
    callback = new URL(AUTH_CALLBACK_PATH, input.siteOrigin);
  } catch {
    return { kind: "none" };
  }
  callback.searchParams.set("code", code);
  callback.searchParams.set("next", next);
  return { kind: "forward", location: `${callback.pathname}${callback.search}` };
}
