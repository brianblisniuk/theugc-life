/**
 * Field-map driven normalization.
 *
 * Provider payloads are read through the adapter descriptor's `fieldMap` rather
 * than through hand-written per-provider parsing. Two reasons:
 *
 *  - the reviewable artifact becomes a field map traceable to official docs,
 *    instead of parsing logic whose assumptions are invisible;
 *  - an unverified field map is detectable, so the harness can refuse to run
 *    rather than emit confident numbers built on guessed paths.
 *
 * The star rules are enforced here, at the point of normalization, because that
 * is the only place where a review score and a classification are both in scope
 * and could be confused (D060).
 */
import type {
  AdapterDescriptor,
  EvaluationDestination,
  EvaluationRecord,
  StarObservation,
} from "./types";

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
 * Build the star observation.
 *
 * `reviewScore` is read into its own field and never falls back into `value`.
 * If a provider supplies only a review score, the classification stays null —
 * that property is star-UNRESOLVED, which under D060/D061 is a review state and
 * explicitly not the same fact as "below scope".
 */
export function buildStarObservation(
  payload: unknown,
  descriptor: AdapterDescriptor,
): StarObservation {
  const starPath = descriptor.fieldMap.star ?? null;
  const value = starPath ? asNumber(readPath(payload, starPath)) : null;

  const kindPath = descriptor.starSemantics?.fieldName
    ? `${descriptor.starSemantics.fieldName}_type`
    : null;
  // The descriptor may map the kind explicitly; fall back to the convention only
  // when it does, never inventing a path of our own.
  const explicitKindPath = (descriptor.fieldMap as Record<string, string | null | undefined>)[
    "starKind"
  ];
  const kind = asString(readPath(payload, explicitKindPath ?? kindPath));

  const reviewPath = (descriptor.fieldMap as Record<string, string | null | undefined>)[
    "reviewScore"
  ];
  const reviewScore = reviewPath ? asNumber(readPath(payload, reviewPath)) : null;

  return { value, kind, reviewScore };
}

/**
 * Is this star observation usable as D060 evidence?
 *
 * Requires BOTH a value in {4,5}-capable range AND a `kind` the descriptor has
 * explicitly accepted from official documentation. A star field with an
 * unrecognised or absent kind is not evidence, however plausible its number —
 * that is precisely the "a field called stars is not automatically stars" rule.
 */
export function isD060Evidence(star: StarObservation, descriptor: AdapterDescriptor): boolean {
  if (star.value === null) return false;
  if (descriptor.starKindsAcceptedAsD060Evidence.length === 0) return false;
  if (star.kind === null) return false;
  return descriptor.starKindsAcceptedAsD060Evidence.includes(star.kind);
}

export function normalizeRecord(
  payload: unknown,
  descriptor: AdapterDescriptor,
  destination: EvaluationDestination,
): EvaluationRecord | null {
  const sourcePropertyId = asString(readPath(payload, descriptor.fieldMap.sourcePropertyId));
  // A record with no provider id cannot be counted, deduplicated or matched.
  if (!sourcePropertyId) return null;

  const photosPath = descriptor.fieldMap.photos ?? null;
  const heroPath = descriptor.fieldMap.heroImage ?? null;

  return {
    provider: descriptor.provider,
    destination,
    sourcePropertyId,
    name: asString(readPath(payload, descriptor.fieldMap.name)),
    propertyType: asString(readPath(payload, descriptor.fieldMap.propertyType)),
    address: asString(readPath(payload, descriptor.fieldMap.address)),
    latitude: asNumber(readPath(payload, descriptor.fieldMap.latitude)),
    longitude: asNumber(readPath(payload, descriptor.fieldMap.longitude)),
    brand: asString(readPath(payload, descriptor.fieldMap.brand)),
    chain: asString(readPath(payload, descriptor.fieldMap.chain)),
    websiteUrl: asString(readPath(payload, descriptor.fieldMap.websiteUrl)),
    providerContact: asString(readPath(payload, descriptor.fieldMap.providerContact)),
    star: buildStarObservation(payload, descriptor),
    photoCount: photosPath ? asCount(readPath(payload, photosPath)) : 0,
    hasHeroImage: heroPath ? readPath(payload, heroPath) !== null : false,
    activeStatus: asString(readPath(payload, descriptor.fieldMap.activeStatus)),
  };
}

export function normalizeAll(
  payloads: readonly unknown[],
  descriptor: AdapterDescriptor,
  destination: EvaluationDestination,
): EvaluationRecord[] {
  const out: EvaluationRecord[] = [];
  for (const payload of payloads) {
    const record = normalizeRecord(payload, descriptor, destination);
    if (record) out.push(record);
  }
  return out;
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
