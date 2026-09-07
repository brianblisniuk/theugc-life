import { buildClassifierInputForMessage } from "@/lib/gmail/outreach/text-transform";
import type { EvidenceTextPart } from "@/lib/gmail/outreach/contract";
import type { ReplyEvidenceTextPart } from "@/lib/gmail/reply/contract";
import { TEXT_TRANSFORM_VERSION } from "@/lib/gmail/reply/contract";

export { TEXT_TRANSFORM_VERSION };

/**
 * B06 reuses B05's quote/signature-stripping primitive UNMODIFIED (contract
 * §13: "Reuse already-correct B05 text-transform primitives if they are
 * semantically appropriate. Do not fork a second subtly different quote-
 * stripper without reason.") — the need is identical: given a message's
 * decoded text/plain or text/html parts, separate confident-authorship new
 * text from quoted history/signatures. `buildClassifierInputForMessage` only
 * reads `mimeType`/`decodeStatus`/`decodedText` per part; `normalizedMessageId`
 * and `partPath` are unused by its logic, so a minimal shim satisfies its
 * type without needing those B04 row identities here.
 */
export function extractReplyTextForMessage(parts: readonly ReplyEvidenceTextPart[]): {
  cleanText: string | null;
  uncertainAuthorshipText: string | null;
} {
  const shimmed: EvidenceTextPart[] = parts.map((p) => ({
    normalizedMessageId: p.providerMessageId,
    partPath: [],
    mimeType: p.mimeType,
    decodeStatus: p.decodeStatus,
    decodedText: p.decodedText,
  }));
  return buildClassifierInputForMessage(shimmed);
}
