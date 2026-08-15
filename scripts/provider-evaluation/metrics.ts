/**
 * Metric computation (brief §13, evaluation spec §4).
 *
 * Every percentage here is over the provider's returned record set for one
 * destination. None of it is a coverage-completeness claim: under D061 a
 * destination is complete only when zero coverage-critical candidates remain
 * unresolved, which no bake-off can establish.
 */
import { hasValidCoordinates, isD060Evidence } from "./normalize";
import type {
  AdapterDescriptor,
  EvaluationDestination,
  EvaluationRecord,
  PaginationEvidence,
  ProviderMetrics,
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

export function computeMetrics(
  records: readonly EvaluationRecord[],
  descriptor: AdapterDescriptor,
  destination: EvaluationDestination,
  pagination: PaginationEvidence,
): ProviderMetrics {
  const total = records.length;
  const uniqueIds = new Set(records.map((r) => r.sourcePropertyId));

  const photoCounts = records.map((r) => r.photoCount);

  // Star buckets. "Unknown" deliberately includes every record whose star field
  // is absent OR whose kind is not accepted evidence — an unrecognised kind is
  // an unresolved classification, never a demotion to a lower band (D061).
  let four = 0;
  let five = 0;
  let lower = 0;
  let unknown = 0;
  let suitable = 0;

  for (const record of records) {
    const usable = isD060Evidence(record.star, descriptor);
    if (usable) suitable += 1;

    if (!usable || record.star.value === null) {
      unknown += 1;
      continue;
    }
    const value = record.star.value;
    if (value >= 5) five += 1;
    else if (value >= 4) four += 1;
    else lower += 1;
  }

  return {
    provider: descriptor.provider,
    destination,
    inventory: {
      totalRawRecords: total,
      uniqueSourcePropertyIds: uniqueIds.size,
      duplicateIdRecords: total - uniqueIds.size,
      apparentFourStar: four,
      apparentFiveStar: five,
      apparentLowerStar: lower,
      unknownStar: unknown,
      propertyTypeDistribution: distribution(records.map((r) => r.propertyType)),
      activeStatusDistribution: distribution(records.map((r) => r.activeStatus)),
    },
    fieldCoverage: {
      coordinatesPct: pct(
        records.filter((r) => r.latitude !== null && r.longitude !== null).length,
        total,
      ),
      validCoordinatesPct: pct(records.filter(hasValidCoordinates).length, total),
      addressPct: pct(records.filter((r) => r.address !== null).length, total),
      starFieldPct: pct(records.filter((r) => r.star.value !== null).length, total),
      starSuitableForD060Pct: pct(suitable, total),
      brandPct: pct(records.filter((r) => r.brand !== null).length, total),
      chainPct: pct(records.filter((r) => r.chain !== null).length, total),
      websitePct: pct(records.filter((r) => r.websiteUrl !== null).length, total),
      providerContactPct: pct(records.filter((r) => r.providerContact !== null).length, total),
      photoPct: pct(records.filter((r) => r.photoCount > 0).length, total),
      heroImagePct: pct(records.filter((r) => r.hasHeroImage).length, total),
      averagePhotosPerProperty:
        total === 0 ? 0 : Math.round((photoCounts.reduce((a, b) => a + b, 0) / total) * 100) / 100,
      medianPhotosPerProperty: median(photoCounts),
    },
    pagination,
  };
}
