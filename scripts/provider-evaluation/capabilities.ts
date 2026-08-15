/**
 * Capability-specific runnability gates.
 *
 * The previous gate was all-or-nothing: one unresolved star issuer refused the
 * whole run. That is backwards for a source bake-off. A provider can be an
 * excellent inventory, location and media source while its classification needs
 * secondary verification, and refusing to measure the first three teaches us
 * nothing about the question we are actually asking.
 *
 * So each dimension is assessed independently, and a run reports what it COULD
 * measure alongside what it could not.
 *
 * **This does not weaken D060.** `resolve_d060_classification` is still gated on
 * an established issuer and accepted classification semantics, and nothing here
 * changes what may be published. It only lets the evaluation measure dimensions
 * separately.
 */
import type {
  AdapterDescriptor,
  CapabilityAssessment,
  EvaluationCapability,
  EvaluationDestination,
  RuntimeObservation,
} from "./types";
import { unknownRuntime } from "./types";

export const ALL_CAPABILITIES: readonly EvaluationCapability[] = [
  "enumerate_inventory",
  "measure_location",
  "measure_media",
  "assess_classification",
  "resolve_d060_classification",
];

/**
 * Blockers that stop every dimension.
 *
 * Static descriptor facts only, plus the CURRENT runtime observation. A previous
 * run's egress failure is not a provider fact and must never be baked into the
 * descriptor — otherwise allowlisting the host leaves everything blocked by a
 * stale string.
 */
function globalReasons(
  descriptor: AdapterDescriptor,
  destination?: EvaluationDestination,
  runtime: RuntimeObservation = unknownRuntime(),
): string[] {
  const reasons: string[] = [];

  // Only a CURRENTLY observed block counts. `unknown` does not pre-emptively
  // block: the probe is what decides, and it must be allowed to run.
  if (runtime.egress === "blocked") {
    reasons.push(
      `EGRESS currently BLOCKED${runtime.detail ? ` (${runtime.detail})` : ""}. This is a runtime observation, not a provider fact — re-probe after the host is allowlisted.`,
    );
  }
  if (runtime.credentials === "invalid") {
    reasons.push("Credentials were REJECTED by the provider on the last probe.");
  }

  if (!descriptor.baseUrl) reasons.push("No API base URL recorded.");
  if (!descriptor.staticContentEndpoint) {
    reasons.push(
      "No static-content endpoint recorded. A coverage universe must come from what EXISTS, never from an availability/search endpoint.",
    );
  }
  if (!descriptor.pagination) {
    reasons.push("No pagination method recorded; exhaustion could not be proven.");
  }
  if (!descriptor.fieldMap.sourcePropertyId) {
    reasons.push('Field map is missing a path for "sourcePropertyId".');
  }
  if (descriptor.geography.length === 0) {
    reasons.push(
      "Provider geography has not been resolved. Run the geography-discovery phase first — it is deliberately NOT gated on classification.",
    );
  } else if (destination && !descriptor.geography.some((g) => g.destination === destination)) {
    reasons.push(`Provider geography for "${destination}" has not been resolved.`);
  }

  reasons.push(...descriptor.blockers);
  return reasons;
}

function scoped(descriptor: AdapterDescriptor, capability: EvaluationCapability): string[] {
  return descriptor.capabilityBlockers[capability] ?? [];
}

export function assessCapability(
  descriptor: AdapterDescriptor,
  capability: EvaluationCapability,
  destination?: EvaluationDestination,
  runtime: RuntimeObservation = unknownRuntime(),
): CapabilityAssessment {
  const reasons = [
    ...globalReasons(descriptor, destination, runtime),
    ...scoped(descriptor, capability),
  ];

  switch (capability) {
    case "enumerate_inventory":
      // Nothing beyond the global requirements: an id and a way to page.
      break;

    case "measure_location":
      if (!descriptor.fieldMap.latitude || !descriptor.fieldMap.longitude) {
        reasons.push("Field map is missing latitude/longitude paths.");
      }
      break;

    case "measure_media":
      if (!descriptor.fieldMap.photos) {
        reasons.push("Field map has no images collection path.");
      }
      break;

    case "assess_classification": {
      // "Can we OBSERVE the provider's classification evidence at all?" — a much
      // lower bar than resolving D060, and the distinction is the point.
      const { mode, codePath } = descriptor.classification;
      if (mode === "unknown") {
        reasons.push("Classification mode is unknown; no classification evidence can be read.");
      } else if (mode === "code_with_master_lookup" && !codePath) {
        reasons.push(
          "Classification mode is code_with_master_lookup but no code path is mapped on the property record.",
        );
      } else if (mode === "inline_value_and_kind" && !descriptor.fieldMap.starValue) {
        reasons.push(
          "Classification mode is inline_value_and_kind but no starValue path is mapped.",
        );
      }
      break;
    }

    case "resolve_d060_classification": {
      // The strict one. Unchanged in strictness — only in blast radius.
      const inherited = assessCapability(descriptor, "assess_classification", destination, runtime);
      reasons.push(...inherited.reasons.filter((r) => !reasons.includes(r)));

      if (!descriptor.classification.issuerEstablished) {
        reasons.push(
          "No issuing authority is established for the classification, so it cannot satisfy publishability condition 7 (D062).",
        );
      }
      if (
        descriptor.classification.mode === "code_with_master_lookup" &&
        descriptor.classification.hotelAccommodationTypes.length === 0
      ) {
        reasons.push(
          "No accommodation types are accepted as carrying a HOTEL star classification. '5 KEY' on an apartment is not five hotel stars.",
        );
      }
      if (
        descriptor.classification.mode === "inline_value_and_kind" &&
        descriptor.starKindsAcceptedAsD060Evidence.length === 0 &&
        !descriptor.starKindDocumentedAbsent
      ) {
        reasons.push(
          "No star `kind` values have been accepted as D060 evidence. A field named `stars` is not automatically a hospitality classification.",
        );
      }
      break;
    }
  }

  return { capability, runnable: reasons.length === 0, reasons };
}

export function assessAllCapabilities(
  descriptor: AdapterDescriptor,
  destination?: EvaluationDestination,
  runtime: RuntimeObservation = unknownRuntime(),
): CapabilityAssessment[] {
  return ALL_CAPABILITIES.map((c) => assessCapability(descriptor, c, destination, runtime));
}

/**
 * May an evaluation run proceed at all?
 *
 * Yes when ANY capability is runnable. A run that can measure inventory,
 * coordinates and media is worth executing even when classification stays
 * unresolved — that outcome is itself the finding.
 */
export function canRunAnything(assessments: readonly CapabilityAssessment[]): boolean {
  return assessments.some((a) => a.runnable);
}

export function assertRunnableForAnyCapability(
  descriptor: AdapterDescriptor,
  destination?: EvaluationDestination,
  runtime: RuntimeObservation = unknownRuntime(),
): CapabilityAssessment[] {
  const assessments = assessAllCapabilities(descriptor, destination, runtime);
  if (canRunAnything(assessments)) return assessments;

  const detail = assessments
    .map((a) => `  ${a.capability}:\n${a.reasons.map((r) => `    - ${r}`).join("\n")}`)
    .join("\n");
  throw new Error(
    `Provider "${descriptor.provider}" cannot evaluate ANY capability yet:\n${detail}\n\n` +
      "Every dimension is blocked. Establish the missing facts from official documentation,\n" +
      "or run the geography-discovery phase, before attempting an evaluation run.",
  );
}
