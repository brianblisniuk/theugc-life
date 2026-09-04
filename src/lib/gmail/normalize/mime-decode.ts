import type { CharsetSource, TextPartDecodeStatus } from "@/lib/gmail/normalize/contract";

/**
 * GMAIL BODY DATA DECODING — THE LOCKED V1 RULE.
 *
 * OFFICIAL DOCUMENTED FACT (Gmail API `users.messages` discovery schema):
 * `MessagePartBody.data` is described only as "the body data of a MIME
 * message part... as a base64url encoded string". The schema documents no
 * relationship between `data` and `Content-Transfer-Encoding` at all.
 *
 * EMPIRICAL PROVIDER BEHAVIOR (not documented by Google, observed in
 * practice): decoding `data` as base64url once yields the final body bytes
 * directly, even when the source message's `Content-Transfer-Encoding`
 * header says `base64` or `quoted-printable` — i.e. Gmail appears to have
 * already unwrapped that transfer encoding before populating `data`.
 *
 * OUR V1 POLICY, built on that empirical observation and not on an official
 * guarantee: B04 decodes `data` as base64url EXACTLY ONCE, then interprets
 * the resulting bytes under the declared (or, absent one, strict UTF-8
 * fallback) charset. `Content-Transfer-Encoding` is preserved as SOURCE MIME
 * EVIDENCE — see the caller, which stores every surviving occurrence
 * verbatim — and is NEVER inspected here to trigger a second decode, so a
 * false decode never overwrites the original evidence needed to detect it.
 * If this provider assumption is ever falsified for some message, the raw
 * B03 payload remains fully reconstructable and a future normalizer version
 * can reprocess it; this file does not double-decode speculatively to guard
 * against that possibility, per the locked V1 rule.
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
 * Extract the CHARSET parameter from EVERY surviving `Content-Type`
 * occurrence, conservatively. Distinct, non-empty, case-insensitively
 * differing declarations are a CONFLICT — never resolved by "first wins" or
 * "last wins", the exact lesson B03's MIME safety work already paid for.
 *
 * The regex is GLOBAL and every value is scanned to exhaustion: a single
 * malformed occurrence can itself repeat the parameter
 * (`charset=UTF-8; charset=ISO-8859-1`), and a non-global `.exec()` would see
 * only the first, silently treating a self-contradictory header as
 * unambiguous. `lastIndex` is reset before each value because a global
 * regex's match position is stateful across calls to `.exec()`.
 */
const CHARSET_PARAM = /charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;]+))/gi;

export function extractDeclaredCharset(
  contentTypeValues: readonly string[],
): { conflicting: false; charset: string | null } | { conflicting: true } {
  const declared = new Map<string, string>(); // lowercased -> as-first-seen
  for (const value of contentTypeValues) {
    CHARSET_PARAM.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CHARSET_PARAM.exec(value)) !== null) {
      const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
      // An empty declaration (`charset=`) must not erase a real one already
      // found — it is simply not evidence of any charset.
      if (raw.length === 0) continue;
      const key = raw.toLowerCase();
      if (!declared.has(key)) declared.set(key, raw);
    }
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
