/**
 * Field-map verification against a real provider payload.
 *
 * The failure this prevents is specific and silent: a documented-but-wrong field
 * path does not crash. `readPath` returns null, the record normalizes fine, and
 * the metrics report **0% coverage** for a field the provider populates on every
 * property. That number is indistinguishable from a genuine finding, and it
 * would be used to judge a source.
 *
 * So before any aggregate is computed from a live extraction, the descriptor's
 * expected paths are checked against an actual payload. A path that resolves on
 * no sampled record is a `FIELD_MAP_MISMATCH` — the descriptor is wrong, not the
 * provider — and the caller must fix the path rather than publish the zero.
 */
import { readPath } from "./normalize";
import type { AdapterDescriptor } from "./types";

export type FieldVerdict = "present" | "absent_in_sample" | "not_mapped";

export interface FieldVerification {
  field: string;
  path: string | null;
  verdict: FieldVerdict;
  /** How many sampled records resolved a non-null value at this path. */
  resolvedCount: number;
  sampleSize: number;
}

export interface FieldVerificationReport {
  provider: string;
  sampleSize: number;
  fields: FieldVerification[];
  /** Mapped paths that resolved on ZERO sampled records. */
  mismatches: FieldVerification[];
  /** True when at least one mapped path never resolved. */
  hasMismatch: boolean;
}

/** The paths whose correctness the brief requires confirming before aggregating. */
const VERIFIED_FIELDS = [
  "sourcePropertyId",
  "name",
  "propertyType",
  "address",
  "latitude",
  "longitude",
  "chain",
  "websiteUrl",
  "phone",
  "providerContact",
  "photos",
  "activeStatus",
] as const;

/**
 * Verify a descriptor's field map against sampled raw payloads.
 *
 * `absent_in_sample` is reported per field but only becomes a MISMATCH when the
 * path is mapped and resolves nowhere. A genuinely optional field that happens
 * to be empty on every sampled record is indistinguishable from a bad path at
 * this sample size, which is why the report names the field and leaves the
 * judgement to a human rather than silently proceeding.
 */
export function verifyFieldMap(
  payloads: readonly unknown[],
  descriptor: AdapterDescriptor,
): FieldVerificationReport {
  const sampleSize = payloads.length;
  const fields: FieldVerification[] = [];

  for (const field of VERIFIED_FIELDS) {
    const path = descriptor.fieldMap[field] ?? null;
    if (!path) {
      fields.push({ field, path: null, verdict: "not_mapped", resolvedCount: 0, sampleSize });
      continue;
    }
    const resolvedCount = payloads.filter((p) => readPath(p, path) !== null).length;
    fields.push({
      field,
      path,
      verdict: resolvedCount > 0 ? "present" : "absent_in_sample",
      resolvedCount,
      sampleSize,
    });
  }

  // The classification code path is verified too: it is the one Hotelbeds path
  // that was previously assumed rather than observed.
  const codePath = descriptor.classification.codePath ?? null;
  if (codePath) {
    const resolvedCount = payloads.filter((p) => readPath(p, codePath) !== null).length;
    fields.push({
      field: "classification.codePath",
      path: codePath,
      verdict: resolvedCount > 0 ? "present" : "absent_in_sample",
      resolvedCount,
      sampleSize,
    });
  }

  const mismatches = fields.filter((f) => f.verdict === "absent_in_sample");

  return {
    provider: descriptor.provider,
    sampleSize,
    fields,
    mismatches,
    hasMismatch: mismatches.length > 0,
  };
}

export class FieldMapMismatchError extends Error {
  constructor(readonly report: FieldVerificationReport) {
    super(
      `FIELD_MAP_MISMATCH for "${report.provider}": ${report.mismatches.length} mapped path(s) ` +
        `resolved on none of ${report.sampleSize} sampled records:\n` +
        report.mismatches.map((m) => `  - ${m.field} -> ${m.path}`).join("\n") +
        "\n\nAggregate coverage was NOT computed. A wrong path reports 0% for a field the " +
        "provider populates, which looks exactly like a real measurement. Fix the descriptor " +
        "against the observed payload shape, then re-run.",
    );
    this.name = "FieldMapMismatchError";
  }
}
