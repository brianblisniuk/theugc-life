"use server";

import { revalidatePath } from "next/cache";

import { requireUser } from "@/lib/auth/guards";
import {
  disconnectGmailAccount,
  grantPrivateProcessingConsent,
} from "@/lib/gmail/connection.server";

/**
 * The two Gmail actions a creator can take from the account page.
 *
 * Both establish the authenticated user FIRST and pass that id down; neither
 * accepts an owner from the form. The mail account id does arrive from the
 * browser, but it is only ever used inside a query that also constrains
 * `user_id`, so naming somebody else's mailbox finds nothing rather than acting
 * on it. Service role is a capability, not an authorization.
 */

export interface GmailActionState {
  status: "idle" | "ok" | "error";
  message?: string;
}

export async function grantGmailConsentAction(
  _prev: GmailActionState,
  formData: FormData,
): Promise<GmailActionState> {
  const session = await requireUser("/app/account");
  const mailAccountId = String(formData.get("mail_account_id") ?? "");
  if (!mailAccountId) return { status: "error", message: "Missing mailbox." };

  // The policy version, consent text and digest are server constants. Nothing
  // about WHAT was consented to comes from this form — only that it was.
  const outcome = await grantPrivateProcessingConsent({
    userId: session.userId,
    mailAccountId,
  });

  revalidatePath("/app/account");

  switch (outcome.result) {
    case "connected":
      return { status: "ok", message: "Gmail connected." };
    case "no_credential":
      return {
        status: "error",
        message: "That mailbox has no stored authorization. Reconnect it and try again.",
      };
    case "account_retired":
      return {
        status: "error",
        message: "That mailbox was deleted. Connect the Google account again to start fresh.",
      };
    case "consent_not_applicable":
      // The mailbox is not waiting on this decision any more — most often
      // because the person pressed Disconnect after opening this form. The newer
      // decision stands, and nothing was recorded.
      return {
        status: "error",
        message: "That mailbox is no longer waiting for this permission. Nothing was changed.",
      };
    default:
      return { status: "error", message: "Could not record your consent. Please try again." };
  }
}

export async function disconnectGmailAction(
  _prev: GmailActionState,
  formData: FormData,
): Promise<GmailActionState> {
  const session = await requireUser("/app/account");
  const mailAccountId = String(formData.get("mail_account_id") ?? "");
  if (!mailAccountId) return { status: "error", message: "Missing mailbox." };

  const outcome = await disconnectGmailAccount({
    userId: session.userId,
    mailAccountId,
  });

  revalidatePath("/app/account");

  switch (outcome.result) {
    case "disconnected":
      return {
        status: "ok",
        message:
          "Gmail disconnected. Your existing data was kept — deletion is a separate request.",
      };
    case "provider_unavailable":
      // We could not confirm with Google that the token is dead, so we do not
      // claim it is. Saying "disconnected" here would be the one lie this whole
      // flow is built to avoid.
      //
      // Nor is "nothing was changed" true any more, and it used to be said here.
      // The prepare step runs BEFORE the network call by design: the mailbox is
      // already `disconnecting`, its in-flight OAuth flows are already cancelled,
      // and no processing happens from that state. What has not happened is the
      // confirmation from Google.
      return {
        status: "error",
        message:
          "Google has not confirmed the disconnection yet. Gmail processing is stopped while we finish disconnecting it — try Disconnect again.",
      };
    case "deletion_in_progress":
      // A distinct outcome that used to fall through to "not found", which is a
      // different and misleading thing to tell someone whose deletion request is
      // running right now.
      return {
        status: "error",
        message: "A deletion request is already in progress for this Gmail account.",
      };
    case "not_configured":
      return { status: "error", message: "Gmail is not configured on this deployment." };
    default:
      return { status: "error", message: "That mailbox was not found." };
  }
}
