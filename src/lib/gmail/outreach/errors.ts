/**
 * Raised when the outreach RPC surface returns a result shape B05's own code
 * never expects — a structurally malformed or unknown machine-readable
 * result. A fail-closed backstop, never the expected path.
 */
export class OutreachStructuralError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutreachStructuralError";
  }
}
