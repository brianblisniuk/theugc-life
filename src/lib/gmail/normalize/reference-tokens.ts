import type {
  NormalizedReferenceTokenInput,
  ReferenceHeaderName,
} from "@/lib/gmail/normalize/contract";

/**
 * SYNTACTIC MESSAGE-ID TOKENIZATION — NOT A REPLY GRAPH.
 *
 * RFC 5322 `msg-id` is `<id-left@id-right>` with no internal whitespace.
 * `References` commonly carries many, space-separated; `In-Reply-To` and
 * `Message-ID` usually carry one but nothing here assumes that.
 *
 * A malformed token (missing bracket, missing `@`, empty) is still a row —
 * `parse_status: "malformed"` — because whether it "counts" as a reply
 * relationship is a judgement this layer explicitly refuses to make. There is
 * no code path anywhere in this module that compares one token's value
 * against another message's `Message-ID`; that comparison is B06's, on a
 * later, explicitly contracted layer.
 */
const TOKEN_PATTERN = /<[^>]*>|[^\s<>]+/g;
const VALID_MSGID = /^<([^<>@\s]+)@([^<>@\s]+)>$/;

export function parseReferenceTokens(
  headerName: ReferenceHeaderName,
  occurrenceIndex: number,
  rawValue: string,
): NormalizedReferenceTokenInput[] {
  const matches = rawValue.match(TOKEN_PATTERN) ?? [];

  return matches.map((raw, tokenOrder) => ({
    source_header_name: headerName,
    source_header_occurrence_index: occurrenceIndex,
    token_order: tokenOrder,
    raw_token: raw,
    parse_status: VALID_MSGID.test(raw) ? "valid_msgid" : "malformed",
  }));
}
