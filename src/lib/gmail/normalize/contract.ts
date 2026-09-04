/**
 * B04 vocabulary, shared between the normalizer, the RPC callers and the
 * tests. Deliberately free of `server-only` and of any secret, matching B03's
 * `import/contract.ts` — these are names and shapes, not credentials.
 */

/**
 * THE NORMALIZER CONTRACT VERSION.
 *
 * A semantic contract version, not a git SHA, a timestamp or a package
 * version. A row in `private.gmail_normalized_messages` carrying a different
 * value is a rebuild candidate, not a violation — unlike B03's
 * `acquisition_strategy`, this one is expected to grow over the table's life.
 */
export const GMAIL_NORMALIZER_VERSION = "gmail_normalizer_v1";

/** The address-bearing header names B04 parses participants from. */
export const B04_ADDRESS_HEADER_NAMES = ["from", "sender", "reply-to", "to", "cc", "bcc"] as const;
export type AddressHeaderName = (typeof B04_ADDRESS_HEADER_NAMES)[number];

/** The reference-bearing header names B04 tokenizes. */
export const B04_REFERENCE_HEADER_NAMES = ["message-id", "in-reply-to", "references"] as const;
export type ReferenceHeaderName = (typeof B04_REFERENCE_HEADER_NAMES)[number];

/** The only MIME types B04 ever creates a text-part row for. Matches B03's own list. */
export const B04_TEXT_MIME_TYPES = ["text/plain", "text/html"] as const;
export type TextMimeType = (typeof B04_TEXT_MIME_TYPES)[number];

export type ParticipantParseStatus = "parsed" | "malformed" | "empty_group";
export type ReferenceTokenParseStatus = "valid_msgid" | "malformed";

export type TextPartDecodeStatus =
  | "decoded"
  | "empty_decoded"
  | "body_absent"
  | "content_omitted_by_b03"
  | "invalid_base64url"
  | "conflicting_charset"
  | "unsupported_charset"
  | "decode_failure"
  | "missing_charset_undecodable";

export type CharsetSource = "declared" | "no_declaration_utf8_fallback";

export type B03OmissionReason = "attachment" | "non_text" | "external_body";

/** One approved header occurrence, as B03 stored it (`SanitizedHeader`). */
export interface RawSanitizedHeader {
  name: string;
  value: string;
}

/** The shape B03 persisted under `sanitized_payload.payload` (`SanitizedPart`). */
export interface RawSanitizedPart {
  mimeType: string;
  headers?: RawSanitizedHeader[];
  body?: { size: number; data: string };
  contentOmitted?: true;
  omissionReason?: B03OmissionReason;
  size?: number;
  parts?: RawSanitizedPart[];
}

/** The full B03 `sanitized_payload` shape for one raw message. */
export interface RawSanitizedMessage {
  provider_message_id: string;
  provider_thread_id: string;
  internal_date_ms: number;
  label_ids: string[];
  provider_history_id: string | null;
  size_estimate: number | null;
  message_headers: RawSanitizedHeader[];
  payload: RawSanitizedPart;
}

/** One candidate row as `gmail_normalize_list_candidates` returns it. */
export interface NormalizeCandidate {
  mail_account_id: string;
  provider_message_id: string;
  provider_thread_id: string;
  internal_date_ms: number;
  label_ids: string[];
  sanitized_payload: RawSanitizedMessage;
  payload_sha256: string;
}

/** One header row, ready for `gmail_normalize_commit_message`. */
export interface NormalizedHeaderInput {
  header_name: string;
  occurrence_index: number;
  global_order: number;
  raw_value: string;
}

/** One participant row, ready for `gmail_normalize_commit_message`. */
export interface NormalizedParticipantInput {
  source_header_name: AddressHeaderName;
  source_header_occurrence_index: number;
  header_role: AddressHeaderName;
  participant_order: number;
  display_name: string | null;
  addr_spec: string | null;
  local_part: string | null;
  domain: string | null;
  domain_lower: string | null;
  raw_fragment: string | null;
  parse_status: ParticipantParseStatus;
}

/** One reference-token row, ready for `gmail_normalize_commit_message`. */
export interface NormalizedReferenceTokenInput {
  source_header_name: ReferenceHeaderName;
  source_header_occurrence_index: number;
  header_role: ReferenceHeaderName;
  token_order: number;
  raw_token: string;
  parse_status: ReferenceTokenParseStatus;
}

/** One text-part row, ready for `gmail_normalize_commit_message`. */
export interface NormalizedTextPartInput {
  part_path: number[];
  mime_type: TextMimeType;
  content_type_values: string[];
  content_disposition_values: string[];
  content_transfer_encoding_values: string[];
  declared_charset: string | null;
  charset_source: CharsetSource | null;
  body_data_present: boolean;
  b03_omitted: boolean;
  b03_omission_reason: B03OmissionReason | null;
  decode_status: TextPartDecodeStatus;
  decoded_text: string | null;
}

/** The full computed payload for one message, as `computeNormalization` returns it. */
export interface ComputedNormalization {
  headers: NormalizedHeaderInput[];
  participants: NormalizedParticipantInput[];
  referenceTokens: NormalizedReferenceTokenInput[];
  textParts: NormalizedTextPartInput[];
}
