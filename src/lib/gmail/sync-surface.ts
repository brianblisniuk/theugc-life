/**
 * How a Gmail failure is shown on a list (E05).
 *
 * A revoked token and a failed sync are errors. They are not an empty inbox.
 * D082 is unchanged: reauth_required is not a completed connection, and a
 * failed read is not "not connected".
 */
import { isUuid } from "@/lib/hotels/ids";

export type MailboxSurface =
  "connected" | "absent" | "error" | "unconfigured" | "revoked" | "sync_error";

export type MailboxProbeRow = { userId: string; connectionState: string };

export function mailboxFromProbe(input: {
  configured: boolean;
  authUserId: string;
  failed: boolean;
  data: unknown;
}): MailboxSurface {
  if (!input.configured) return "unconfigured";
  if (input.failed || !isUuid(input.authUserId) || !Array.isArray(input.data)) return "error";
  const own: MailboxProbeRow[] = [];
  for (const entry of input.data) {
    if (!entry || typeof entry !== "object") return "error";
    const row = entry as Record<string, unknown>;
    if (typeof row.user_id !== "string" || typeof row.connection_state !== "string") return "error";
    if (row.user_id === input.authUserId) {
      own.push({ userId: row.user_id, connectionState: row.connection_state });
    }
  }
  if (own.some((row) => row.connectionState === "connected")) return "connected";
  if (own.some((row) => row.connectionState === "reauth_required")) return "revoked";
  return "absent";
}

export type GmailSurface =
  { kind: "error"; reason: "read" | "revoked" | "sync" } | { kind: "empty" } | { kind: "items" };

/**
 * Zero links plus a revoked token or a sync failure is an error.
 * The same input twice is the same answer: classification is idempotent.
 */
export function gmailListSurface(input: {
  mailbox: MailboxSurface;
  linkCount: number;
  readFailed: boolean;
}): GmailSurface {
  if (input.readFailed) return { kind: "error", reason: "read" };
  if (input.mailbox === "revoked") {
    return input.linkCount === 0 ? { kind: "error", reason: "revoked" } : { kind: "items" };
  }
  if (input.mailbox === "sync_error") {
    return input.linkCount === 0 ? { kind: "error", reason: "sync" } : { kind: "items" };
  }
  if (input.mailbox === "error" && input.linkCount === 0) return { kind: "error", reason: "read" };
  if (input.linkCount === 0) return { kind: "empty" };
  return { kind: "items" };
}
