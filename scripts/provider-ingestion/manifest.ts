/**
 * The ingestion manifest: an explicit, frozen statement of WHICH cached source
 * evidence is being replayed.
 *
 * Nothing here globs `.data/`. The artifacts are named one by one, because the
 * evaluation tree also holds credential probes, one-record field probes,
 * geography masters, category masters, superseded partial runs and pilot
 * comparison rows — none of which are properties, and several of which would
 * look plausible to a pattern match.
 *
 * The manifest is gitignored. It contains digests and counts, never provider
 * records and never credentials.
 */
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { digestFile, digestValue } from "./digest";

export const MANIFEST_FORMAT_VERSION = "provider-ingestion-manifest/1";
/**
 * Bumping this changes every run fingerprint, and therefore every run id. It
 * belongs to the MEANING of the evidence: if we change how run evidence is
 * derived from the artifacts, the old run is not the same run.
 */
export const RUN_EVIDENCE_VERSION = "hotelbeds-cached-evaluation/1";

export const EVALUATION_ARTIFACT_ROOT = ".data/provider-evaluation";
export const INGESTION_ROOT = ".data/provider-ingestion";

export interface ArtifactRef {
  role: "raw_properties" | "run_metrics" | "classification_master" | "accommodation_master";
  /** Repo-relative. Absolute paths never enter the manifest or the database. */
  relativePath: string;
  sha256: string;
  bytes: number;
  /**
   * File mtime, ISO-8601. LOCAL EVIDENCE about when this artifact was captured
   * — explicitly NOT a provider-authoritative observation time. See §4 of the
   * block brief and the README.
   */
  artifactCaptureTimestamp: string;
}

export interface IngestionManifest {
  formatVersion: typeof MANIFEST_FORMAT_VERSION;
  runEvidenceVersion: typeof RUN_EVIDENCE_VERSION;
  provider: string;
  sourceEnvironment: "evaluation";
  /** Canonical destination SLUG. The uuid is resolved from the DB, never frozen. */
  destinationSlug: string;
  providerGeography: Record<string, unknown>;
  artifacts: ArtifactRef[];
  evidence: {
    rawRecordCount: number;
    uniqueSourcePropertyIdCount: number;
    duplicateSourcePropertyIdCount: number;
    recordsMissingSourcePropertyId: number;
    providerReportedTotal: number | null;
    paginationWalkCompleted: boolean;
    providerEnumerationExhaustionProven: boolean;
    enumerationRisks: string[];
    coverageRisks: string[];
    originalRequestCount: number | null;
  };
  /**
   * The single timestamp every row of this run carries. Frozen here so a later
   * replay is byte-identical even if the files are copied and re-stamped.
   */
  observedAt: string;
  observedAtBasis: "artifact_capture_timestamp_local_evidence";
  /** Digest of everything above. Also the run-identity fingerprint input. */
  manifestDigest: string;
}

/** The explicitly selected artifact set for one provider × destination. */
export interface ArtifactSelection {
  provider: string;
  destinationSlug: string;
  providerGeography: Record<string, unknown>;
  rawProperties: string;
  runMetrics: string;
  classificationMaster: string;
  accommodationMaster: string;
}

/**
 * The whitelist. Adding a destination is an explicit edit, reviewable in a diff
 * — which is the point.
 */
export const HOTELBEDS_CACHED_SELECTIONS: Record<string, ArtifactSelection> = {
  bali: {
    provider: "hotelbeds",
    destinationSlug: "bali",
    providerGeography: { destinationCode: "BAI" },
    rawProperties: `${EVALUATION_ARTIFACT_ROOT}/raw/hotelbeds-bali-run.json`,
    runMetrics: `${EVALUATION_ARTIFACT_ROOT}/metrics/hotelbeds-bali-run.json`,
    classificationMaster: `${EVALUATION_ARTIFACT_ROOT}/hotelbeds-category-master.json`,
    accommodationMaster: `${EVALUATION_ARTIFACT_ROOT}/hotelbeds-accommodation-types.json`,
  },
  dubai: {
    provider: "hotelbeds",
    destinationSlug: "dubai",
    providerGeography: { destinationCode: "DXB" },
    rawProperties: `${EVALUATION_ARTIFACT_ROOT}/raw/hotelbeds-dubai-run.json`,
    runMetrics: `${EVALUATION_ARTIFACT_ROOT}/metrics/hotelbeds-dubai-run.json`,
    classificationMaster: `${EVALUATION_ARTIFACT_ROOT}/hotelbeds-category-master.json`,
    accommodationMaster: `${EVALUATION_ARTIFACT_ROOT}/hotelbeds-accommodation-types.json`,
  },
};

