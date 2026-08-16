/**
 * Dubai 30-property pilot × live Hotelbeds DXB population.
 *
 * NON-CANONICAL IDENTITY EVIDENCE (D063). This resolves nothing. It reports what
 * agrees, what is ambiguous, and what carries no textual evidence at all — and
 * it invents no match threshold, because a threshold chosen to make the numbers
 * look decisive is not a measurement.
 *
 * ## Evidence is counted by INDEPENDENT DIMENSION
 *
 * The first version of this module counted `exactNormalizedNameAgrees` and
 * `allPilotNameTokensPresent` as two separate positive signals. They are not
 * independent: an exact normalized name match makes token containment true **by
 * construction**. So a single name agreement produced two "signals" and promoted
 * candidates to `strong_multi_signal` with no corroborating evidence whatsoever,
 * inflating that count.
 *
 * Evidence is now grouped into dimensions that can genuinely fail independently:
 *
 *   NAME     exact | token_containment | none   — one dimension, two strengths
 *   DOMAIN   website host agreement
 *   ADDRESS  normalized address agreement
 *   PHONE    unavailable here: the pilot supplies no phone column
 *
 * `strong_multi_signal` requires **two or more dimensions in agreement**. An
 * exact name match, however convincing it reads, is one dimension.
 *
 * ## Coordinates
 *
 * The pilot has **0 of 30 coordinates**. With nothing to compare against, a
 * provider coordinate can never be "agreement". It is **COORDINATE ENRICHMENT
 * AVAILABLE**, and only once identity is resolved does it become anything more.
 */
import { normalizeDomain, normalizeName } from "../overlap";

export interface PilotEntryLike {
  sourcePropertyId: string | null;
  name: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  websiteUrl: string | null;
}

