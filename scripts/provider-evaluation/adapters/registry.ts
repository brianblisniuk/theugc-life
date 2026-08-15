/**
 * Adapter registry and the runnability gate.
 *
 * `assertRunnable` is the integrity mechanism of this whole harness. A provider
 * descriptor may only execute once its field map and star semantics have been
 * filled in FROM OFFICIAL DOCUMENTATION. Until then the harness refuses to run
 * that provider rather than producing metrics from guessed field paths.
 *
 * This matters more than it looks. Guessed paths do not crash — they silently
 * read `undefined`, and the harness would cheerfully report "coordinate coverage
 * 0%, star coverage 0%" for a provider that supplies both. That output is
 * indistinguishable from a measured result, and it would be used to choose a
 * provider.
 */
import type { AdapterDescriptor } from "../types";
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

export function checkRunnable(descriptor: AdapterDescriptor): RunnabilityProblem | null {
  const reasons: string[] = [];

  if (descriptor.documentationStatus !== "verified") {
    reasons.push(
      "Adapter descriptor is UNVERIFIED: its endpoints, pagination and field map have not been confirmed against the provider's official documentation.",
    );
  }
  if (descriptor.sources.length === 0) {
    reasons.push("No official documentation sources recorded.");
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
  if (!descriptor.starSemantics) {
    reasons.push("Star semantics have not been established (D060).");
  }
  if (descriptor.starKindsAcceptedAsD060Evidence.length === 0) {
    reasons.push(
      "No star `kind` values have been accepted as D060 evidence. A field named `stars` is not automatically a hospitality classification.",
    );
  }
  if (descriptor.geography.length === 0) {
    reasons.push(
      "Provider geography for Bali/Dubai has not been resolved. A destination must be resolved, never assumed.",
    );
  }

  reasons.push(...descriptor.blockers);

  return reasons.length > 0 ? { provider: descriptor.provider, reasons } : null;
}

export function assertRunnable(descriptor: AdapterDescriptor): void {
  const problem = checkRunnable(descriptor);
  if (problem) {
    throw new Error(
      `Provider "${problem.provider}" cannot be evaluated yet:\n` +
        problem.reasons.map((r) => `  - ${r}`).join("\n") +
        "\n\nThis is deliberate. Fill the descriptor in from official documentation first;\n" +
        "running with an unverified field map would produce numbers that look measured.",
    );
  }
}
