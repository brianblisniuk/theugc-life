/**
 * Liveness payload. It names no user, mailbox, token, or row.
 * A failed dependency is not reported by borrowing private data.
 */
export function healthPayload(): { status: "ok" } {
  return { status: "ok" };
}
