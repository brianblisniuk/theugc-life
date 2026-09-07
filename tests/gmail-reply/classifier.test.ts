import { describe, expect, it } from "vitest";

import { classifyCandidate } from "@/lib/gmail/reply/classifier";
import type {
  ReplyEvidenceParticipant,
  ReplyEvidenceSubject,
  ReplyEvidenceTextPart,
} from "@/lib/gmail/reply/contract";

const MSG = "reply-1";

function from(
  addrSpec: string | null,
  parseStatus: ReplyEvidenceParticipant["parseStatus"] = "parsed",
) {
  const participants: ReplyEvidenceParticipant[] = [
    {
      providerMessageId: MSG,
      role: "from",
      addrSpec,
      domainLower: addrSpec?.split("@")[1] ?? null,
      parseStatus,
    },
  ];
  return participants;
}

function plainText(text: string): ReplyEvidenceTextPart[] {
  return [
    { providerMessageId: MSG, mimeType: "text/plain", decodeStatus: "decoded", decodedText: text },
  ];
}

function subject(text: string): ReplyEvidenceSubject[] {
  return [{ providerMessageId: MSG, rawValue: text }];
}

function classify(overrides: {
  chronologyConflict?: boolean;
  mailAccountEmail?: string | null;
  participants?: ReplyEvidenceParticipant[];
  subjects?: ReplyEvidenceSubject[];
  textParts?: ReplyEvidenceTextPart[];
}) {
  return classifyCandidate({
    providerMessageId: MSG,
    chronologyConflict: overrides.chronologyConflict ?? false,
    mailAccountEmail: overrides.mailAccountEmail ?? "creator@example.com",
    participants: overrides.participants ?? from("guest@hotel.example"),
    subjects: overrides.subjects ?? subject("Re: collaboration"),
    textParts: overrides.textParts ?? plainText("Sounds great, let's do it!"),
  });
}

describe("B06 classifier.ts: human/automated/delivery classification (contract §8)", () => {
  it("a real human reply with a clean external sender and new text qualifies", () => {
    expect(classify({}).responseClass).toBe("qualifying_human_reply");
  });

  it("explicit out-of-office language classifies as automated_response", () => {
    expect(
      classify({
        textParts: plainText("I am currently out of office and will reply when I return."),
      }).responseClass,
    ).toBe("automated_response");
  });

  it("explicit automatic-reply language in the subject alone is sufficient", () => {
    expect(
      classify({ subjects: subject("Automatic reply: Re: collaboration") }).responseClass,
    ).toBe("automated_response");
  });

  it("a bounce from a mechanical sender with explicit failure language classifies as delivery_status", () => {
    expect(
      classify({
        participants: from("mailer-daemon@example.com"),
        subjects: subject("Undeliverable: Re: collaboration"),
        textParts: plainText("Delivery has failed for the following recipients."),
      }).responseClass,
    ).toBe("delivery_status");
  });

  it("noreply@ sender ALONE with human-looking text is never automatically automated", () => {
    expect(
      classify({
        participants: from("noreply@hotel.example"),
        textParts: plainText("Thanks so much for reaching out, I would love to collaborate!"),
      }).responseClass,
    ).toBe("qualifying_human_reply");
  });

  it("a generic word like 'automatic' inside QUOTED history does not trigger automation (quote already stripped)", () => {
    // The quoted line would only survive if quote-stripping failed; this
    // asserts the real transform correctly discards it before this call ever
    // sees it, by constructing input as if it had already been stripped.
    expect(
      classify({
        textParts: plainText(
          "Sounds great, let's collaborate!\n\nOn Mon, Jan 1 wrote:\n> this is an automatic reply",
        ),
      }).responseClass,
    ).toBe("qualifying_human_reply");
  });

  it("malformed/missing From is ambiguous_inbound, not a forced classification", () => {
    expect(classify({ participants: from(null, "malformed") }).responseClass).toBe(
      "ambiguous_inbound",
    );
  });

  it("a sender equal to the mailbox's own routing address is ambiguous_inbound, never a self-reply", () => {
    expect(classify({ participants: from("creator@example.com") }).responseClass).toBe(
      "ambiguous_inbound",
    );
  });

  it("empty text after quote/signature stripping is ambiguous_inbound", () => {
    expect(classify({ textParts: plainText("On Mon wrote:\n> hello") }).responseClass).toBe(
      "ambiguous_inbound",
    );
  });

  it("a chronology conflict forces ambiguous_inbound regardless of otherwise-clean evidence", () => {
    expect(classify({ chronologyConflict: true }).responseClass).toBe("ambiguous_inbound");
  });
});
