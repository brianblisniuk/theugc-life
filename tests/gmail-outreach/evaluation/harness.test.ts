import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OUTREACH_DETECTOR_VERSION, TARGET_MATCHER_VERSION } from "@/lib/gmail/outreach/contract";
import { classifyOutreach } from "@/lib/gmail/outreach/interpreter";
import { assessTargetContacts } from "@/lib/gmail/outreach/recipients";
import { interpretOneThread } from "@/lib/gmail/outreach/service";
import { matchTargetObservation } from "@/lib/gmail/outreach/target-extraction";
import type { EvidenceTextPart } from "@/lib/gmail/outreach/contract";
import {
  connectedMailbox,
  insertHotel,
  insertNormalizedThread,
  outreachDeps,
  randomProviderId,
  threadSignalRow,
} from "../harness";
import {
  CONTACT_CORPUS,
  FINAL_INTERPRETATION_CORPUS,
  OUTREACH_CORPUS,
  TARGET_MATCH_CORPUS,
} from "./corpus";
import { evaluateCorpus, formatReport, type LabeledResult } from "./metrics";

/**
 * B05 SYNTHETIC EVALUATION HARNESS (contract §20). Runs the real V1
 * deterministic modules — `classifyOutreach`, `matchTargetObservation`,
 * `assessTargetContacts` — over hand-labeled synthetic fixtures and computes
 * precision/recall/rate metrics. This is NOT a production gold-label table:
 * the corpus lives entirely in `tests/gmail-outreach/evaluation/corpus.ts` as
 * TypeScript data, and every number below is a synthetic/evaluation-harness
 * metric, never a claim about real-world accuracy.
 *
 * The assertions here encode the one property that actually matters for a
 * conservative-by-design classifier: it may ABSTAIN (needs_review /
 * insufficient_evidence / ambiguous) as much as it likes, but it must never
 * flip a clearly-positive gold example to a clearly-negative prediction (or
 * vice versa), and it must never report a wrong canonical target as a
 * confident `strong_match`. Abstention is safe by construction; a confident
 * wrong answer is not.
 */

const TEST_DB = process.env.TEST_DATABASE_URL;
const dbDescribe = describe.skipIf(!TEST_DB);
let client: Client;

beforeAll(async () => {
  if (!TEST_DB) return;
  client = new Client({ connectionString: TEST_DB });
  await client.connect();
});

afterAll(async () => {
  if (client) await client.end();
});

// EXTERNAL AUDIT AMENDMENT #5, Finding 4: this evaluates ONLY `classifyOutreach`'s
// own proposal-language-detection signal — NEVER the real final B05 outreach
// interpretation (see "B05 evaluation harness: final outreach interpretation"
// below for that). The `needs_review` + `creator_commercial_proposal_
// language_detected` -> `qualified_outreach` relabeling below exists SOLELY to
// score this classifier-only signal against the corpus's `qualified_outreach`
// gold label; it must never be read as, or reported as, the final production
// qualified-outreach precision.
describe("B05 evaluation harness: proposal-language detector (classifyOutreach only, NOT the final outreach status)", () => {
  it("reports precision/recall/rates of the proposal-language SIGNAL over the synthetic outreach corpus", () => {
    const results: LabeledResult<string>[] = OUTREACH_CORPUS.map((example) => {
      const textPart = (messageId: string, text: string): EvidenceTextPart => ({
        normalizedMessageId: messageId,
        partPath: [],
        mimeType: "text/plain",
        decodeStatus: "decoded",
        decodedText: text,
      });
      const messages = example.sentBodies.map((_, i) => ({
        normalizedMessageId: `m${i}`,
        providerMessageId: `m${i}`,
        providerSent: true,
        internalDateMs: i,
        sourcePayloadSha256: "x".repeat(64),
      }));
      const sentTextParts = example.sentBodies.map((body, i) => textPart(`m${i}`, body));
      const subjects = [{ normalizedMessageId: "m0", rawValue: example.subject }];

      const prediction = classifyOutreach({ messages, sentTextParts, subjects });
      // EXTERNAL AUDIT AMENDMENT #4, Finding 1: `classifyOutreach` alone can
      // no longer produce `qualified_outreach` — it has no target evidence,
      // so D070 §5's third requirement is resolved in `interpretOneThread`,
      // not here. This corpus evaluates the CLASSIFIER's own contribution
      // (creator-SENT proposal-language detection), so its `needs_review` +
      // `creator_commercial_proposal_language_detected` output is mapped back
      // to the `qualified_outreach` label it is evaluated against — the same
      // signal the pre-Amendment-4 classifier expressed directly as a status.
      const predicted = prediction.reasonCodes.includes(
        "creator_commercial_proposal_language_detected",
      )
        ? "qualified_outreach"
        : prediction.status;
      return { id: example.id, gold: example.gold, predicted };
    });

    const report = evaluateCorpus(results);
    // eslint-disable-next-line no-console
    console.log(
      formatReport(
        `B05 proposal-language detector (${OUTREACH_DETECTOR_VERSION}, NOT the final outreach status)`,
        report,
      ),
    );

    // Safety invariant: never confidently invert a gold label. Abstaining to
    // needs_review/insufficient_evidence instead is acceptable and expected.
    const dangerousFlips = results.filter(
      (r) =>
        (r.gold === "qualified_outreach" && r.predicted === "not_outreach") ||
        (r.gold === "not_outreach" && r.predicted === "qualified_outreach"),
    );
    expect(dangerousFlips).toEqual([]);

    // Precision on the positive class must be perfect on this corpus: every
    // example the classifier confidently calls `qualified_outreach` really is
    // one in the gold labels (no fabricated commercial-outreach claims).
    const qualifiedClass = report.perClass.find((c) => c.label === "qualified_outreach");
    expect(qualifiedClass?.precision).toBe(1);
  });
});

