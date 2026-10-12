/** A B07 payload or RPC result the rules/service contract cannot represent. */
export class CommercialStructuralError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommercialStructuralError";
  }
}
