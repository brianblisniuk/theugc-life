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
 * exactly one is chosen).
 *
 * EXTERNAL AUDIT AMENDMENT #1, Finding 10: quoted prior-message text and
 * signatures ARE now heuristically truncated (`stripQuotedHistoryAndSignature`
 * below) — the original version left them in, which meant the classifier
 * could read the OTHER party's quoted words (a hotel's own "we'd love to
 * collaborate") or a signature line ("Jane Doe — UGC Creator") as if the
 * creator had authored them, and call a plain acknowledgement `qualified_
 * outreach`. This heuristic is versioned and explicitly NOT lossless: an
 * unrecognized quote/reply format is not caught, and a creator who genuinely
 * writes something resembling `On ... wrote:` loses that line. B05's
 * classifier is scored accordingly — conservative, abstains rather than
 * guesses on the truncated result.
 */
export function buildClassifierInputForMessage(parts: readonly EvidenceTextPart[]): string | null {
  const usable = parts.filter(
    (p) => p.decodeStatus === "decoded" || p.decodeStatus === "empty_decoded",
  );

  const plain = usable.find((p) => p.mimeType === "text/plain" && p.decodedText !== null);
  if (plain)
    return plain.decodedText === null ? null : stripQuotedHistoryAndSignature(plain.decodedText);

  const html = usable.find((p) => p.mimeType === "text/html" && p.decodedText !== null);
  if (html && html.decodedText !== null) {
    return stripQuotedHistoryAndSignature(stripHtmlHeuristically(html.decodedText));
  }

  return null;
}

/**
 * Truncates at the EARLIEST recognized quote-block or signature boundary,
 * keeping only what precedes it. Recognizes common Gmail/Outlook quote
 * introducers, a contiguous run of `>`-prefixed lines, and the RFC 3676
 * signature delimiter (`-- ` alone on its line). Deliberately conservative:
 * an unrecognized format passes through untouched, matching this
 * transform's existing "not lossless, may abstain" contract rather than
 * inventing false confidence about a boundary it cannot actually find.
 */
function stripQuotedHistoryAndSignature(text: string): string {
  const lines = text.split(/\r?\n/);

  const QUOTE_INTRODUCER_PATTERNS: readonly RegExp[] = [
    /^\s*On\s.+\swrote:\s*$/i,
    /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
    /^\s*-{2,}\s*Forwarded message\s*-{2,}\s*$/i,
    /^\s*From:\s.+$/i,
  ];
  const SIGNATURE_DELIMITER = /^-- ?$/;

  let cutIndex: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (SIGNATURE_DELIMITER.test(line) || QUOTE_INTRODUCER_PATTERNS.some((p) => p.test(line))) {
      cutIndex = i;
      break;
    }
    // A contiguous run of quoted-reply lines (`>` prefix) is a quote block
    // even with no introducer line (some clients omit it).
    if (/^\s*>/.test(line)) {
      cutIndex = i;
      break;
    }
  }

  const kept = cutIndex === null ? lines : lines.slice(0, cutIndex);
  return kept.join("\n").trim();
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