describe("B05 evaluation harness: canonical target matching", () => {
  it("reports strong-match correctness and wrong-target rate over the synthetic target corpus", () => {
    const results: LabeledResult<string>[] = [];
    let wrongTargetOnStrongMatch = 0;

    for (const example of TARGET_MATCH_CORPUS) {
      const hotelIdByContactEmail = new Map(
        Object.entries(example.hotelContactEmails).map(([email, id]) => [email, new Set([id])]),
      );
      const organizationIdByContactEmail = new Map(
        Object.entries(example.organizationContactEmails).map(([email, id]) => [
          email,
          new Set([id]),
        ]),
      );
      const observation = {
        observationFingerprint: "a".repeat(64),
        observedName: example.observedName,
        observedDomain: example.observedDomain,
        targetKindHint: "unknown" as const,
        observationSourceKind: "recipient_domain" as const,
        sourceProviderMessageIds: ["provider-msg-1"],
        machineCanonicalLinkAssessment: "insufficient_evidence" as const,
        candidateSetFingerprint: "b".repeat(64),
      };

      const result = matchTargetObservation(observation, example.associatedAddresses, {
        epoch: 1,
        hotels: example.hotels,
        organizations: example.organizations,
        hotelIdByContactEmail,
        organizationIdByContactEmail,
        hotelOrganizationLinks: [],
      });

      const predicted = result.observation.machineCanonicalLinkAssessment;
      results.push({ id: example.id, gold: example.gold, predicted });

      if (predicted === "strong_match") {
        const topRankedIds = result.links
          .filter((l) => l.rank === 0)
          .map((l) => l.targetHotelId ?? l.targetOrganizationId);
        if (example.expectedTargetId === null || !topRankedIds.includes(example.expectedTargetId)) {
          wrongTargetOnStrongMatch += 1;
        }
      }
    }

    const report = evaluateCorpus(results);
    // eslint-disable-next-line no-console
    console.log(
      formatReport(`B05 target canonical-link matcher (${TARGET_MATCHER_VERSION})`, report),
    );

    // D028's core guarantee: a confident strong_match must be the right
    // target, never merely a confident wrong one.
    expect(wrongTargetOnStrongMatch).toBe(0);
  });
});

describe("B05 evaluation harness: target-contact candidate assessment", () => {
  it("reports candidate correctness and abstention rate over the synthetic contact corpus", () => {
    const results: LabeledResult<string>[] = CONTACT_CORPUS.map((example) => {
      const assessment = assessTargetContacts(
        example.recipients,
        new Set(example.independentlyConfirmedAddresses ?? []),
      );
      return { id: example.id, gold: example.gold, predicted: assessment.matchQuality };
    });

    const report = evaluateCorpus(results);
    // eslint-disable-next-line no-console
    console.log(formatReport("B05 target-contact assessment", report));

    expect(report.accuracy).toBe(1);
  });
});

/**
 * EXTERNAL AUDIT AMENDMENT #5, Finding 4: the REAL final B05 outreach
 * interpretation — the actual end-to-end `interpretOneThread` combination
 * (classifier + target extraction + matching + the D070 §5 requirement-C
 * upgrade logic) against a real Postgres database, scored against its own
 * gold label with NO test-side status relabeling. This is the metric that
 * actually corresponds to what a creator would see.
 */
dbDescribe(
  "B05 evaluation harness: final outreach interpretation (real interpretOneThread, no relabeling)",
  () => {
    it("reports precision/recall/rates of the REAL final outreach status over the synthetic final-interpretation corpus", async () => {
      const results: LabeledResult<string>[] = [];

      for (const example of FINAL_INTERPRETATION_CORPUS) {
        const { userId, mailAccountId } = await connectedMailbox(client, `eval-${example.id}`);
        const deps = outreachDeps(client);
        if (example.hotelName) {
          await insertHotel(client, { name: example.hotelName });
        }
        const { normalizedThreadId } = await insertNormalizedThread(client, {
          userId,
          mailAccountId,
          providerMessageId: randomProviderId("msg"),
          providerThreadId: randomProviderId("thread"),
          subject: example.subject,
          toRecipients: [example.toRecipient],
          bodyText: example.sentBodies.join("\n\n"),
        });

        const outcome = await interpretOneThread(deps, {
          userId,
          mailAccountId,
          normalizedThreadId,
        });
        expect(outcome.result).toBe("ok");
        const signal = await threadSignalRow(client, normalizedThreadId);
        results.push({ id: example.id, gold: example.gold, predicted: signal.outreach_status });
      }

      const report = evaluateCorpus(results);
      // eslint-disable-next-line no-console
      console.log(
        formatReport(
          `B05 FINAL outreach interpretation (${OUTREACH_DETECTOR_VERSION} + ${TARGET_MATCHER_VERSION}, real interpretOneThread)`,
          report,
        ),
      );

      // Same safety invariant as the proposal-language detector, but now
      // measured against the REAL final status a creator would actually see.
      const dangerousFlips = results.filter(
        (r) =>
          (r.gold === "qualified_outreach" && r.predicted === "not_outreach") ||
          (r.gold === "not_outreach" && r.predicted === "qualified_outreach"),
      );
      expect(dangerousFlips).toEqual([]);

      const qualifiedClass = report.perClass.find((c) => c.label === "qualified_outreach");
      expect(qualifiedClass?.precision).toBe(1);
    });
  },
);
