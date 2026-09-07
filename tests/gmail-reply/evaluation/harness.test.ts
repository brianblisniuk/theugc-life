import { describe, expect, it } from "vitest";

import { interpretThread } from "@/lib/gmail/reply/interpreter";
import type { ResponseClass } from "@/lib/gmail/reply/contract";
import {
  evaluateCorpus,
  formatReport,
  type LabeledResult,
} from "../../gmail-outreach/evaluation/metrics";
import { CORPUS, toEvidence } from "./corpus";

/**
 * B06 SYNTHETIC EVALUATION HARNESS. Reuses B05's generic, corpus-shape-
 * agnostic `evaluateCorpus`/`formatReport` (tests/gmail-outreach/evaluation/
 * metrics.ts) — proven precision/recall/accuracy computation over ANY
 * labeled-result set, with no B05-specific assumption anywhere in its
 * logic. Explicitly NOT a production gold-label table (D071, contract §17):
 * fixtures/gold labels live only as TypeScript data here, and every number
 * below is an implementation-correctness check, never a real-world accuracy
 * claim.
 */

describe("B06 evaluation harness: response classification + relationship + timing (contract §17/§21)", () => {
  it("reports per-class precision/recall for response classification over the required corpus", () => {
    const results: LabeledResult<ResponseClass>[] = [];

    for (const testCase of CORPUS) {
      const evidence = toEvidence(testCase);
      const interpretation = interpretThread({
        ...evidence,
        mailAccountEmail: testCase.mailAccountEmail,
        observedThroughAtMs: testCase.observedThroughAtMs,
      });

      for (const message of testCase.messages) {
        if (!message.goldResponseClass) continue;
        const predicted = interpretation.messageObservations.find(
          (o) => o.providerMessageId === message.id,
        )!;
        results.push({
          id: `${testCase.id}/${message.id}`,
          gold: message.goldResponseClass,
          predicted: predicted.responseClass,
        });
      }
    }

    const report = evaluateCorpus(results);
    console.log(formatReport("B06 response classification", report));

    expect(report.total).toBeGreaterThan(0);
    expect(report.accuracy).toBe(1);
    for (const c of report.perClass) {
      if (c.support > 0) expect(c.recall).toBe(1);
    }
  });

  it("reports relationship-status accuracy over the required corpus", () => {
    const results: LabeledResult<string>[] = [];

    for (const testCase of CORPUS) {
      const evidence = toEvidence(testCase);
      const interpretation = interpretThread({
        ...evidence,
        mailAccountEmail: testCase.mailAccountEmail,
        observedThroughAtMs: testCase.observedThroughAtMs,
      });

      for (const message of testCase.messages) {
        if (!message.goldRelationStatus) continue;
        const predicted = interpretation.messageObservations.find(
          (o) => o.providerMessageId === message.id,
        )!;
        results.push({
          id: `${testCase.id}/${message.id}`,
          gold: message.goldRelationStatus,
          predicted: predicted.relationStatus ?? "null",
        });
      }
    }

    const report = evaluateCorpus(results);
    console.log(formatReport("B06 relationship status", report));
    expect(report.accuracy).toBe(1);
  });

  it("reports thread-level observation-state / horizon accuracy over the required corpus", () => {
    const results: LabeledResult<string>[] = CORPUS.map((testCase) => {
      const evidence = toEvidence(testCase);
      const interpretation = interpretThread({
        ...evidence,
        mailAccountEmail: testCase.mailAccountEmail,
        observedThroughAtMs: testCase.observedThroughAtMs,
      });
      return {
        id: testCase.id,
        gold: testCase.goldObservationState,
        predicted: interpretation.threadSummary.observationState,
      };
    });

    const report = evaluateCorpus(results);
    console.log(formatReport("B06 thread observation state", report));
    expect(report.accuracy).toBe(1);
  });

  it("exact latency correctness on every classifiable qualifying-reply case", () => {
    for (const testCase of CORPUS) {
      if (testCase.goldObservationState !== "qualifying_human_reply_observed") continue;

      const evidence = toEvidence(testCase);
      const interpretation = interpretThread({
        ...evidence,
        mailAccountEmail: testCase.mailAccountEmail,
        observedThroughAtMs: testCase.observedThroughAtMs,
      });

      expect(interpretation.threadSummary.latencyFromFirstCreatorSentMs).toBe(
        testCase.goldLatencyFromFirstCreatorSentMs,
      );
      expect(interpretation.threadSummary.latencyFromLatestCreatorSentMs).toBe(
        testCase.goldLatencyFromLatestCreatorSentMs,
      );
      expect(interpretation.threadSummary.creatorSentCountBeforeFirstHumanReply).toBe(
        testCase.goldCreatorSentCountBeforeFirstHumanReply,
      );
    }
  });

  it("negative latency and negative timestamp-contradiction cases never produce fabricated timing", () => {
    for (const testCase of CORPUS) {
      const evidence = toEvidence(testCase);
      const interpretation = interpretThread({
        ...evidence,
        mailAccountEmail: testCase.mailAccountEmail,
        observedThroughAtMs: testCase.observedThroughAtMs,
      });

      if (interpretation.threadSummary.latencyFromFirstCreatorSentMs !== null) {
        expect(interpretation.threadSummary.latencyFromFirstCreatorSentMs).toBeGreaterThanOrEqual(
          0,
        );
      }
      if (interpretation.threadSummary.latencyFromLatestCreatorSentMs !== null) {
        expect(interpretation.threadSummary.latencyFromLatestCreatorSentMs).toBeGreaterThanOrEqual(
          0,
        );
      }
    }
  });
});
