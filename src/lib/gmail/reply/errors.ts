/**
 * Raised when the reply-chronology RPC surface returns a result shape B06's
 * own code never expects — a structurally malformed or unknown machine-
 * readable result. A fail-closed backstop, never the expected path.
 */
export class ReplyStructuralError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplyStructuralError";
  }
}
