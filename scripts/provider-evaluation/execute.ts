/**
 * The generic evaluation execution pipeline.
 *
 *   auth → exhaustive pagination → raw-count evidence → normalize
 *   → metrics → gitignored artifacts → aggregate result
 *
 * This is provider-agnostic. An adapter supplies only the two provider-specific
 * pieces — how to authenticate, and how to fetch one page — through a
 * `ProviderTransport`. Everything downstream is shared, which is what makes the
 * "complete the descriptor, then run" claim true rather than aspirational.
 *
 * Evaluation-only: this module writes nothing but gitignored artifacts, never
 * touches Supabase or `hotels`, and is not imported by the application.
 */
import { writeArtifact } from "./artifacts";
import { assessAllCapabilities } from "./capabilities";
import { FieldMapMismatchError, verifyFieldMap } from "./field-verification";
import { computeMediaEvidence, computeMetrics } from "./metrics";
import { normalizeAll } from "./normalize";
import { paginateAll, type PageResult } from "./paginate";
import type {
  AdapterDescriptor,
  EvaluationDestination,
  EvaluationRunResult,
  ProviderGeographyResolution,
  ReferenceData,
  RuntimeObservation,
} from "./types";
import { emptyReferenceData } from "./types";

/**
 * The provider-specific surface, kept as small as possible.
 *
 * `fetchPage` returns raw, untransformed provider payloads. Normalization is
 * deliberately not the adapter's job: keeping it in shared code means the field
 * map stays the reviewable artifact rather than hiding inside per-provider
 * parsing.
 */
export interface ProviderTransport {
  /**
   * Fetch one page of static property content for a provider geography entity.
   *
   * @param entityId provider-native geography id being enumerated
   * @param cursor   page token from the previous page, or null for the first
   */
  fetchPage(entityId: string, cursor: string | null): Promise<PageResult<unknown>>;
}

export interface ExecuteOptions {
  descriptor: AdapterDescriptor;
  destination: EvaluationDestination;
  transport: ProviderTransport;
  /**
   * Label for this run, supplied by the caller. The harness never reads a clock
   * itself, so runs stay reproducible and diffable.
   */
  runLabel: string;
  /** Persist raw provider payloads (gitignored) for later re-analysis. */
  retainRawPayloads?: boolean;
  /** Runaway guards, NOT coverage caps. Passed through to the paginator. */
  maxRequestsPerEntity?: number;
  /** Master/reference data for code→meaning joins (e.g. Hotelbeds categories). */
  reference?: ReferenceData;
  /**
   * What was actually observed about the network and credentials during this
   * run. Reported capabilities are assessed against it, so the result says what
   * was true when it ran rather than what a static descriptor guessed.
   */
  runtime?: RuntimeObservation;
  /**
   * Throw on a field-map mismatch instead of computing aggregates. Default true:
   * a wrong path silently reports 0% coverage, which looks like a measurement.
   */
  failOnFieldMapMismatch?: boolean;
}

function geographyFor(
  descriptor: AdapterDescriptor,
  destination: EvaluationDestination,
): ProviderGeographyResolution {
  const geography = descriptor.geography.find((g) => g.destination === destination);
  if (!geography) {
    throw new Error(
      `Descriptor "${descriptor.provider}" has no resolved geography for "${destination}". ` +
        "A destination must be resolved from provider documentation, never assumed.",
    );
  }
  if (geography.providerEntityIds.length === 0) {
    throw new Error(
      `Descriptor "${descriptor.provider}" resolved "${destination}" to zero provider entity ids.`,
    );
  }
  return geography;
}

/**
 * Run one provider × destination evaluation end to end.
 *
 * Every provider entity making up the destination is enumerated exhaustively and
 * the results are unioned, because a destination our catalogue treats as one
 * node may be several entities on the provider's side.
 */
