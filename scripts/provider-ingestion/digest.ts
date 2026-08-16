/**
 * Deterministic digests and deterministic run identity.
 *
 * Two things depend on this module being stable across machines and across
 * runs: the artifact digests that make a replay verifiable, and the source-run
 * UUID that makes a replay idempotent. Both must be pure functions of content.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/**
 * Canonical JSON: object keys sorted at every depth, no incidental whitespace.
 *
 * `JSON.stringify` preserves insertion order, so two structurally identical
 * provider records could otherwise digest differently purely because of key
 * order in the transport. That would make `source_payload_digest` answer
 * "did the bytes arrive in the same order?" instead of "did this property
 * change?", which is the question it exists to answer.
 *
 * Arrays keep their order — order is meaningful in provider payloads (an image
 * list is not a set).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** SHA-256 over a canonical representation of an arbitrary value. */
export function digestValue(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * Stream a file through SHA-256. Streamed rather than read whole because the
 * Bali raw artifact is ~80 MB and the Dubai one ~54 MB; buffering both to hash
 * them would be a needless spike before any real work starts.
 */
export function digestFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * A deterministic RFC-4122-shaped UUID derived from a fingerprint string.
 *
 * The source run needs a stable identity so that replaying the same cached
 * artifacts produces the SAME run rather than a second one, and 0027
 * deliberately adds no provider-run fingerprint column to look one up by. A
 * content-derived primary key gives idempotency through the existing PK, with
 * no schema change and no `notes`-text lookup.
 *
 * Version/variant bits are set so the value is a well-formed v5-style UUID
 * rather than 32 arbitrary hex characters that merely parse.
 */
export function deterministicUuid(fingerprint: string): string {
  const h = sha256Hex(fingerprint);
  const bytes = Buffer.from(h.slice(0, 32), "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
