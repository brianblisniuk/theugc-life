/**
 * Raised when a raw message's `sanitized_payload` violates the B03 structural
 * contract so severely that deterministic normalization is impossible — for
 * example a part with no `mimeType` at all, or a `parts` field that is not an
 * array. This is a FAIL-CLOSED BACKSTOP, not the expected path: B03's own
 * `provider-shape.ts` already validates everything it writes, so a real row
 * should never trigger this. A malformed ADDRESS, REFERENCE or TEXT PART is
 * explicitly NOT this — those become evidence with an explicit parse/decode
 * status, and normalization of the rest of the message proceeds.
 */
export class NormalizationStructuralError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NormalizationStructuralError";
  }
}
