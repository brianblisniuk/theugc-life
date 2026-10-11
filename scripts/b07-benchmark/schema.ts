/**
 * The ONE logical machine-output schema every candidate is scored against.
 *
 * Two representations are kept deliberately in lockstep:
 *
 *   1. a Zod schema, used for local validation of every response;
 *   2. a plain JSON Schema literal, handed to provider structured-output
 *      transports (OpenAI `json_schema`, Anthropic tool input schema, Google
 *      `responseSchema`).
 *
 * They are written out separately rather than machine-derived because the
 * providers disagree about which JSON Schema dialect features they accept, and
 * a generated schema would quietly differ per provider — which is exactly the
 * fairness defect this benchmark is supposed to detect. A test asserts the two
 * representations enumerate the same values as `taxonomy.ts`, so drift fails
 * CI rather than silently skewing one provider's results.
 *
 * FAIRNESS RULE: every provider receives the same logical schema. Only the
 * transport differs.
 */
import { z } from "zod";

import {
  COMPENSATION_STRUCTURES,
  DISPOSITIONS,
  EVIDENCE_STRENGTHS,
  SIGNALS,
  THREAD_STATES,
} from "./taxonomy";

/** Bump when the machine-output shape changes. Recorded in every result row. */
export const B07_BENCHMARK_SCHEMA_VERSION = "b07_benchmark_schema_v1";

export const messageOutputZod = z
  .object({
    disposition: z.enum(DISPOSITIONS),
    signals: z.array(z.enum(SIGNALS)),
    evidence_strength: z.enum(EVIDENCE_STRENGTHS),
  })
  .strict();

export const threadOutputZod = z
  .object({
    thread_state: z.enum(THREAD_STATES),
    compensation_structure: z.enum(COMPENSATION_STRUCTURES),
    evidence_strength: z.enum(EVIDENCE_STRENGTHS),
  })
  .strict();

export type MessageOutput = z.infer<typeof messageOutputZod>;
export type ThreadOutput = z.infer<typeof threadOutputZod>;

/**
 * Minimal JSON Schema shape. Deliberately narrow: `additionalProperties:false`
 * plus a full `required` list is what OpenAI strict mode and Google's
 * `responseSchema` both need, and Anthropic's `strict: true` tool input schema
 * accepts the same shape.
 */
export interface JsonObjectSchema {
  type: "object";
  properties: Record<
    string,
    | { type: "string"; enum: string[] }
    | { type: "array"; items: { type: "string"; enum: string[] } }
  >;
  required: string[];
  additionalProperties: false;
}

export const MESSAGE_JSON_SCHEMA: JsonObjectSchema = {
  type: "object",
  properties: {
    disposition: { type: "string", enum: [...DISPOSITIONS] },
    signals: { type: "array", items: { type: "string", enum: [...SIGNALS] } },
    evidence_strength: { type: "string", enum: [...EVIDENCE_STRENGTHS] },
  },
  required: ["disposition", "signals", "evidence_strength"],
  additionalProperties: false,
};

export const THREAD_JSON_SCHEMA: JsonObjectSchema = {
  type: "object",
  properties: {
    thread_state: { type: "string", enum: [...THREAD_STATES] },
    compensation_structure: { type: "string", enum: [...COMPENSATION_STRUCTURES] },
    evidence_strength: { type: "string", enum: [...EVIDENCE_STRENGTHS] },
  },
  required: ["thread_state", "compensation_structure", "evidence_strength"],
  additionalProperties: false,
};

export const SCHEMA_NAMES = {
  message: "b07_message_commercial_meaning",
  thread: "b07_thread_commercial_meaning",
} as const;

/** Every literal value any machine-output schema can emit. Used by guard tests. */
export function machineOutputEnumValues(): string[] {
  const values: string[] = [];
  for (const schema of [MESSAGE_JSON_SCHEMA, THREAD_JSON_SCHEMA]) {
    for (const property of Object.values(schema.properties)) {
      if (property.type === "string") values.push(...property.enum);
      else values.push(...property.items.enum);
    }
  }
  return values;
}
