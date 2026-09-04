import type { CharsetSource, TextPartDecodeStatus } from "@/lib/gmail/normalize/contract";

/**
 * GMAIL BODY DATA DECODING — THE LOCKED V1 RULE.
 *
 * Gmail's API returns `MessagePartBody.data` as a base64url-encoded string —
 * the TRANSPORT encoding of the body Gmail already parsed out of the raw MIME
 * message. B04 decodes that encoding EXACTLY ONCE, then interprets the
 * resulting bytes under the declared (or, absent one, strict UTF-8 fallback)
 * charset.
 *
 * `Content-Transfer-Encoding` is preserved as SOURCE MIME EVIDENCE — see the
 * caller, which stores every surviving occurrence verbatim — and is NEVER
 * inspected here to trigger a second decode. A body whose Content-Transfer-
 * Encoding header says `base64` or `quoted-printable` has ALREADY been
 * unwrapped by Gmail before `data` was populated; re-decoding it a second time
 * on the strength of that header would corrupt content that decoded correctly
 * the first time, including the case where the correctly-decoded bytes
 * themselves happen to look like base64 text.
 */

const BASE64URL_SHAPE = /^[A-Za-z0-9_-]*$/;

function decodeBase64Url(data: string): Buffer | null {
  if (!BASE64URL_SHAPE.test(data)) return null;
  // Un-padded base64: every 4 input characters decode to 3 bytes, so a
  // remainder of exactly 1 character can never be valid.
  if (data.length % 4 === 1) return null;
  return Buffer.from(data, "base64url");
}

/**
 * Extract the CHARSET parameter from every surviving `Content-Type`
 * occurrence, conservatively. Distinct, non-empty, case-insensitively
 * differing declarations are a CONFLICT — never resolved by "first wins" or
 * "last wins", the exact lesson B03's MIME safety work already paid for.
 */
const CHARSET_PARAM = /charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;]+))/i;

export function extractDeclaredCharset(
  contentTypeValues: readonly string[],
): { conflicting: false; charset: string | null } | { conflicting: true } {
  const declared = new Map<string, string>(); // lowercased -> as-first-seen
  for (const value of contentTypeValues) {
    const match = CHARSET_PARAM.exec(value);
    const raw = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
    if (raw.length === 0) continue;
    const key = raw.toLowerCase();
    if (!declared.has(key)) declared.set(key, raw);
  }
  if (declared.size > 1) return { conflicting: true };
  if (declared.size === 0) return { conflicting: false, charset: null };
  return { conflicting: false, charset: [...declared.values()][0]! };
}

export interface DecodeResult {
  declaredCharset: string | null;
  charsetSource: CharsetSource | null;
  decodeStatus: TextPartDecodeStatus;
  decodedText: string | null;
}

function decodeBytes(
  bytes: Buffer,
  label: string,
): { text: string } | { failed: true } | { unsupported: true } {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label, { fatal: true });
  } catch {
    return { unsupported: true };
  }
  try {
    return { text: decoder.decode(bytes) };
  } catch {
    return { failed: true };
  }
}

/**
 * Decode ONE text part's body data. `hasBodyData` and `b03Omitted` come from
 * the sanitized payload's own shape — `body.data` non-empty, and
 * `contentOmitted === true`, respectively — never re-derived here.
 */
export function decodeTextPart(input: {
  bodyData: string | null;
  b03Omitted: boolean;
  contentTypeValues: readonly string[];
}): DecodeResult {
  if (input.bodyData === null) {
    return {
      declaredCharset: null,
      charsetSource: null,
      decodeStatus: input.b03Omitted ? "content_omitted_by_b03" : "body_absent",
      decodedText: null,
    };
  }

  const bytes = decodeBase64Url(input.bodyData);
  if (!bytes) {
    return {
      declaredCharset: null,
      charsetSource: null,
      decodeStatus: "invalid_base64url",
      decodedText: null,
    };
  }

  const declared = extractDeclaredCharset(input.contentTypeValues);
  if (declared.conflicting) {
    return {
      declaredCharset: null,
      charsetSource: null,
      decodeStatus: "conflicting_charset",
      decodedText: null,
    };
  }

  if (declared.charset) {
    const outcome = decodeBytes(bytes, declared.charset);
    if ("unsupported" in outcome) {
      return {
        declaredCharset: declared.charset,
        charsetSource: null,
        decodeStatus: "unsupported_charset",
        decodedText: null,
      };
    }
    if ("failed" in outcome) {
      return {
        declaredCharset: declared.charset,
        charsetSource: null,
        decodeStatus: "decode_failure",
        decodedText: null,
      };
    }
    return {
      declaredCharset: declared.charset,
      charsetSource: "declared",
      decodeStatus: outcome.text.length === 0 ? "empty_decoded" : "decoded",
      decodedText: outcome.text,
    };
  }

  // NO CHARSET DECLARED. V1's locked fallback is strict UTF-8 ONLY — never
  // ISO-8859-1, Windows-1252 or another fallback merely because it produces
  // characters.
  const outcome = decodeBytes(bytes, "utf-8");
  if ("text" in outcome) {
    return {
      declaredCharset: null,
      charsetSource: "no_declaration_utf8_fallback",
      decodeStatus: outcome.text.length === 0 ? "empty_decoded" : "decoded",
      decodedText: outcome.text,
    };
  }
  return {
    declaredCharset: null,
    charsetSource: null,
    decodeStatus: "missing_charset_undecodable",
    decodedText: null,
  };
}
