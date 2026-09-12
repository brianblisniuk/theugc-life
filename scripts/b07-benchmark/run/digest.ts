/**
 * Canonical digest helpers shared by result identity, inference-config
 * versioning and run-selection reproducibility.
 *
 * Deliberately dependency-free (Node's built-in `crypto`) and deterministic:
 * key order in the input object never changes the digest, because
 * `stableStringify` sorts object keys recursively before hashing.
 */
import { createHash } from "node:crypto";

/** JSON.stringify with recursively sorted object keys. Arrays keep their order. */
export function stableStringify(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === "object") {
      const record = input as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) sorted[key] = sort(record[key]);
      return sorted;
    }
    return input;
  };
  return JSON.stringify(sort(value));
}

/** Short, stable hex digest. Not a security boundary — just replay identity. */
export function digestOf(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

/** Digest over a set of case ids, order-independent. Used for selection identity. */
export function caseSetDigest(caseIds: readonly string[]): string {
  return digestOf([...caseIds].sort());
}
