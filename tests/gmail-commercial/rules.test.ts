import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  interpretCommercialMessage,
  interpretCommercialThread,
} from "@/lib/gmail/commercial/rules";
import { extractReplyTextForMessage } from "@/lib/gmail/reply/text-transform";

interface FixtureMessage {
  from: string;
  text: string;
}
interface Fixture {
  case_id: string;
  messages: FixtureMessage[];
  focus_index: number;
  expected: { disposition: string; signals: string[]; evidence_strength: string };
  critical_invariants?: string[];
}

const fixtures = readFileSync(
  path.join(process.cwd(), "scripts/b07-benchmark/fixtures/b07_gold_corpus_v2_message.jsonl"),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as Fixture);

function fixture(id: string): Fixture {
  const found = fixtures.find((row) => row.case_id === id);
  if (!found) throw new Error(`missing fixture ${id}`);
  return found;
}

function message(input: {
  id: string;
  sent?: boolean;
  at: number;
  text: string | null;
  eligible?: boolean;
}) {
  return {
    providerMessageId: input.id,
    providerSent: input.sent ?? false,
    internalDateMs: input.at,
    cleanText: input.text,
    eligible: input.eligible ?? !input.sent,
  };
}

describe("B07 rules engine — holdout safety fixtures", () => {
  for (const id of ["m-en-hold-017", "m-en-hold-027", "m-es-hold-017"] as const) {
    it(`${id} matches the gold label and does not collapse the critical invariant`, () => {
      const row = fixture(id);
      const text = row.messages[row.focus_index]!.text;
      const result = interpretCommercialMessage(text);
      expect(result.disposition).toBe(row.expected.disposition);
      expect(result.signals).toEqual([...row.expected.signals].sort());
      expect(result.evidenceStrength).toBe(row.expected.evidence_strength);
      expect(result.signals).not.toContain("rejection");
      expect(result.disposition).not.toBe("negative");

      const thread = interpretCommercialThread([
        message({ id: "sent", sent: true, at: 1, text: row.messages[0]!.text, eligible: false }),
        message({ id: "reply", at: 2, text }),
      ]);
      expect(thread.commercialState).not.toBe("declined_observed");
      expect(thread.compensationStructure).not.toBe("unpaid");
    });
  }
});

