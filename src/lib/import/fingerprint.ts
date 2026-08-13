/**
 * Deterministic hashing for idempotency (IMPORT_SPEC.md §11).
 *  - file SHA256 detects repeat imports of the same source file;
 *  - stable row fingerprints detect identical rows regardless of key order.
 */
import { createHash } from "node:crypto";

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Stable stringify: object keys sorted recursively so key order never matters. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Content fingerprint of a raw row, independent of column ordering. */
export function rowFingerprint(raw: Record<string, unknown>): string {
  return sha256Hex(stableStringify(raw));
}
