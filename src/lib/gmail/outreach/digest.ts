import { createHash } from "node:crypto";

import type { EvidenceMessage } from "@/lib/gmail/outreach/contract";

/**
 * THE SOURCE-EVIDENCE FENCE TOKEN. Must byte-for-byte match
 * `gmail_outreach_commit_interpretation`'s own recomputation (0039 §11c):
 *
 *   encode(digest(string_agg(id || ':' || sha256 || ':' || sent, '|' order by id), 'sha256'), 'hex')
 *
 * Postgres's `order by id` on a `uuid` column sorts by the type's internal
 * byte representation, but for canonical lowercase-hyphenated UUID text (what
 * every id here already is) that ordering is identical to a plain string
 * sort — every UUID has the same length and hyphen positions, so comparing
 * the strings left to right compares the same hex digits in the same order
 * the bytes would. `provider_sent::text` in Postgres renders a boolean as
 * lowercase `true`/`false`, matching JS's own `String(boolean)`.
 */
export function computeEvidenceDigest(messages: readonly EvidenceMessage[]): string {
  const sorted = [...messages].sort((a, b) =>
    a.normalizedMessageId < b.normalizedMessageId
      ? -1
      : a.normalizedMessageId > b.normalizedMessageId
        ? 1
        : 0,
  );
  const joined = sorted
    .map((m) => `${m.normalizedMessageId}:${m.sourcePayloadSha256}:${m.providerSent}`)
    .join("|");
  return createHash("sha256").update(joined).digest("hex");
}

/** Deterministic digest over an arbitrary sorted string list — used for observation and candidate-set fingerprints. */
export function digestOfSortedStrings(values: readonly string[]): string {
  const sorted = [...values].sort();
  return createHash("sha256").update(sorted.join("|")).digest("hex");
}

export function digestOfString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
