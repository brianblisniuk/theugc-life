/**
 * Adapter registry and the runnability gate.
 *
 * `assertRunnable` is the integrity mechanism of this harness. A provider
 * descriptor may only execute once the facts the pipeline actually reads have
 * been established FROM OFFICIAL DOCUMENTATION.
 *
 * This matters more than it looks. Guessed paths do not crash — they read
 * `undefined`, and the harness would cheerfully report "coordinate coverage 0%,
 * star coverage 0%" for a provider that supplies both. That output is
 * indistinguishable from a measurement, and it would be used to choose a
 * provider.
 */
import type { AdapterDescriptor, EvaluationDestination } from "../types";
import { bookingDemandDescriptor } from "./booking";
import { expediaRapidDescriptor } from "./expedia";

export const ADAPTERS: readonly AdapterDescriptor[] = [
  bookingDemandDescriptor,
  expediaRapidDescriptor,
];

export function getAdapter(provider: string): AdapterDescriptor {
  const found = ADAPTERS.find((a) => a.provider === provider);
  if (!found) {
    throw new Error(
      `Unknown provider "${provider}". Known: ${ADAPTERS.map((a) => a.provider).join(", ")}`,
    );
  }
  return found;
}

/** Field-map keys without which no metric in the brief can be computed. */
const REQUIRED_FIELD_MAP_KEYS = ["sourcePropertyId", "name", "latitude", "longitude"] as const;

export interface RunnabilityProblem {
  provider: string;
  reasons: string[];
}

/**
 * Check whether a descriptor may run, optionally for a specific destination.
 *
 * Destination-scoped because geography is resolved per destination: a descriptor
 * can legitimately be ready for Dubai and not for Bali.
 */
export function checkRunnable(
  descriptor: AdapterDescriptor,
  destination?: EvaluationDestination,
): RunnabilityProblem | null {
  const reasons: string[] = [];

  if (descriptor.documentationStatus !== "verified") {
    reasons.push(
      `Adapter descriptor is ${descriptor.documentationStatus.toUpperCase()}: not every fact the pipeline reads has been confirmed against official documentation.`,
    );
  }
  if (descriptor.sources.length === 0) {
    reasons.push("No official documentation sources recorded.");
  }
  if (!descriptor.baseUrl) {
    reasons.push("No API base URL recorded.");
  }
  if (!descriptor.staticContentEndpoint) {
    reasons.push(
      "No static-content endpoint recorded. A coverage universe must come from what EXISTS, never from an availability/search endpoint.",
    );
  }
  if (!descriptor.pagination) {
    reasons.push("No pagination method recorded; exhaustion could not be proven.");
  }

  for (const key of REQUIRED_FIELD_MAP_KEYS) {
    if (!descriptor.fieldMap[key]) {
      reasons.push(`Field map is missing a verified path for "${key}".`);
    }
  }

  // Star paths are required explicitly. `starValue` must be mapped, and the
  // qualifier must either be mapped or documented as absent — never inferred
  // from a naming convention.
  if (!descriptor.fieldMap.starValue) {
    reasons.push('Field map is missing a verified path for "starValue" (D060).');
  }
  if (!descriptor.fieldMap.starKind && !descriptor.starKindDocumentedAbsent) {
    reasons.push(
      'Field map has no "starKind" path and the provider is not documented as supplying none. ' +
        "A star qualifier must be mapped explicitly or its absence documented; it is never derived from a naming convention.",
    );
  }
  // `null` means "documented as not supplied" and is acceptable; `undefined`
  // means "nobody has established this yet" and is not. Conflating them would
  // let an unknown quietly pass as a finding.
  if (descriptor.fieldMap.reviewScore === undefined) {
    reasons.push(
      'Field map has no "reviewScore" entry. Map it so the harness can prove a guest-review score is never read as a classification, or set it explicitly to null if the provider is documented to supply none.',
    );
  }

  if (descriptor.starSemantics.length === 0) {
    reasons.push("Star semantics have not been established (D060).");
  }
  if (
    descriptor.starKindsAcceptedAsD060Evidence.length === 0 &&
    !descriptor.starKindDocumentedAbsent
  ) {
    reasons.push(
      "No star `kind` values have been accepted as D060 evidence. A field named `stars` is not automatically a hospitality classification.",
    );
  }

  if (descriptor.geography.length === 0) {
    reasons.push(
      "Provider geography for Bali/Dubai has not been resolved. A destination must be resolved, never assumed.",
    );
  } else if (destination && !descriptor.geography.some((g) => g.destination === destination)) {
    reasons.push(`Provider geography for "${destination}" has not been resolved.`);
  }

  reasons.push(...descriptor.blockers);

  return reasons.length > 0 ? { provider: descriptor.provider, reasons } : null;
}

export function assertRunnable(
  descriptor: AdapterDescriptor,
  destination?: EvaluationDestination,
): void {
  const problem = checkRunnable(descriptor, destination);
  if (problem) {
    throw new Error(
      `Provider "${problem.provider}" cannot be evaluated yet:\n` +
        problem.reasons.map((r) => `  - ${r}`).join("\n") +
        "\n\nThis is deliberate. Establish the missing facts from official documentation first;\n" +
        "running with an unverified field map would produce numbers that look measured.",
    );
  }
}
