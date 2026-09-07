import { CLASSIFIER_INPUT_TRANSFORM_VERSION } from "@/lib/gmail/outreach/contract";
import type { EvidenceTextPart } from "@/lib/gmail/outreach/contract";

export { CLASSIFIER_INPUT_TRANSFORM_VERSION };

/**
 * `cleanText` — confident-authorship content the classifier may treat as the
 * creator's own words. `uncertainAuthorshipText` — a trailing block (EXTERNAL
 * AUDIT AMENDMENT #2, Finding 7) that LOOKS like a signature/closing but does
 * not match any RFC-recognized delimiter, so `stripQuotedHistoryAndSignature`
 * below cannot safely remove it outright without risking real content loss.
 * Both non-null halves come from the SAME message; `uncertainAuthorshipText`
 * is null when no such tail was detected.
 */
export interface ClassifierInputForMessage {
  cleanText: string | null;
  uncertainAuthorshipText: string | null;
}

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
export function buildClassifierInputForMessage(
  parts: readonly EvidenceTextPart[],
): ClassifierInputForMessage {
  const usable = parts.filter(
    (p) => p.decodeStatus === "decoded" || p.decodeStatus === "empty_decoded",
  );

  const plain = usable.find((p) => p.mimeType === "text/plain" && p.decodedText !== null);
  if (plain) {
    if (plain.decodedText === null) return { cleanText: null, uncertainAuthorshipText: null };
    return splitUncertainAuthorshipTail(stripQuotedHistoryAndSignature(plain.decodedText));
  }

  const html = usable.find((p) => p.mimeType === "text/html" && p.decodedText !== null);
  if (html && html.decodedText !== null) {
    return splitUncertainAuthorshipTail(
      stripQuotedHistoryAndSignature(stripHtmlHeuristically(html.decodedText)),
    );
  }

  return { cleanText: null, uncertainAuthorshipText: null };
}

/**
 * `stripQuotedHistoryAndSignature` only recognizes RFC 3676's `-- ` signature
 * delimiter and a handful of quote introducers. An ordinary closing —
 * "Thanks,\nJane Doe\nUGC Creator\nTravel Influencer" — matches none of
 * those, so it passes through untouched and the classifier could read
 * `influencer`/`ugc` from a self-description line as if it were the actual
 * pitch. This heuristic finds a common VALEDICTION line (a closing
 * pleasantry with nothing after it but a short name/title block) and treats
 * everything from that line to the end as UNCERTAIN authorship — real
 * content that must not, by itself, drive a positive classification. Unlike
 * the RFC-delimiter case, this text is not discarded (a legitimate pitch can
 * genuinely end with "Thanks, let me know!" and more substance) — it is only
 * downgraded to a lower evidentiary standard.
 */
const VALEDICTION_PATTERN =
  /^\s*(thanks(?: so much| a lot| in advance)?|thank you|best(?: regards| wishes)?|kind regards|warm(?:ly)?(?: regards)?|regards|sincerely|cheers|talk soon|looking forward(?: to hearing from you)?)[,!.]?\s*$/i;

function splitUncertainAuthorshipTail(text: string): ClassifierInputForMessage {
  if (text.trim() === "") return { cleanText: text, uncertainAuthorshipText: null };

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!VALEDICTION_PATTERN.test(lines[i]!)) continue;

    // A signature TAIL requires a name/title block AFTER the valediction —
    // "Thanks!" as the message's own last line is just how a short reply
    // ends, not a signature. Nothing follows means no split at all.
    const afterValediction = lines
      .slice(i + 1)
      .join("\n")
      .trim();
    if (afterValediction === "") break;

    const clean = lines.slice(0, i).join("\n").trim();
    return {
      cleanText: clean === "" ? null : clean,
      uncertainAuthorshipText: lines.slice(i).join("\n").trim(),
    };
  }

  return { cleanText: text, uncertainAuthorshipText: null };
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
 *
 * EXTERNAL AUDIT AMENDMENT #4, Finding 3: this used to strip every tag and
 * collapse ALL whitespace (including newlines) into single spaces before
 * `stripQuotedHistoryAndSignature`/`splitUncertainAuthorshipTail` ever ran —
 * both of those are LINE-based heuristics, so flattening an HTML message to
 * one run-on line destroyed the exact structural boundaries they depend on.
 * A quoted `<blockquote>` reply could merge into what then read as the
 * creator's own trailing sentence. Block-level structure is now preserved
 * (or cut) BEFORE that collapse: a `<blockquote>` — the standard Gmail/
 * Outlook quoted-history container — is cut at its first occurrence exactly
 * like the plain-text transform cuts at its own quote introducers, and
 * `<br>`/block-closing tags become real newlines so the line-based
 * heuristics downstream still see the message's actual shape.
 */
function stripHtmlHeuristically(html: string): string {
  const blockquoteIndex = html.search(/<blockquote\b/i);
  const withoutQuotedHistory = blockquoteIndex === -1 ? html : html.slice(0, blockquoteIndex);

  return withoutQuotedHistory
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|table|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
