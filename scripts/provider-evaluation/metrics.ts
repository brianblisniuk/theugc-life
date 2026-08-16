/**
 * Metric computation (brief §13, evaluation spec §4).
 *
 * Every percentage here is over the provider's NORMALIZED records for one
 * destination, while the raw/normalized accounting travels alongside so the
 * denominator is always explainable. None of it is a coverage-completeness
 * claim: under D061 a destination is complete only when zero coverage-critical
 * candidates remain unresolved, which no bake-off can establish.
 */
import { interpretClassificationForD060 } from "./classification";
import { classifyStarEligibility, hasValidCoordinates, isD060Evidence } from "./normalize";
import type {
  AdapterDescriptor,
  EvaluationDestination,
  EvaluationRecord,
  MediaEvidence,
  PaginationEvidence,
  ProviderMetrics,
  RecordAccounting,
} from "./types";

function pct(count: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((count / total) * 10_000) / 100;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function distribution(values: (string | null)[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) {
    const key = value ?? "(unknown)";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/**
 * Count physical hospitality properties, or return null.
 *
 * Null when the descriptor has not documented which provider property types are
 * physical hospitality properties. D060 §2.2 makes type a real dimension —
 * villas, aparthotels, lodges and residences can all qualify — so guessing which
 * categories count would prejudge eligibility in exactly the direction the
 * contract warns about.
 */
function countHospitality(
  records: readonly EvaluationRecord[],
  descriptor: AdapterDescriptor,
): number | null {
  if (descriptor.hospitalityPropertyTypes.length === 0) return null;
  const accepted = new Set(descriptor.hospitalityPropertyTypes.map((t) => t.toLowerCase()));
  return records.filter((r) => r.propertyType && accepted.has(r.propertyType.toLowerCase())).length;
}

export function computeMetrics(
  records: readonly EvaluationRecord[],
  accounting: RecordAccounting,
  descriptor: AdapterDescriptor,
  destination: EvaluationDestination,
  pagination: PaginationEvidence,
): ProviderMetrics {
  const total = records.length;
  const photoCounts = records.map((r) => r.photoCount);

  let exactFour = 0;
  let exactFive = 0;
  let classifiedNotV1 = 0;
  let unresolved = 0;
  let usableEvidence = 0;

  const starValueDistribution: Record<string, number> = {};
  const classificationResolutionDistribution: Record<string, number> = {};
  const classificationAccommodationTypeDistribution: Record<string, number> = {};

  for (const record of records) {
    if (isD060Evidence(record.star, descriptor)) usableEvidence += 1;

    // Record the raw value distribution so an unexpected scale is visible rather
    // than silently absorbed into "unresolved".
    const key = record.star.value === null ? "(none)" : String(record.star.value);
    starValueDistribution[key] = (starValueDistribution[key] ?? 0) + 1;

    // Classification-mode providers resolve through master data; inline-star
    // providers use the star observation. Both funnel into the same buckets.
    if (record.classification) {
      const key = record.classification.resolution;
      classificationResolutionDistribution[key] =
        (classificationResolutionDistribution[key] ?? 0) + 1;
      const type = record.classification.master?.accommodationType ?? "(unknown)";
      classificationAccommodationTypeDistribution[type] =
        (classificationAccommodationTypeDistribution[type] ?? 0) + 1;
    }

    const eligibility =
      descriptor.classification.mode === "code_with_master_lookup" && record.classification
        ? interpretClassificationForD060(record.classification, descriptor)
        : classifyStarEligibility(record.star, descriptor);

    switch (eligibility) {
      case "exact_five":
        exactFive += 1;
        break;
      case "exact_four":
        exactFour += 1;
        break;
      case "classified_not_v1_scope":
        classifiedNotV1 += 1;
        break;
      default:
        unresolved += 1;
    }
  }

  return {
    provider: descriptor.provider,
    destination,
    accounting,
    inventory: {
      apparentExactFourStar: exactFour,
      apparentExactFiveStar: exactFive,
      classifiedNotV1Scope: classifiedNotV1,
      unresolvedStar: unresolved,
      starValueDistribution,
      classificationResolutionDistribution,
      classificationAccommodationTypeDistribution,
      propertyTypeDistribution: distribution(records.map((r) => r.propertyType)),
      activeStatusDistribution: distribution(records.map((r) => r.activeStatus)),
      apparentPhysicalHospitalityProperties: countHospitality(records, descriptor),
    },
    fieldCoverage: {
      coordinatesPct: pct(
        records.filter((r) => r.latitude !== null && r.longitude !== null).length,
        total,
      ),
      validCoordinatesPct: pct(records.filter(hasValidCoordinates).length, total),
      addressPct: pct(records.filter((r) => r.address !== null).length, total),
      starFieldPct: pct(records.filter((r) => r.star.value !== null).length, total),
      starUsableAsD060EvidencePct: pct(usableEvidence, total),
      brandPct: pct(records.filter((r) => r.brand !== null).length, total),
      chainPct: pct(records.filter((r) => r.chain !== null).length, total),
      websitePct: pct(records.filter((r) => r.websiteUrl !== null).length, total),
      phonePct: pct(records.filter((r) => r.phone !== null).length, total),
      providerContactPct: pct(records.filter((r) => r.providerContact !== null).length, total),
      photoPct: pct(records.filter((r) => r.photoCount > 0).length, total),
      // PROVIDER-DESIGNATED only. A locally-selected fallback is not a hero image.
      heroImagePct: pct(records.filter((r) => r.hasProviderDesignatedPrincipal).length, total),
      averagePhotosPerProperty:
        total === 0 ? 0 : Math.round((photoCounts.reduce((a, b) => a + b, 0) / total) * 100) / 100,
      medianPhotosPerProperty: median(photoCounts),
    },
    pagination,
  };
}

/**
 * Media evidence (brief §13 MEDIA).
 *
 * Counts come from the run; category, dimension and provenance detail come from
 * the descriptor, because whether a provider *supplies* image metadata is a
 * documentary fact and whether we may *store* the asset is a licensing one.
 */
export function computeMediaEvidence(
  records: readonly EvaluationRecord[],
  descriptor: AdapterDescriptor,
  categoryDistributionOverride?: Record<string, number>,
  dimensionsSupplied: boolean | null = null,
  provenanceMetadataAvailable: boolean | null = null,
): MediaEvidence {
  return {
    propertiesWithAnyImage: records.filter((r) => r.photoCount > 0).length,
    propertiesWithProviderDesignatedPrincipal: records.filter(
      (r) => r.hasProviderDesignatedPrincipal,
    ).length,
    // Live data contradicts the documented rule when properties HAVE images and
    // ordering but essentially none carries the documented marker.
    documentedPrincipalSemanticsContradicted:
      records.some((r) => r.photoCount > 0) &&
      records.filter((r) => r.hasProviderDesignatedPrincipal).length * 10 <
        records.filter((r) => r.photoCount > 0).length,
    totalImages: records.reduce((sum, r) => sum + r.photoCount, 0),
    imagesWithPath: records.reduce((sum, r) => sum + r.imagesWithPath, 0),
    categoryDistribution:
      categoryDistributionOverride ??
      records.reduce<Record<string, number>>((acc, r) => {
        for (const type of r.imageTypes) acc[type] = (acc[type] ?? 0) + 1;
        return acc;
      }, {}),
    dimensionsSupplied,
    provenanceMetadataAvailable,
    documentedUsageConstraints: descriptor.media.documentedUsageConstraints,
  };
}
