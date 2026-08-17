/**
 * The PRE-WRITE consistency gate.
 *
 * The manifest reads its run accounting from the METRICS artifact while the
 * adapter independently maps the RAW PROPERTIES artifact. Both are SHA-verified,
 * which proves each file is unchanged — and proves nothing about whether they
 * describe the same extraction.
 *
 * Without this gate the following is structurally possible: raw properties from
 * run A, metrics from run B, both hashes valid, manifest accepted — and
 * `source_runs` then stores run B's accounting while the observations under it
 * are run A's rows. Every individual check passes and the provenance is a lie.
 *
 * So the counts the adapter actually derived are compared with the counts the
 * manifest claims, before anything is previewed or written. A disagreement is a
 * STOP: the metrics are not reinterpreted, the raw artifact is not repaired, and
 * nothing is normalized away.
 */
import type { AdapterOutcome } from "./adapters/hotelbeds-cached";
import type { IngestionManifest } from "./manifest";

export interface ConsistencyFinding {
  check: string;
  manifest: string | number;
  actual: string | number;
}

export class ArtifactConsistencyError extends Error {
  constructor(readonly findings: ConsistencyFinding[]) {
    super(
      "The raw properties artifact and the run metrics artifact do not describe the same " +
        "extraction:\n" +
        findings
          .map(
            (f) =>
              `  ${f.check}\n    manifest (metrics) ${f.manifest}\n    actual (raw)       ${f.actual}`,
          )
          .join("\n") +
        "\n\nRefusing to write a run whose accounting came from one extraction and whose " +
        "observations came from another. Neither artifact is adjusted to agree with the other.",
    );
    this.name = "ArtifactConsistencyError";
  }
}

/**
 * Compare what the adapter actually found against what the manifest claims.
 *
 * `rawRecordCount` here is the length of the raw payload array — not a derived
 * number — so the check is genuinely about the two files rather than about the
 * adapter agreeing with itself.
 */
export function assertArtifactsConsistent(
  manifest: IngestionManifest,
  outcome: AdapterOutcome,
  actualRawRecordCount: number,
): void {
  const { evidence } = manifest;
  const findings: ConsistencyFinding[] = [];

  const check = (name: string, claimed: number, actual: number): void => {
    if (claimed !== actual) findings.push({ check: name, manifest: claimed, actual });
  };

  check("raw record count", evidence.rawRecordCount, actualRawRecordCount);
  check(
    "unique source property ids",
    evidence.uniqueSourcePropertyIdCount,
    outcome.observations.length,
  );
  check(
    "records missing a source property id",
    evidence.recordsMissingSourcePropertyId,
    outcome.recordsMissingSourcePropertyId,
  );
  check(
    "duplicate source property ids",
    evidence.duplicateSourcePropertyIdCount,
    outcome.duplicateSourcePropertyIds.length,
  );

  // The accounting must also add up internally: with nothing missing and nothing
  // duplicated, every raw record must have become exactly one observation.
  if (
    outcome.recordsMissingSourcePropertyId === 0 &&
    outcome.duplicateSourcePropertyIds.length === 0 &&
    outcome.observations.length !== actualRawRecordCount
  ) {
    findings.push({
      check: "observations vs raw records (no missing or duplicate ids)",
      manifest: actualRawRecordCount,
      actual: outcome.observations.length,
    });
  }

  if (findings.length > 0) throw new ArtifactConsistencyError(findings);
}

export class GeographyContradictionError extends Error {
  constructor(
    readonly expected: string,
    readonly observed: { code: string; count: number }[],
  ) {
    super(
      `Provider geography contradiction: the manifest selected destinationCode ${expected}, ` +
        "but the raw artifact carries " +
        observed.map((o) => `${o.code} × ${o.count}`).join(", ") +
        ".\n\nThese observations would be written under the wrong canonical destination. " +
        "PR #21 named this a GEOGRAPHY_MAPPING_CONTRADICTION and required the run to stop " +
        "rather than reconcile it silently.",
    );
    this.name = "GeographyContradictionError";
  }
}

/**
 * Every mapped record must carry the destination code the manifest selected.
 *
 * Cheap — one pass over an array already in memory — and it catches the failure
 * that would be hardest to notice afterwards: a correct-looking run row whose
 * observations belong to a different place.
 *
 * A record with NO destination code is not a contradiction: absence is not a
 * conflicting claim, and the provider is entitled to omit the field.
 */
export function assertGeographyConsistent(
  manifest: IngestionManifest,
  outcome: AdapterOutcome,
): void {
  const expected = manifest.providerGeography.destinationCode;
  if (typeof expected !== "string") return;

  const foreign = new Map<string, number>();
  for (const obs of outcome.observations) {
    const code = obs.destinationCode;
    if (code === null || code === undefined) continue;
    if (code === expected) continue;
    foreign.set(code, (foreign.get(code) ?? 0) + 1);
  }

  if (foreign.size > 0) {
    throw new GeographyContradictionError(
      expected,
      [...foreign.entries()].map(([code, count]) => ({ code, count })),
    );
  }
}