export async function executeEvaluation(options: ExecuteOptions): Promise<EvaluationRunResult> {
  const { descriptor, destination, transport, runLabel } = options;
  const geography = geographyFor(descriptor, destination);

  const rawPayloads: unknown[] = [];
  const coverageRisks: string[] = [];
  let requests = 0;
  let pages = 0;
  let reportedTotal: number | null = null;
  let allEntitiesProvenExhaustive = true;

  for (const entityId of geography.providerEntityIds) {
    const { records, evidence } = await paginateAll<unknown>(
      (cursor) => transport.fetchPage(entityId, cursor),
      {
        method: descriptor.pagination?.method ?? "unknown",
        documentedHardCap: descriptor.pagination?.documentedHardCap ?? null,
        maxRequests: options.maxRequestsPerEntity,
      },
    );

    rawPayloads.push(...records);
    requests += evidence.requests;
    pages += evidence.pages;
    if (evidence.reportedTotal !== null) {
      reportedTotal = (reportedTotal ?? 0) + evidence.reportedTotal;
    }
    if (!evidence.exhaustionProven) allEntitiesProvenExhaustive = false;
    for (const risk of evidence.coverageRisks) {
      coverageRisks.push(`[entity ${entityId}] ${risk}`);
    }
  }

  // A destination assembled from several provider entities inherits the weakest
  // link: if any one entity could not be proven exhaustive, the destination
  // extraction is not exhaustive either.
  if (geography.requiresUnion) {
    coverageRisks.push(
      `Destination "${destination}" required a union of ${geography.providerEntityIds.length} provider entities; overlap between them is resolved by provider property id only.`,
    );
  }
  for (const caveat of geography.caveats) {
    coverageRisks.push(`[geography] ${caveat}`);
  }

  const pagination = {
    requests,
    pages,
    totalRecords: rawPayloads.length,
    method: descriptor.pagination?.method ?? "unknown",
    documentedHardCap: descriptor.pagination?.documentedHardCap ?? null,
    reportedTotal,
    exhaustionProven: allEntitiesProvenExhaustive && coverageRisks.length === 0,
    coverageRisks,
  };

  // Verify the descriptor's paths against the ACTUAL payload before any
  // aggregate is computed. A mapped path that resolves nowhere means the
  // descriptor is wrong, and reporting its 0% would be reporting fiction.
  const verification = verifyFieldMap(rawPayloads.slice(0, 50), descriptor);
  if (verification.hasMismatch && options.failOnFieldMapMismatch !== false) {
    writeArtifact(
      `field-verification/${descriptor.provider}-${destination}-${runLabel}.json`,
      verification,
    );
    throw new FieldMapMismatchError(verification);
  }

  const reference = options.reference ?? emptyReferenceData();
  const { records, accounting } = normalizeAll(rawPayloads, descriptor, destination, reference);
  const metrics = computeMetrics(records, accounting, descriptor, destination, pagination);
  const media = computeMediaEvidence(records, descriptor);

  const artifacts: string[] = [];
  const slug = `${descriptor.provider}-${destination}-${runLabel}`;

  if (options.retainRawPayloads) {
    // Gitignored. Raw provider payloads never enter the repository.
    artifacts.push(writeArtifact(`raw/${slug}.json`, rawPayloads));
  }
  artifacts.push(writeArtifact(`normalized/${slug}.json`, records));
  artifacts.push(
    writeArtifact(`metrics/${slug}.json`, {
      metrics,
      media,
      operations: descriptor.operations,
      fieldVerification: verification,
    }),
  );

  return {
    provider: descriptor.provider,
    destination,
    runLabel,
    metrics,
    media,
    operations: descriptor.operations,
    capabilities: assessAllCapabilities(descriptor, destination, options.runtime),
    artifacts,
    coverageDisclaimer:
      "These are provider metrics, NOT a coverage claim. Under D061 a destination is coverage complete only when zero coverage-critical candidates remain unresolved, which this run does not establish.",
  };
}