export interface ProviderRecordLike {
  id: string;
  name: string | null;
  address: string | null;
  websiteUrl: string | null;
  phone: string | null;
  chain: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** Strength WITHIN the name dimension. Never two dimensions. */
export type NameEvidence = "exact" | "token_containment" | "none";

/**
 * A dimension's state. `unavailable` is deliberately distinct from `false`:
 * "neither side supplied an address" is not evidence of disagreement, and
 * collapsing the two would quietly turn missing data into a negative finding.
 */
export type DimensionState = "agrees" | "differs" | "unavailable";

export interface PilotPairEvidence {
  providerId: string;
  providerName: string | null;
  /** ONE dimension. `exact` and `token_containment` are strengths, not signals. */
  nameEvidence: NameEvidence;
  domain: DimensionState;
  address: DimensionState;
  phone: DimensionState;
  /** How many INDEPENDENT dimensions agree. */
  agreeingDimensions: number;
  providerHasValidCoordinates: boolean;
}

export type PilotOutcome =
  | "strong_multi_signal"
  | "plausible_single_signal"
  | "ambiguous_multiple_candidates"
  | "no_textual_evidence"
  | "not_yet_assessable";

export interface PilotEntryFinding {
  pilotId: string | null;
  pilotName: string | null;
  outcome: PilotOutcome;
  candidates: PilotPairEvidence[];
  /** True when at least one candidate carries valid provider coordinates. */
  coordinateEnrichmentAvailable: boolean;
}

export interface PilotComparison {
  pilotEntries: number;
  providerRecords: number;
  pilotEntriesWithCoordinates: number;
  outcomes: Record<PilotOutcome, number>;
  coordinateEnrichmentAvailable: number;
  /** Which dimensions were usable at all, given what each side supplies. */
  dimensionAvailability: Record<string, string>;
  findings: PilotEntryFinding[];
  disclaimers: string[];
}

function validCoordinates(lat: number | null, lon: number | null): boolean {
  if (typeof lat !== "number" || typeof lon !== "number") return false;
  if (lat === 0 && lon === 0) return false;
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/** Tokens long enough to carry signal; short connective words are noise. */
function significantTokens(name: string): string[] {
  return normalizeName(name)
    .split(" ")
    .filter((t) => t.length >= 4);
}

/**
 * Address comparison, deliberately conservative.
 *
 * Exact equality of the normalized string only. Street addresses differ in
 * abbreviation, ordering and language across sources, so anything looser needs a
 * similarity threshold — and a threshold invented to raise the match count is
 * not evidence. This under-reports agreement, which is the safe direction.
 */
function addressState(a: string | null, b: string | null): DimensionState {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (left === "" || right === "") return "unavailable";
  return left === right ? "agrees" : "differs";
}

function domainState(a: string | null, b: string | null): DimensionState {
  const left = normalizeDomain(a);
  const right = normalizeDomain(b);
  if (left === "" || right === "") return "unavailable";
  return left === right ? "agrees" : "differs";
}

function nameEvidenceFor(pilotName: string | null, providerName: string | null): NameEvidence {
  const left = normalizeName(pilotName);
  const right = normalizeName(providerName);
  if (left === "" || right === "") return "none";
  if (left === right) return "exact";
  const tokens = significantTokens(pilotName ?? "");
  if (tokens.length > 0 && tokens.every((t) => right.includes(t))) return "token_containment";
  return "none";
}

function evidenceFor(pilot: PilotEntryLike, record: ProviderRecordLike): PilotPairEvidence {
  const nameEvidence = nameEvidenceFor(pilot.name, record.name);
  const domain = domainState(pilot.websiteUrl, record.websiteUrl);
  const address = addressState(pilot.address, record.address);
  // The pilot supplies no phone column, so this dimension cannot be evaluated at
  // all. Stated explicitly rather than silently scored as a non-match — and it
  // therefore contributes nothing to the dimension count below.
  const phone: DimensionState = "unavailable";

  const agreeingDimensions =
    (nameEvidence === "none" ? 0 : 1) +
    (domain === "agrees" ? 1 : 0) +
    (address === "agrees" ? 1 : 0);

  return {
    providerId: record.id,
    providerName: record.name,
    nameEvidence,
    domain,
    address,
    phone,
    agreeingDimensions,
    providerHasValidCoordinates: validCoordinates(record.latitude, record.longitude),
  };
}

/** Ranking key: more dimensions first, then exact name over token containment. */
function strengthKey(e: PilotPairEvidence): [number, number] {
  return [e.agreeingDimensions, e.nameEvidence === "exact" ? 1 : 0];
}

function compareStrength(a: PilotPairEvidence, b: PilotPairEvidence): number {
  const [ad, an] = strengthKey(a);
  const [bd, bn] = strengthKey(b);
  return bd - ad || bn - an;
}

/**
 * Compare the pilot list against the live provider population.
 *
 * Deliberately NOT a resolver. Outcomes describe the STATE OF THE EVIDENCE:
 *
 *  - `strong_multi_signal` — one clear candidate with **two or more independent
 *    dimensions** in agreement
 *  - `plausible_single_signal` — exactly one candidate, agreeing on one dimension
 *  - `ambiguous_multiple_candidates` — several candidates carry evidence and
 *    nothing independent separates them
 *  - `no_textual_evidence` — nothing agreed. NOT "the provider lacks it": names
 *    transliterate, rebrand and abbreviate
 *  - `not_yet_assessable` — the pilot entry supplies no comparable signal
 */
export function comparePilotAgainstProvider(
  pilot: readonly PilotEntryLike[],
  provider: readonly ProviderRecordLike[],
): PilotComparison {
  const findings: PilotEntryFinding[] = [];

  for (const entry of pilot) {
    const hasSignal = Boolean(
      normalizeName(entry.name) ||
      normalizeDomain(entry.websiteUrl) ||
      normalizeName(entry.address),
    );
    if (!hasSignal) {
      findings.push({
        pilotId: entry.sourcePropertyId,
        pilotName: entry.name,
        outcome: "not_yet_assessable",
        candidates: [],
        coordinateEnrichmentAvailable: false,
      });
      continue;
    }

    const candidates = provider
      .map((record) => evidenceFor(entry, record))
      .filter((e) => e.agreeingDimensions > 0)
      .sort(compareStrength);

    const top = candidates[0];
    const second = candidates[1];

    let outcome: PilotOutcome;
    if (!top) {
      outcome = "no_textual_evidence";
    } else if (!second) {
      outcome = top.agreeingDimensions >= 2 ? "strong_multi_signal" : "plausible_single_signal";
    } else if (top.agreeingDimensions >= 2 && top.agreeingDimensions > second.agreeingDimensions) {
      // A clear leader on independent evidence. Anything less than that — a tie,
      // or a lead resting on one dimension — stays ambiguous, because separating
      // them would need a threshold we have no basis to invent.
      outcome = "strong_multi_signal";
    } else {
      outcome = "ambiguous_multiple_candidates";
    }

    findings.push({
      pilotId: entry.sourcePropertyId,
      pilotName: entry.name,
      outcome,
      candidates: candidates.slice(0, 5),
      coordinateEnrichmentAvailable: candidates.some((c) => c.providerHasValidCoordinates),
    });
  }

  const outcomes: Record<PilotOutcome, number> = {
    strong_multi_signal: 0,
    plausible_single_signal: 0,
    ambiguous_multiple_candidates: 0,
    no_textual_evidence: 0,
    not_yet_assessable: 0,
  };
  for (const f of findings) outcomes[f.outcome] += 1;

  const pilotWithAddress = pilot.filter((p) => normalizeName(p.address) !== "").length;
  const pilotWithWebsite = pilot.filter((p) => normalizeDomain(p.websiteUrl) !== "").length;

  return {
    pilotEntries: pilot.length,
    providerRecords: provider.length,
    pilotEntriesWithCoordinates: pilot.filter((p) => validCoordinates(p.latitude, p.longitude))
      .length,
    outcomes,
    coordinateEnrichmentAvailable: findings.filter((f) => f.coordinateEnrichmentAvailable).length,
    findings,
    dimensionAvailability: {
      name: `available — pilot supplies ${pilot.filter((p) => normalizeName(p.name) !== "").length}/${pilot.length}`,
      domain: `available — pilot supplies ${pilotWithWebsite}/${pilot.length}; provider website coverage is partial`,
      address: `available — pilot supplies ${pilotWithAddress}/${pilot.length}; compared by exact normalized equality only`,
      phone: "UNAVAILABLE — the pilot artifact carries no phone column",
    },
    disclaimers: [
      "NON-CANONICAL. No entity was resolved and no match threshold was invented (D063).",
      "Evidence is counted by INDEPENDENT DIMENSION. `exact` and `token_containment` are strengths within the NAME dimension, never two signals — an exact name match satisfies token containment by construction.",
      "strong_multi_signal requires TWO OR MORE independent dimensions in agreement. An exact name match alone is a single dimension.",
      "Address agreement is exact normalized equality only. Anything looser needs a similarity threshold, so this under-reports agreement rather than inventing one.",
      "The pilot carries 0 of 30 coordinates, so provider coordinates can never be coordinate AGREEMENT here. They are COORDINATE ENRICHMENT AVAILABLE, and only once identity is resolved do they become anything more.",
      "no_textual_evidence means our signals did not agree — NOT that the provider lacks the property. Names transliterate, rebrand and abbreviate.",
      "The 30-property pilot is a TECHNICAL PILOT (D061). It is not Dubai inventory and is not a coverage baseline.",
    ],
  };
}
