/**
 * Cheap injection check (D166, D167).
 *
 * This does not call a model. A match is refused before any paid request
 * and recorded as an abuse signal by the caller.
 */

const PATTERNS = [
  /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above)\s+instructions/i,
  /disregard\s+.{0,40}instructions/i,
  /\bsystem\s+prompt\b/i,
  /\byou\s+are\s+now\b/i,
  /\bdeveloper\s+message\b/i,
  /<\s*\/?\s*system\s*>/i,
  /\bdo\s+not\s+follow\s+the\s+system\b/i,
];

export function looksLikeInjection(text: string): boolean {
  return PATTERNS.some((pattern) => pattern.test(text));
}

export function briefLooksLikeInjection(parts: readonly string[]): boolean {
  return parts.some((part) => looksLikeInjection(part));
}