export class MissingArtifactError extends Error {
  constructor(readonly missing: string[]) {
    super(
      `Required cached artifacts are absent:\n  ${missing.join("\n  ")}\n\n` +
        "This block replays a PRIOR cached Hotelbeds evaluation and must not call the " +
        "provider to recreate them. Restore the artifacts, or report the missing " +
        "requirement — do not substitute fixtures for a real-volume test.",
    );
    this.name = "MissingArtifactError";
  }
}

export class ArtifactDigestMismatchError extends Error {
  constructor(readonly mismatches: { relativePath: string; expected: string; actual: string }[]) {
    super(
      "Cached artifacts no longer match the manifest digest:\n" +
        mismatches
          .map((m) => `  ${m.relativePath}\n    manifest ${m.expected}\n    actual   ${m.actual}`)
          .join("\n") +
        "\n\nRefusing to ingest changed source data under the identity of an older run.",
    );
    this.name = "ArtifactDigestMismatchError";
  }
}

async function describeArtifact(
  role: ArtifactRef["role"],
  relativePath: string,
  repoRoot: string,
): Promise<ArtifactRef> {
  const abs = path.resolve(repoRoot, relativePath);
  const stat = statSync(abs);
  return {
    role,
    relativePath,
    sha256: await digestFile(abs),
    bytes: stat.size,
    artifactCaptureTimestamp: stat.mtime.toISOString(),
  };
}

/**
 * The evidence block, read from the cached METRICS artifact rather than
 * recomputed from prose.
 *
 * One reconciliation is deliberate. The cached metrics carry
 * `exhaustionProven` under the PRE-split semantics — walk completed AND zero
 * coverage risks — which reported `false` for both destinations purely because
 * geography-mapping caveats were recorded. Under the vocabulary locked in
 * migration 0027 those are COVERAGE risks, not ENUMERATION risks, and they do
 * not falsify a walk that genuinely completed. So exhaustion is re-derived
 * here from the enumeration facts, and the coverage risks are carried across
 * intact rather than emptied.
 */
function readEvidence(metrics: unknown): IngestionManifest["evidence"] {
  const m = metrics as {
    metrics?: {
      accounting?: Record<string, number>;
      pagination?: Record<string, unknown>;
    };
  };
  const accounting = m.metrics?.accounting ?? {};
  const pagination = m.metrics?.pagination ?? {};

  const rawRecordCount = Number(accounting.rawRecordsReturned ?? 0);
  const uniqueIds = Number(accounting.uniqueSourcePropertyIds ?? 0);
  const reportedTotalRaw = pagination.reportedTotal;
  const providerReportedTotal =
    typeof reportedTotalRaw === "number" && Number.isFinite(reportedTotalRaw)
      ? reportedTotalRaw
      : null;
  const walkCompleted = pagination.walkCompleted === true;
  const coverageRisks = Array.isArray(pagination.coverageRisks)
    ? pagination.coverageRisks.map(String)
    : [];

  // ENUMERATION risks, derived from enumeration facts only. A provider total
  // that disagrees with the rows returned is the classic one; an incomplete
  // walk is another. Neither is a judgement about what the set means.
  const enumerationRisks: string[] = [];
  if (!walkCompleted) {
    enumerationRisks.push("[enumeration] pagination walk did not complete");
  }
  if (providerReportedTotal !== null && providerReportedTotal !== rawRecordCount) {
    enumerationRisks.push(
      `[enumeration] provider reported ${providerReportedTotal} records but ${rawRecordCount} were returned`,
    );
  }
  if (Number(accounting.recordsMissingSourcePropertyId ?? 0) > 0) {
    enumerationRisks.push(
      `[enumeration] ${accounting.recordsMissingSourcePropertyId} records carry no provider id`,
    );
  }

  const requests = pagination.requests;

  return {
    rawRecordCount,
    uniqueSourcePropertyIdCount: uniqueIds,
    duplicateSourcePropertyIdCount: Number(accounting.duplicateIdRecords ?? 0),
    recordsMissingSourcePropertyId: Number(accounting.recordsMissingSourcePropertyId ?? 0),
    providerReportedTotal,
    paginationWalkCompleted: walkCompleted,
    providerEnumerationExhaustionProven: walkCompleted && enumerationRisks.length === 0,
    enumerationRisks,
    coverageRisks,
    originalRequestCount:
      typeof requests === "number" && Number.isFinite(requests) ? requests : null,
  };
}

