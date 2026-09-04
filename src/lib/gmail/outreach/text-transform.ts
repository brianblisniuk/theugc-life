import { CLASSIFIER_INPUT_TRANSFORM_VERSION } from "@/lib/gmail/outreach/contract";
import type { EvidenceTextPart } from "@/lib/gmail/outreach/contract";

export { CLASSIFIER_INPUT_TRANSFORM_VERSION };

/**
 * B04 deliberately preserves quoted text, signatures, and plain/HTML
 * independently. This transform is a VERSIONED HEURISTIC that turns that raw
 * evidence into classifier input — it is NOT lossless, it may abstain, and
 * its output is derived input for classification only, never a replacement
 * for the exact B04 text parts, which remain the source evidence of record.
 *
 * Preference order per message: a decoded `text/plain` part; failing that, a
 * naive tag-stripped `text/html` part (multipart/alternative's two
 * representations of the SAME content are therefore never double-counted —
 * exactly one is chosen). Quoted prior-message text and signatures are NOT
 * stripped: this transform does not attempt to distinguish newly-authored
 * text from quoted history, and B05's classifier is scored accordingly
 * (conservative, abstains rather than guesses).
 */
export function buildClassifierInputForMessage(parts: readonly EvidenceTextPart[]): string | null {
  const usable = parts.filter(
    (p) => p.decodeStatus === "decoded" || p.decodeStatus === "empty_decoded",
  );

  const plain = usable.find((p) => p.mimeType === "text/plain" && p.decodedText !== null);
  if (plain) return plain.decodedText;

  const html = usable.find((p) => p.mimeType === "text/html" && p.decodedText !== null);
  if (html && html.decodedText !== null) return stripHtmlHeuristically(html.decodedText);

  return null;
}

/**
 * A crude, versioned, non-lossless tag stripper. Never treat the result as
 * safe-renderable HTML-derived text — it exists only to feed a text
 * classifier, and it is allowed to be wrong.
 */
function stripHtmlHeuristically(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}
