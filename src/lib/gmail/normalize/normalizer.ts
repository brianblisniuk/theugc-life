import { parseParticipants } from "@/lib/gmail/normalize/address-parser";
import {
  B04_ADDRESS_HEADER_NAMES,
  B04_TEXT_MIME_TYPES,
  type AddressHeaderName,
  type ComputedNormalization,
  type NormalizedHeaderInput,
  type NormalizedParticipantInput,
  type NormalizedReferenceTokenInput,
  type NormalizedTextPartInput,
  type RawSanitizedMessage,
  type RawSanitizedPart,
  type ReferenceHeaderName,
  B04_REFERENCE_HEADER_NAMES,
} from "@/lib/gmail/normalize/contract";
import { decodeTextPart } from "@/lib/gmail/normalize/mime-decode";
import { NormalizationStructuralError } from "@/lib/gmail/normalize/errors";
import { parseReferenceTokens } from "@/lib/gmail/normalize/reference-tokens";

/**
 * THE B04 NORMALIZATION CORE.
 *
 * Pure and deterministic: the same `sanitized_payload` in produces the same
 * headers/participants/reference-tokens/text-parts out, every time. No clock,
 * no randomness, no I/O — exactly B03's sanitizer's own discipline, applied
 * one layer up. This function performs NO database access; the caller (see
 * `service.server.ts`) is what turns its output into a `gmail_normalize_
 * commit_message` call.
 */

const addressHeaderSet = new Set<string>(B04_ADDRESS_HEADER_NAMES);
const referenceHeaderSet = new Set<string>(B04_REFERENCE_HEADER_NAMES);
const textMimeSet = new Set<string>(B04_TEXT_MIME_TYPES);

function occurrenceValues(headers: RawSanitizedPart["headers"], name: string): string[] {
  return (headers ?? []).filter((h) => h.name === name).map((h) => h.value);
}

function walkTextParts(part: unknown, path: number[], out: NormalizedTextPartInput[]): void {
  if (!part || typeof part !== "object") {
    throw new NormalizationStructuralError(
      `MIME part at path [${path.join(",")}] is not an object`,
    );
  }
  const p = part as RawSanitizedPart;
  if (typeof p.mimeType !== "string" || p.mimeType.length === 0) {
    throw new NormalizationStructuralError(`MIME part at path [${path.join(",")}] has no mimeType`);
  }

  if (textMimeSet.has(p.mimeType)) {
    const contentTypeValues = occurrenceValues(p.headers, "content-type");
    const contentDispositionValues = occurrenceValues(p.headers, "content-disposition");
    const contentTransferEncodingValues = occurrenceValues(p.headers, "content-transfer-encoding");
    const b03Omitted = p.contentOmitted === true;
    const bodyData = typeof p.body?.data === "string" ? p.body.data : null;

    const decoded = decodeTextPart({ bodyData, b03Omitted, contentTypeValues });

    out.push({
      part_path: [...path],
      mime_type: p.mimeType as "text/plain" | "text/html",
      content_type_values: contentTypeValues,
      content_disposition_values: contentDispositionValues,
      content_transfer_encoding_values: contentTransferEncodingValues,
      declared_charset: decoded.declaredCharset,
      charset_source: decoded.charsetSource,
      body_data_present: bodyData !== null,
      b03_omitted: b03Omitted,
      b03_omission_reason: p.omissionReason ?? null,
      decode_status: decoded.decodeStatus,
      decoded_text: decoded.decodedText,
    });
  }

  if (p.parts !== undefined) {
    if (!Array.isArray(p.parts)) {
      throw new NormalizationStructuralError(
        `MIME part at path [${path.join(",")}] has a non-array "parts"`,
      );
    }
    p.parts.forEach((child, index) => walkTextParts(child, [...path, index], out));
  }
}

export function computeNormalization(sanitizedPayload: RawSanitizedMessage): ComputedNormalization {
  if (!Array.isArray(sanitizedPayload.message_headers)) {
    throw new NormalizationStructuralError("sanitized_payload.message_headers is not an array");
  }

  const headers: NormalizedHeaderInput[] = [];
  const participants: NormalizedParticipantInput[] = [];
  const referenceTokens: NormalizedReferenceTokenInput[] = [];
  const occurrenceCounts = new Map<string, number>();

  sanitizedPayload.message_headers.forEach((entry, globalOrder) => {
    if (typeof entry?.name !== "string" || typeof entry?.value !== "string") {
      throw new NormalizationStructuralError(
        `message header at position ${globalOrder} is malformed`,
      );
    }
    const name = entry.name;
    const occurrenceIndex = occurrenceCounts.get(name) ?? 0;
    occurrenceCounts.set(name, occurrenceIndex + 1);

    headers.push({
      header_name: name,
      occurrence_index: occurrenceIndex,
      global_order: globalOrder,
      raw_value: entry.value,
    });

    if (addressHeaderSet.has(name)) {
      participants.push(
        ...parseParticipants(name as AddressHeaderName, occurrenceIndex, entry.value),
      );
    }
    if (referenceHeaderSet.has(name)) {
      referenceTokens.push(
        ...parseReferenceTokens(name as ReferenceHeaderName, occurrenceIndex, entry.value),
      );
    }
  });

  const textParts: NormalizedTextPartInput[] = [];
  walkTextParts(sanitizedPayload.payload, [], textParts);

  return { headers, participants, referenceTokens, textParts };
}
