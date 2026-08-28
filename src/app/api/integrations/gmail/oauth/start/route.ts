import { NextResponse, type NextRequest } from "next/server";

import { resolveSession } from "@/lib/auth/guards";
import { safeReturnPath, startGmailAuthorization } from "@/lib/gmail/connection.server";

/**
 * Begin a Gmail authorization.
 *
 * A GET that redirects, because it is reached by a link from the account page
 * and its whole job is to hand the browser to Google. It changes no product
 * state a replay could corrupt: each call mints a fresh single-use transaction.
 */
export async function GET(request: NextRequest) {
  const { origin, searchParams } = new URL(request.url);

  // Never trust a user id, a mail account owner or an email from the request.
  // The session is the only identity, and service-role work happens only after
  // it is established.
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") {
    return NextResponse.redirect(`${origin}/login?redirect=%2Fapp%2Faccount`);
  }

  const purposeParam = searchParams.get("purpose");
  const purpose = purposeParam === "reconnect" ? "reconnect" : "connect";
  const target = searchParams.get("mail_account_id");

  const started = await startGmailAuthorization({
    userId: resolution.session.userId,
    purpose,
    targetMailAccountId: target,
    // Sanitized here as well as in the database: relative, same-origin only.
    returnPath: safeReturnPath(searchParams.get("return_to")) ?? "/app/account",
  });

  if (started.result === "ok") {
    return NextResponse.redirect(started.authorizationUrl);
  }

  const reason = started.result === "not_configured" ? "gmail_not_configured" : "gmail_bad_target";
  return NextResponse.redirect(`${origin}/app/account?gmail=${reason}`);
}
