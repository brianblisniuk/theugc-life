/**
 * Classification: raw source observation, then D060 interpretation.
 *
 * Two layers, deliberately separate.
 *
 * **Layer 1 — observation.** What the provider actually said. For a provider
 * whose hotels response carries only a CODE (the Hotelbeds shape), that means
 * joining the code against master/reference data to recover its meaning. A
 * failed join is a recorded outcome, not a silent null.
 *
 * **Layer 2 — interpretation.** Whether that evidence resolves D060's exact
 * 4-or-5 hotel classification. This is where `APARTMENT` + `5 KEY` is rejected:
 * it is a real classification, and it is not five hotel stars.
 *
 * Collapsing the layers is how `simpleCode == 5` quietly becomes "five-star
 * hotel", which is the specific failure this module exists to prevent.
 */
import { readPath } from "./normalize";
import type {
  AdapterDescriptor,
  ClassificationMaster,
  RawClassificationObservation,
  ReferenceData,
  StarEligibility,
} from "./types";

function asString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

/**
 * Observe the provider's classification evidence for one property.
 *
 * No judgement is applied here — not even "is this a hotel". The result records
 * what was found and how the lookup resolved.
 */
export function observeClassification(
  payload: unknown,
  descriptor: AdapterDescriptor,
  reference: ReferenceData,
): RawClassificationObservation {
  const { mode, codePath } = descriptor.classification;

  if (mode !== "code_with_master_lookup" || !codePath) {
    return { sourceCode: null, master: null, resolution: "not_applicable" };
  }

  const sourceCode = asString(readPath(payload, codePath));
  if (!sourceCode) {
    return { sourceCode: null, master: null, resolution: "unresolved_no_code" };
  }

  const master = reference.classifications.get(sourceCode) ?? null;
  if (!master) {
    // The property references a code the master data does not explain. That is
    // source-quality evidence, and it must not be mistaken for "no category".
    return { sourceCode, master: null, resolution: "unresolved_no_master_entry" };
  }

  return { sourceCode, master, resolution: "resolved" };
}

/**
 * Parse a master record's `simpleCode` into a numeric classification level.
 *
 * Returns null when it is not a plain number. **No numeric value is ever
 * manufactured from the code string** — `5EST` does not become 5 here; only an
 * explicit `simpleCode` supplied by the master data counts.
 */
export function numericLevelFrom(master: ClassificationMaster): number | null {
  if (master.simpleCode === null) return null;
  const trimmed = master.simpleCode.trim();
  // Strict: digits only. "5" is a level; "5EST" or "5 KEY" is not a number.
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Does this master record describe a HOTEL star classification?
 *
 * Requires the descriptor to have declared which accommodation types carry one.
 * With none declared, the answer is always no — guessing would prejudge exactly
 * the question the bake-off exists to answer.
 */
export function isHotelClassification(
  master: ClassificationMaster,
  descriptor: AdapterDescriptor,
): boolean {
  const accepted = descriptor.classification.hotelAccommodationTypes;
  if (accepted.length === 0) return false;
  if (!master.accommodationType) return false;
  return accepted.some((t) => t.toLowerCase() === master.accommodationType?.toLowerCase());
}

/**
 * Interpret a classification observation against D060's EXACT 4-or-5 rule.
 *
 * Everything that is not a confidently resolved hotel classification of exactly
 * 4 or 5 lands in `unresolved` or `classified_not_v1_scope` — never in an
 * eligible bucket.
 */
export function interpretClassificationForD060(
  observation: RawClassificationObservation,
  descriptor: AdapterDescriptor,
): StarEligibility {
  if (observation.resolution !== "resolved" || !observation.master) return "unresolved";

  // Without an established issuing authority the value cannot satisfy
  // publishability condition 7, so it is evidence we cannot yet act on.
  if (!descriptor.classification.issuerEstablished) return "unresolved";

  // "5 KEY" on an apartment is a real classification and not five hotel stars.
  if (!isHotelClassification(observation.master, descriptor)) return "unresolved";

  const level = numericLevelFrom(observation.master);
  if (level === null) return "unresolved";
  if (!Number.isFinite(level) || level <= 0 || level > 5) return "unresolved";

  if (level === 5) return "exact_five";
  if (level === 4) return "exact_four";
  return "classified_not_v1_scope";
}

/** Build reference data from raw master payloads, via a descriptor-driven map. */
export function buildClassificationMaster(
  payloads: readonly unknown[],
  paths: {
    code: string;
    simpleCode?: string | null;
    accommodationType?: string | null;
    group?: string | null;
    description?: string | null;
  },
): Map<string, ClassificationMaster> {
  const out = new Map<string, ClassificationMaster>();
  for (const payload of payloads) {
    const code = asString(readPath(payload, paths.code));
    if (!code) continue;
    out.set(code, {
      code,
      simpleCode: asString(readPath(payload, paths.simpleCode)),
      accommodationType: asString(readPath(payload, paths.accommodationType)),
      group: asString(readPath(payload, paths.group)),
      description: asString(readPath(payload, paths.description)),
    });
  }
  return out;
}
