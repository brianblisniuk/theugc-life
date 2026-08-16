/**
 * Field-map driven normalization and D060 star classification.
 *
 * Provider payloads are read through the descriptor's `fieldMap` rather than
 * hand-written per-provider parsing, so the reviewable artifact is a field map
 * traceable to official documentation.
 *
 * There is deliberately NO path inference anywhere in this module. An earlier
 * version derived the star-qualifier path from the value path by appending
 * `_type`; that is a guessed field path wearing a convention as a disguise, and
 * it is gone. If a provider supplies no qualifier, the descriptor must say so
 * explicitly (`starKindDocumentedAbsent`).
 */
import { observeClassification } from "./classification";
import type {
  AdapterDescriptor,
  EvaluationDestination,
  EvaluationRecord,
  RecordAccounting,
  ReferenceData,
  StarEligibility,
  StarObservation,
} from "./types";
import { emptyReferenceData } from "./types";

/** Read a dotted path out of an arbitrary payload. Missing → null, never throw. */
export function readPath(source: unknown, path: string | null | undefined): unknown {
  if (!path) return null;
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return current ?? null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  const n = asNumber(value);
  return n !== null && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Build the star observation from EXPLICIT mapped paths only.
 *
 * `reviewScore` is read into its own field and never falls back into `value`.
 * A provider supplying only a review score leaves the classification null, which
 * makes the property star-UNRESOLVED — a review state under D060/D061, and
 * explicitly not the same fact as "below scope".
 */
export function buildStarObservation(
  payload: unknown,
  descriptor: AdapterDescriptor,
): StarObservation {
  const { starValue, starKind, reviewScore } = descriptor.fieldMap;

  return {
    value: starValue ? asNumber(readPath(payload, starValue)) : null,
    // No inference. An unmapped qualifier is null, full stop.
    kind: starKind ? asString(readPath(payload, starKind)) : null,
    reviewScore: reviewScore ? asNumber(readPath(payload, reviewScore)) : null,
  };
}

/**
 * Is this observation usable as D060 EVIDENCE?
 *
 * Separate from whether it resolves eligibility. Evidence quality and
 * eligibility are two questions, and collapsing them is how a 4.5-star property
 * quietly becomes a 4-star one.
 *
 * Requires an accepted qualifier value — unless the provider is documented to
 * supply no qualifier at all, in which case the value alone may serve. That
 * exemption is gated on an explicit descriptor flag so an unmapped path can
 * never masquerade as a documented absence.
 */
export function isD060Evidence(star: StarObservation, descriptor: AdapterDescriptor): boolean {
  if (star.value === null) return false;

  if (descriptor.starKindDocumentedAbsent) return true;

  if (descriptor.starKindsAcceptedAsD060Evidence.length === 0) return false;
  if (star.kind === null) return false;
  return descriptor.starKindsAcceptedAsD060Evidence.includes(star.kind);
}

/**
 * Classify an observation against D060's EXACT 4-or-5 requirement.
 *
 * Half-star classifications are real in several markets and Expedia's content
 * documentation supports values such as 3.5 and 4.5. A 4.5-star property has a
 * genuine classification that is not exactly 4 and not exactly 5, so it is
 * `classified_not_v1_scope` — never rounded into an eligible bucket.
 *
 * Anything outside the documented 1–5 range is `unresolved` rather than clamped:
 * an unexpected scale means we are misreading the field, and coercing it would
 * hide that.
 */
export function classifyStarEligibility(
  star: StarObservation,
  descriptor: AdapterDescriptor,
): StarEligibility {
  if (!isD060Evidence(star, descriptor)) return "unresolved";

  const value = star.value;
  if (value === null) return "unresolved";

  // Out-of-range or non-finite: we do not understand this scale. Say so.
  if (!Number.isFinite(value) || value <= 0 || value > 5) return "unresolved";

  if (value === 5) return "exact_five";
  if (value === 4) return "exact_four";

  // A real classification that is not exactly 4 or 5: 3, 3.5, 4.5, 1, 2 …
  return "classified_not_v1_scope";
}

/**
 * Derive image evidence from the images COLLECTION.
 *
 * A principal image is not always a field on the property, so pointing a
 * `heroImage` path at the property record would read `undefined` forever and
 * report 0% hero coverage for a provider that actually supplies one.
 *
 * **Two different claims, kept apart.**
 *
 * `hasProviderDesignatedPrincipal` is the provider's own semantic, per its
 * documentation. It is the only one that may be reported as hero-image
 * coverage.
 *
 * `hasDeterministicRepresentativeCandidate` says a single image can be SELECTED
 * without ambiguity. That is an engineering convenience with
 * `selection_origin = local_deterministic_fallback` — it does not establish that
 * the image is the one the provider considers principal, because the provider
 * has not documented whether maximum, minimum, array order or some other
 * transformation is intended. Calling it "principal" would manufacture provider
 * semantics we do not have.
 *
 * A property with images but no provider designation is a **documented, valid
 * state**, not a failure and not a contradiction — the absence is not
 * reinterpreted anywhere in this module.
 */
export function deriveImageEvidence(
  payload: unknown,
  descriptor: AdapterDescriptor,
): {
  photoCount: number;
  hasProviderDesignatedPrincipal: boolean;
  hasDeterministicRepresentativeCandidate: boolean;
  imageTypes: string[];
  imagesWithPath: number;
} {
  const raw = descriptor.fieldMap.photos ? readPath(payload, descriptor.fieldMap.photos) : null;
  const images = Array.isArray(raw) ? raw : [];
  const { path: pathKey, type: typeKey, visualOrder: orderKey } = descriptor.imageFieldMap;
  const selector = descriptor.imageFieldMap.principalSelector ?? "visual_order_zero";

  const types = new Set<string>();
  const visualOrders: number[] = [];
  let withPath = 0;

  for (const image of images) {
    if (pathKey && asString(readPath(image, pathKey)) !== null) withPath += 1;
    if (typeKey) {
      const type = asString(readPath(image, typeKey));
      if (type) types.add(type);
    }
    if (orderKey) {
      const order = asNumber(readPath(image, orderKey));
      if (order !== null) visualOrders.push(order);
    }
  }

  // The PROVIDER-DESIGNATED principal, per documented semantics.
  let providerDesignated = visualOrders.includes(0);

  // A provider WITH an explicit hero field still wins, when it has one — that is
  // also a provider designation, not a local guess.
  if (!providerDesignated && descriptor.fieldMap.heroImage) {
    providerDesignated = readPath(payload, descriptor.fieldMap.heroImage) !== null;
  }

  // LOCAL FALLBACK, opt-in only. A unique extremum means one image can be picked
  // deterministically; ties do not qualify, because a tie is exactly the case
  // where no single image can be chosen without inventing a rule.
  let representative = false;
  if (selector === "deterministic_representative_fallback" && visualOrders.length > 0) {
    const max = Math.max(...visualOrders);
    representative = visualOrders.filter((v) => v === max).length === 1;
  }

  return {
    photoCount: images.length,
    hasProviderDesignatedPrincipal: providerDesignated,
    hasDeterministicRepresentativeCandidate: representative,
    imageTypes: [...types],
    imagesWithPath: withPath,
  };
}

export function normalizeRecord(
  payload: unknown,
  descriptor: AdapterDescriptor,
  destination: EvaluationDestination,
  reference: ReferenceData = emptyReferenceData(),
): EvaluationRecord | null {
  const sourcePropertyId = asString(readPath(payload, descriptor.fieldMap.sourcePropertyId));
  // A record with no provider id cannot be counted, deduplicated or matched.
  // The caller records the rejection rather than losing it (see normalizeAll).
  if (!sourcePropertyId) return null;

  const { fieldMap } = descriptor;

  return {
    provider: descriptor.provider,
    destination,
    sourcePropertyId,
    name: asString(readPath(payload, fieldMap.name)),
    propertyType: asString(readPath(payload, fieldMap.propertyType)),
    address: asString(readPath(payload, fieldMap.address)),
    latitude: asNumber(readPath(payload, fieldMap.latitude)),
    longitude: asNumber(readPath(payload, fieldMap.longitude)),
    brand: asString(readPath(payload, fieldMap.brand)),
    chain: asString(readPath(payload, fieldMap.chain)),
    websiteUrl: asString(readPath(payload, fieldMap.websiteUrl)),
    phone: asString(readPath(payload, fieldMap.phone)),
    providerContact: asString(readPath(payload, fieldMap.providerContact)),
    star: buildStarObservation(payload, descriptor),
    classification: observeClassification(payload, descriptor, reference),
    ...deriveImageEvidence(payload, descriptor),
    activeStatus: asString(readPath(payload, fieldMap.activeStatus)),
  };
}

export interface NormalizationOutcome {
  records: EvaluationRecord[];
  accounting: RecordAccounting;
}

/**
 * Normalize a raw payload set, PRESERVING the accounting.
 *
 * The raw count never disappears into the normalized count. A provider
 * returning identity-less records is telling us something about its data
 * quality, and that signal has to survive to the metrics denominator — otherwise
 * "1000 records" silently becomes "the 940 we could read".
 */
export function normalizeAll(
  payloads: readonly unknown[],
  descriptor: AdapterDescriptor,
  destination: EvaluationDestination,
  reference: ReferenceData = emptyReferenceData(),
): NormalizationOutcome {
  const records: EvaluationRecord[] = [];
  let missingId = 0;

  for (const payload of payloads) {
    const record = normalizeRecord(payload, descriptor, destination, reference);
    if (record) {
      records.push(record);
    } else {
      missingId += 1;
    }
  }

  const uniqueIds = new Set(records.map((r) => r.sourcePropertyId));

  return {
    records,
    accounting: {
      rawRecordsReturned: payloads.length,
      normalizedRecords: records.length,
      recordsMissingSourcePropertyId: missingId,
      // Reserved for future normalization failures beyond a missing id; kept
      // explicit so a new reject reason cannot be folded into the id count.
      otherNormalizationRejects: payloads.length - records.length - missingId,
      uniqueSourcePropertyIds: uniqueIds.size,
      duplicateIdRecords: records.length - uniqueIds.size,
    },
  };
}

/** Coordinates that are present, in range, and not the null island. */
export function hasValidCoordinates(record: EvaluationRecord): boolean {
  const { latitude: lat, longitude: lon } = record;
  if (lat === null || lon === null) return false;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
  // 0,0 is in the Gulf of Guinea and is almost always a missing-value sentinel.
  if (lat === 0 && lon === 0) return false;
  return true;
}
