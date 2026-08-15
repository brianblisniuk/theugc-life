/**
 * Cross-source overlap analysis (brief §14).
 *
 * This produces EVIDENCE for a future entity-resolution policy. It does not
 * produce canonical matches, it never touches `hotels`, and it deliberately
 * declines to emit a match "threshold" — D063 defers that until real source
 * behaviour is known, and a number invented here would later read as a decision.
 *
 * The bias is conservative in the same direction D063 requires: when signals
 * disagree, a pair lands in `ambiguous` rather than in `highConfidenceOverlap`.
 * A duplicate left in the review queue is visible and fixable; a false merge
 * silently welds two hotels' histories together.
 */
import type { EvaluationDestination, EvaluationRecord, OverlapAnalysis } from "./types";

/** Normalize a property name for comparison only. Never stored as canonical. */
export function normalizeName(name: string | null): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Host-only comparison, so a tracking query string cannot break a match. */
export function normalizeDomain(url: string | null): string {
  if (!url) return "";
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    return parsed.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Great-circle distance in metres. */
export function haversineMetres(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Signals that fired for one candidate pair. */
export interface PairSignals {
  exactNormalizedName: boolean;
  sameDomain: boolean;
  /** Within 150m — close enough to be the same building, not a neighbourhood. */
  coordinatesClose: boolean;
  /** Beyond 2km with both sets of coordinates present: actively contradictory. */
  coordinatesContradict: boolean;
}

const CLOSE_METRES = 150;
const CONTRADICT_METRES = 2_000;

export function scorePair(a: EvaluationRecord, b: EvaluationRecord): PairSignals {
  const nameA = normalizeName(a.name);
  const nameB = normalizeName(b.name);
  const domainA = normalizeDomain(a.websiteUrl);
  const domainB = normalizeDomain(b.websiteUrl);

  let coordinatesClose = false;
  let coordinatesContradict = false;
  if (a.latitude !== null && a.longitude !== null && b.latitude !== null && b.longitude !== null) {
    const metres = haversineMetres(a.latitude, a.longitude, b.latitude, b.longitude);
    coordinatesClose = metres <= CLOSE_METRES;
    coordinatesContradict = metres > CONTRADICT_METRES;
  }

  return {
    exactNormalizedName: nameA !== "" && nameA === nameB,
    sameDomain: domainA !== "" && domainA === domainB,
    coordinatesClose,
    coordinatesContradict,
  };
}

export type PairVerdict = "high_confidence" | "ambiguous" | "no_match";

/**
 * Classify a candidate pair.
 *
 * High confidence needs two independent signals agreeing and nothing
 * contradicting. One signal alone is ambiguous — "the names look similar" is
 * explicitly not a merge reason (D063).
 */
export function classifyPair(signals: PairSignals): PairVerdict {
  if (signals.coordinatesContradict) return "no_match";

  const positives = [
    signals.exactNormalizedName,
    signals.sameDomain,
    signals.coordinatesClose,
  ].filter(Boolean).length;

  if (positives >= 2) return "high_confidence";
  if (positives === 1) return "ambiguous";
  return "no_match";
}

/** Candidate duplicates WITHIN one provider — a real resolution cost. */
export function intraProviderDuplicateCandidates(records: readonly EvaluationRecord[]): number {
  let count = 0;
  for (let i = 0; i < records.length; i += 1) {
    for (let j = i + 1; j < records.length; j += 1) {
      const a = records[i];
      const b = records[j];
      if (!a || !b) continue;
      if (a.sourcePropertyId === b.sourcePropertyId) continue;
      if (classifyPair(scorePair(a, b)) === "high_confidence") count += 1;
    }
  }
  return count;
}

export function analyseOverlap(
  destination: EvaluationDestination,
  aRecords: readonly EvaluationRecord[],
  bRecords: readonly EvaluationRecord[],
): OverlapAnalysis {
  const providerA = aRecords[0]?.provider ?? "a";
  const providerB = bRecords[0]?.provider ?? "b";

  const matchedA = new Set<string>();
  const matchedB = new Set<string>();
  const ambiguousA = new Set<string>();
  const ambiguousB = new Set<string>();
  let highConfidencePairs = 0;
  let ambiguousPairs = 0;

  for (const a of aRecords) {
    for (const b of bRecords) {
      const verdict = classifyPair(scorePair(a, b));
      if (verdict === "high_confidence") {
        highConfidencePairs += 1;
        matchedA.add(a.sourcePropertyId);
        matchedB.add(b.sourcePropertyId);
      } else if (verdict === "ambiguous") {
        ambiguousPairs += 1;
        ambiguousA.add(a.sourcePropertyId);
        ambiguousB.add(b.sourcePropertyId);
      }
    }
  }

  const aIds = new Set(aRecords.map((r) => r.sourcePropertyId));
  const bIds = new Set(bRecords.map((r) => r.sourcePropertyId));

  const aOnly = [...aIds].filter((id) => !matchedA.has(id) && !ambiguousA.has(id)).length;
  const bOnly = [...bIds].filter((id) => !matchedB.has(id) && !ambiguousB.has(id)).length;

  return {
    destination,
    providerA,
    providerB,
    aTotal: aIds.size,
    bTotal: bIds.size,
    highConfidenceOverlap: matchedA.size,
    ambiguous: ambiguousPairs,
    aOnly,
    bOnly,
    intraProviderDuplicateCandidates: {
      [providerA]: intraProviderDuplicateCandidates(aRecords),
      [providerB]: intraProviderDuplicateCandidates(bRecords),
    },
    // Union BEFORE canonical resolution. Ambiguous pairs are counted as separate
    // candidates because that is what they still are until a human resolves them.
    estimatedUnionBeforeResolution: aIds.size + bIds.size - matchedA.size,
    signalsUsed: [
      "exact normalized name",
      "same website domain",
      `coordinates within ${CLOSE_METRES}m`,
      `coordinate contradiction beyond ${CONTRADICT_METRES}m vetoes a match`,
      `high confidence requires >= 2 agreeing signals (${highConfidencePairs} pairs), 1 signal is ambiguous (${ambiguousPairs} pairs)`,
    ],
  };
}
