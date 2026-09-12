/**
 * Gold-corpus case schema.
 *
 * Gold truth derives from D072, never from a model's own labels. Each case
 * therefore carries a human-audit rationale, explicit acceptable-answer sets
 * where D072 genuinely permits more than one honest answer, and adversarial /
 * critical-invariant tags.
 *
 * SPLIT-LEAKAGE RULE: `gold_rationale` and every `expected*`/`acceptable*`
 * field is HUMAN-AUDIT ONLY. The only projection that may reach a provider is
 * `toCandidateVisibleCase()` in `../prompt/render.ts`, which is built from an
 * explicit allow-list of evidence fields.
 */
import { z } from "zod";

import {
  COMPENSATION_STRUCTURES,
  CORPUS_LANGUAGES,
  CORPUS_SPLITS,
  DISPOSITIONS,
  EVIDENCE_STRENGTHS,
  SIGNALS,
  THREAD_STATES,
} from "../taxonomy";

export const CORPUS_VERSION = "b07_gold_corpus_v1";

/**
 * `creator` = a message the creator SENT (D072 §16 context only — it never gets
 * its own reply disposition/signal set).
 * `target` = an inbound message from the outreach target.
 */
export const MESSAGE_ROLES = ["creator", "target"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const corpusMessageZod = z
  .object({
    from: z.enum(MESSAGE_ROLES),
    text: z.string().min(1),
  })
  .strict();

const messageExpectedZod = z
  .object({
    disposition: z.enum(DISPOSITIONS),
    signals: z.array(z.enum(SIGNALS)),
    evidence_strength: z.enum(EVIDENCE_STRENGTHS),
  })
  .strict();

const messageAcceptableZod = z
  .object({
    disposition: z.array(z.enum(DISPOSITIONS)).min(1).optional(),
    signals: z
      .array(z.array(z.enum(SIGNALS)))
      .min(1)
      .optional(),
    evidence_strength: z.array(z.enum(EVIDENCE_STRENGTHS)).min(1).optional(),
  })
  .strict();

const threadExpectedZod = z
  .object({
    thread_state: z.enum(THREAD_STATES),
    compensation_structure: z.enum(COMPENSATION_STRUCTURES),
    evidence_strength: z.enum(EVIDENCE_STRENGTHS),
  })
  .strict();

const threadAcceptableZod = z
  .object({
    thread_state: z.array(z.enum(THREAD_STATES)).min(1).optional(),
    compensation_structure: z.array(z.enum(COMPENSATION_STRUCTURES)).min(1).optional(),
    evidence_strength: z.array(z.enum(EVIDENCE_STRENGTHS)).min(1).optional(),
  })
  .strict();

const baseCaseZod = {
  case_id: z.string().regex(/^[a-z0-9-]+$/),
  split: z.enum(CORPUS_SPLITS),
  language: z.enum(CORPUS_LANGUAGES),
  subject: z.string().min(1),
  messages: z.array(corpusMessageZod).min(1),
  adversarial_tags: z.array(z.string().regex(/^[a-z0-9_]+$/)),
  /** Ids from `scoring/invariants.ts`. Validated against that registry on load. */
  critical_invariants: z.array(z.string().regex(/^[a-z0-9_]+$/)),
  /** HUMAN AUDIT ONLY. Never sent to a candidate model. */
  gold_rationale: z.string().min(1),
};

export const messageCaseZod = z
  .object({
    ...baseCaseZod,
    task: z.literal("message"),
    /** Index into `messages` of the target reply being classified. */
    focus_index: z.number().int().min(0),
    expected: messageExpectedZod,
    acceptable: messageAcceptableZod.optional(),
  })
  .strict();

export const threadCaseZod = z
  .object({
    ...baseCaseZod,
    task: z.literal("thread"),
    expected: threadExpectedZod,
    acceptable: threadAcceptableZod.optional(),
  })
  .strict();

export const corpusCaseZod = z.discriminatedUnion("task", [messageCaseZod, threadCaseZod]);

export type CorpusMessage = z.infer<typeof corpusMessageZod>;
export type MessageCase = z.infer<typeof messageCaseZod>;
export type ThreadCase = z.infer<typeof threadCaseZod>;
export type CorpusCase = z.infer<typeof corpusCaseZod>;
