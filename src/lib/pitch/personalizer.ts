/**
 * Pitch personalizer (D110).
 *
 * The page-load suggestion stays the template provider. Any other name is
 * refused, including a model vendor. The assistant is a separate action
 * (D141) and does not run while this page renders.
 */
import { suggestPitch, type FactKey, type PitchFacts, type SystemTemplateKey } from "./contract";

export const PITCH_PERSONALIZER_TEMPLATE = "template" as const;

export interface PitchPersonalizer {
  readonly provider: typeof PITCH_PERSONALIZER_TEMPLATE;
  suggest(input: {
    facts: PitchFacts;
    relationshipStatus: string | null;
    systemKey?: SystemTemplateKey | null;
    creatorTemplate?: { subject: string; body: string } | null;
  }): { subject: string; body: string; used: FactKey[]; systemKey: SystemTemplateKey | null };
}

const templatePersonalizer: PitchPersonalizer = {
  provider: PITCH_PERSONALIZER_TEMPLATE,
  suggest: suggestPitch,
};

/**
 * `undefined` and empty mean the template provider. A named vendor is refused.
 * This function does not contact that vendor.
 */
export function createPitchPersonalizer(provider: string | undefined): PitchPersonalizer | null {
  const name = (provider ?? PITCH_PERSONALIZER_TEMPLATE).trim();
  if (name === "" || name === PITCH_PERSONALIZER_TEMPLATE) return templatePersonalizer;
  return null;
}