describe("B07 rules engine — contract §27", () => {
  it("politeness alone is not positive", () => {
    const result = interpretCommercialMessage("Thanks for reaching out.");
    expect(result.disposition).toBe("neutral");
    expect(result.signals).toEqual([]);
    expect(result.evidenceStrength).toBe("weak");
  });

  it("interest plus a media kit is not negotiation and not agreement", () => {
    const thread = interpretCommercialThread([
      message({ id: "sent", sent: true, at: 1, text: "Would you collaborate?", eligible: false }),
      message({ id: "reply", at: 2, text: "This sounds interesting. Send your media kit." }),
    ]);
    expect(thread.messages[0]).toMatchObject({
      disposition: "positive",
      signals: ["interest", "request_information"],
    });
    expect(thread.commercialState).toBe("engaged");
  });

  it("asking about rates opens negotiation and does not close it", () => {
    const thread = interpretCommercialThread([
      message({ id: "sent", sent: true, at: 1, text: "Collaboration?", eligible: false }),
      message({
        id: "reply",
        at: 2,
        text: "We'd love to collaborate. What are your rates?",
      }),
    ]);
    expect(thread.messages[0]!.signals).toEqual([
      "interest",
      "request_information",
      "terms_discussion",
    ]);
    expect(thread.commercialState).toBe("negotiating");
  });

  it("an offer is not agreement", () => {
    const thread = interpretCommercialThread([
      message({ id: "sent", sent: true, at: 1, text: "I would love to visit.", eligible: false }),
      message({
        id: "reply",
        at: 2,
        text: "We can offer two nights, breakfast included.",
      }),
    ]);
    expect(thread.messages[0]!.signals).toEqual(
      expect.arrayContaining(["offer", "terms_discussion"]),
    );
    expect(thread.messages[0]!.signals).not.toContain("agreement");
    expect(thread.commercialState).toBe("negotiating");
    expect(thread.compensationStructure).toBe("in_kind");
  });

  it("hosted stay with an explicit refusal of payment is in_kind, not unpaid", () => {
    const thread = interpretCommercialThread([
      message({ id: "sent", sent: true, at: 1, text: "Here is my kit.", eligible: false }),
      message({
        id: "reply",
        at: 2,
        text: "We can host you for two nights but cannot offer payment.",
      }),
    ]);
    expect(thread.compensationStructure).toBe("in_kind");
  });

  it("a booking confirmation after a creator send can be agreement_observed", () => {
    const thread = interpretCommercialThread([
      message({
        id: "sent",
        sent: true,
        at: 1,
        text: "Could we visit in November?",
        eligible: false,
      }),
      message({
        id: "offer",
        at: 2,
        text: "We can offer two nights, breakfast included.",
      }),
      message({
        id: "yes",
        at: 3,
        text: "Perfect, your stay is confirmed for November 10-12.",
      }),
    ]);
    expect(thread.messages[1]!.signals).toContain("agreement");
    expect(thread.commercialState).toBe("agreement_observed");
  });

  it("confirmation with no earlier creator send stays negotiating", () => {
    const thread = interpretCommercialThread([
      message({
        id: "only",
        at: 1,
        text: "Perfect, your stay is confirmed for November 10-12.",
      }),
    ]);
    expect(thread.commercialState).toBe("negotiating");
  });

  it("an explicit decline is negative and currently declined_observed", () => {
    const thread = interpretCommercialThread([
      message({ id: "sent", sent: true, at: 1, text: "Collaboration?", eligible: false }),
      message({
        id: "reply",
        at: 2,
        text: "Unfortunately we aren't accepting collaborations right now.",
      }),
    ]);
    expect(thread.messages[0]).toMatchObject({
      disposition: "negative",
      signals: ["rejection"],
    });
    expect(thread.commercialState).toBe("declined_observed");
  });

  it("no availability plus a retry invitation is not a decline", () => {
    const thread = interpretCommercialThread([
      message({ id: "sent", sent: true, at: 1, text: "November?", eligible: false }),
      message({
        id: "reply",
        at: 2,
        text: "No availability in November, but please reach out for January.",
      }),
    ]);
    expect(thread.messages[0]!.signals).toEqual(["timing_constraint"]);
    expect(thread.messages[0]!.signals).not.toContain("rejection");
    expect(thread.messages[0]!.disposition).toBe("mixed");
    expect(thread.commercialState).not.toBe("declined_observed");
  });

  it("a redirect is neutral and not declined", () => {
    const thread = interpretCommercialThread([
      message({ id: "sent", sent: true, at: 1, text: "Who decides?", eligible: false }),
      message({ id: "reply", at: 2, text: "Please speak with Jane from our PR agency." }),
    ]);
    expect(thread.messages[0]).toMatchObject({
      disposition: "neutral",
      signals: ["redirect"],
    });
    expect(thread.commercialState).toBe("unresolved");
  });

  it("classifies the authored rejection, not quoted enthusiasm", () => {
    const extracted = extractReplyTextForMessage([
      {
        providerMessageId: "m",
        mimeType: "text/plain",
        decodeStatus: "decoded",
        decodedText:
          "Unfortunately we aren't accepting collaborations right now.\n\nOn Monday, Alex wrote:\n> We'd love to collaborate. What are your rates?",
      },
    ]);
    const result = interpretCommercialMessage(extracted.cleanText);
    expect(result.signals).toContain("rejection");
    expect(result.signals).not.toContain("interest");
    expect(result.disposition).toBe("negative");
  });

  it("a later cancellation after a booking confirmation is ambiguous, not a frozen agreement", () => {
    const thread = interpretCommercialThread([
      message({ id: "sent", sent: true, at: 1, text: "November dates?", eligible: false }),
      message({ id: "offer", at: 2, text: "We can offer two nights." }),
      message({ id: "yes", at: 3, text: "Your stay is confirmed for November 10-12." }),
      message({ id: "no", at: 4, text: "We have to cancel." }),
    ]);
    expect(thread.commercialState).toBe("ambiguous");
  });

  it("a target-side acceptance without a booking confirmation is negotiating", () => {
    const thread = interpretCommercialThread([
      message({ id: "sent", sent: true, at: 1, text: "Here is the proposal.", eligible: false }),
      message({ id: "reply", at: 2, text: "Yes, we accept your proposal." }),
    ]);
    expect(thread.messages[0]!.signals).toContain("agreement");
    expect(thread.commercialState).toBe("negotiating");
  });

  it("the creator's own acceptance is not agreement_observed", () => {
    const thread = interpretCommercialThread([
      message({
        id: "sent",
        sent: true,
        at: 1,
        text: "I accept your offer of two nights.",
        eligible: false,
      }),
      message({ id: "reply", at: 2, text: "Thanks for reaching out." }),
    ]);
    expect(thread.commercialState).not.toBe("agreement_observed");
    expect(thread.messages.every((row) => row.providerMessageId !== "sent")).toBe(true);
  });

  it("no human reply does not invent an outcome or unpaid compensation", () => {
    const thread = interpretCommercialThread([
      message({
        id: "sent",
        sent: true,
        at: 1,
        text: "This would be unpaid.",
        eligible: false,
      }),
    ]);
    expect(thread.commercialState).toBeNull();
    expect(thread.compensationStructure).toBe("unknown");
    expect(thread.messages).toEqual([]);
  });

  it("a later reopening supersedes a decline", () => {
    const thread = interpretCommercialThread([
      message({ id: "sent", sent: true, at: 1, text: "Collaboration?", eligible: false }),
      message({
        id: "no",
        at: 2,
        text: "Unfortunately we aren't accepting collaborations right now.",
      }),
      message({
        id: "reopen",
        at: 3,
        text: "We'd love to collaborate. Are your October dates still free?",
      }),
    ]);
    expect(thread.commercialState).not.toBe("declined_observed");
    expect(thread.commercialState).toBe("engaged");
  });

  it("the subject cannot supply a decline the body does not", () => {
    const result = interpretCommercialMessage("Thanks for reaching out.");
    expect(result.disposition).toBe("neutral");
  });

  it("empty authored text abstains", () => {
    const result = interpretCommercialMessage("   ");
    expect(result.disposition).toBe("ambiguous");
    expect(result.evidenceStrength).toBe("insufficient_evidence");
    expect(result.signals).toEqual([]);
  });
});
