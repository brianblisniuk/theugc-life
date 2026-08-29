import { NextResponse, type NextRequest } from "next/server";

import { resolveSession } from "@/lib/auth/guards";
import { completeGmailAuthorization } from "@/lib/gmail/connection.server";

/**
 * The Gmail OAuth callback.
 *
 * DELIBERATELY NOT the Supabase auth callback at /auth/callback. Signing into
 * the application and authorizing access to a creator's mailbox are different
 * security boundaries with different consequences, and sharing a route would
 * mean one set of checks guarding both.
 */
export async function GET(request: NextRequest) {
  const { origin, searchParams } = new URL(request.url);

  // A callback without an app session is refused outright. The Google
  // redirect proves something about a Google account, never about who is
  // sitting in front of this browser.
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") {
    return NextResponse.redirect(`${origin}/login?redirect=%2Fapp%2Faccount`);
  }

  const outcome = await completeGmailAuthorization({
    userId: resolution.session.userId,
    state: searchParams.get("state"),
    code: searchParams.get("code"),
    error: searchParams.get("error"),
  });

  // The redirect target comes from the stored transaction, not from the query
  // string Google echoed back, so there is nothing here an attacker can aim.
  const base = "returnPath" in outcome && outcome.returnPath ? outcome.returnPath : "/app/account";

  const status =
    outcome.result === "scope_refused" ? `scope_refused_${outcome.detail}` : outcome.result;

  const url = new URL(`${origin}${base}`);
  url.searchParams.set("gmail", status);
  if ("mailAccountId" in outcome && outcome.result === "consent_required") {
    url.searchParams.set("consent_for", outcome.mailAccountId);
  }
  return NextResponse.redirect(url.toString());
}