/** Build a manifest from an explicitly selected artifact set. */
export async function buildManifest(
  selection: ArtifactSelection,
  repoRoot: string,
): Promise<IngestionManifest> {
  const files: [ArtifactRef["role"], string][] = [
    ["raw_properties", selection.rawProperties],
    ["run_metrics", selection.runMetrics],
    ["classification_master", selection.classificationMaster],
    ["accommodation_master", selection.accommodationMaster],
  ];

  const missing = files
    .map(([, rel]) => rel)
    .filter((rel) => !existsSync(path.resolve(repoRoot, rel)));
  if (missing.length > 0) throw new MissingArtifactError(missing);

  const artifacts: ArtifactRef[] = [];
  for (const [role, rel] of files) {
    artifacts.push(await describeArtifact(role, rel, repoRoot));
  }

  const metrics = JSON.parse(
    await readFile(path.resolve(repoRoot, selection.runMetrics), "utf8"),
  ) as unknown;

  // The raw artifact's own capture time is the defensible basis: it is the file
  // that holds the provider facts.
  const rawRef = artifacts.find((a) => a.role === "raw_properties")!;

  const base = {
    formatVersion: MANIFEST_FORMAT_VERSION,
    runEvidenceVersion: RUN_EVIDENCE_VERSION,
    provider: selection.provider,
    sourceEnvironment: "evaluation",
    destinationSlug: selection.destinationSlug,
    providerGeography: selection.providerGeography,
    artifacts,
    evidence: readEvidence(metrics),
    observedAt: rawRef.artifactCaptureTimestamp,
    observedAtBasis: "artifact_capture_timestamp_local_evidence",
  } satisfies Omit<IngestionManifest, "manifestDigest">;

  return { ...base, manifestDigest: digestValue(base) };
}

/**
 * The run-identity fingerprint.
 *
 * Deliberately NOT the whole manifest digest: the manifest also carries file
 * mtimes and byte sizes, so copying an artifact to a new path or touching it
 * would otherwise mint a different logical run for identical content. This
 * fingerprint is content only.
 */
export function runFingerprint(manifest: IngestionManifest): string {
  return digestValue({
    runEvidenceVersion: manifest.runEvidenceVersion,
    provider: manifest.provider,
    sourceEnvironment: manifest.sourceEnvironment,
    destinationSlug: manifest.destinationSlug,
    providerGeography: manifest.providerGeography,
    // Content digests only, sorted by role so array order cannot matter.
    artifactDigests: [...manifest.artifacts]
      .sort((a, b) => (a.role < b.role ? -1 : 1))
      .map((a) => ({ role: a.role, sha256: a.sha256 })),
  });
}

/** Re-hash every artifact and compare against the manifest. */
export async function verifyManifest(manifest: IngestionManifest, repoRoot: string): Promise<void> {
  const missing = manifest.artifacts
    .map((a) => a.relativePath)
    .filter((rel) => !existsSync(path.resolve(repoRoot, rel)));
  if (missing.length > 0) throw new MissingArtifactError(missing);

  const mismatches: { relativePath: string; expected: string; actual: string }[] = [];
  for (const artifact of manifest.artifacts) {
    const actual = await digestFile(path.resolve(repoRoot, artifact.relativePath));
    if (actual !== artifact.sha256) {
      mismatches.push({
        relativePath: artifact.relativePath,
        expected: artifact.sha256,
        actual,
      });
    }
  }
  if (mismatches.length > 0) throw new ArtifactDigestMismatchError(mismatches);
}

export function manifestPath(manifest: IngestionManifest): string {
  return `${INGESTION_ROOT}/${manifest.provider}-${manifest.destinationSlug}-manifest.json`;
}
