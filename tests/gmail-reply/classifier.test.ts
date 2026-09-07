import { describe, expect, it } from "vitest";

import { classifyCandidate, observedCreatorSentFromAddresses } from "@/lib/gmail/reply/classifier";
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

/**
 * CLOSURE PASS §7: `overrides.mailAccountEmail ?? default` made an explicit
 * `null` (a genuinely unknown routing address) indistinguishable from
 * "caller didn't pass one" — both fell through to the same default,
 * making the null-routing-email case impossible to exercise. `hasOwnProperty`
 * distinguishes "key omitted" (use the default) from "key present with
 * value null" (pass null through).
 */
function classify(overrides: {
  chronologyConflict?: boolean;
  mailAccountEmail?: string | null;
  participants?: ReplyEvidenceParticipant[];
  subjects?: ReplyEvidenceSubject[];
  textParts?: ReplyEvidenceTextPart[];
  observedCreatorSentFromAddresses?: ReadonlySet<string>;
}) {
  return classifyCandidate({
    providerMessageId: MSG,
    chronologyConflict: overrides.chronologyConflict ?? false,
    mailAccountEmail: Object.prototype.hasOwnProperty.call(overrides, "mailAccountEmail")
      ? overrides.mailAccountEmail!
      : "creator@example.com",
    participants: overrides.participants ?? from("guest@hotel.example"),
    subjects: overrides.subjects ?? subject("Re: collaboration"),
    textParts: overrides.textParts ?? plainText("Sounds great, let's do it!"),
    observedCreatorSentFromAddresses: overrides.observedCreatorSentFromAddresses,
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

  describe("closure pass §7: null routing email never becomes positive externality evidence", () => {
    it("a null mailbox routing address with an otherwise-clean external-looking sender is ambiguous_inbound, NOT qualifying", () => {
      expect(classify({ mailAccountEmail: null }).responseClass).toBe("ambiguous_inbound");
    });

    it("a null routing address stays ambiguous_inbound even with unambiguous human-authored text", () => {
      expect(
        classify({
          mailAccountEmail: null,
          textParts: plainText("Thanks so much, I would love to collaborate on this!"),
        }).responseClass,
      ).toBe("ambiguous_inbound");
    });
  });

  describe("closure pass §8: observed creator-sent self-address is negative evidence against externality", () => {
    it("a sender matching an address directly observed on a creator-SENT message is NOT external, even though it differs from the current routing address", () => {
      expect(
        classify({
          mailAccountEmail: "current-routing@example.com",
          participants: from("old-alias@example.com"),
          observedCreatorSentFromAddresses: new Set(["old-alias@example.com"]),
        }).responseClass,
      ).toBe("ambiguous_inbound");
    });

    it("self-sender evidence never manufactures externality on its own when routing is unknown", () => {
      expect(
        classify({
          mailAccountEmail: null,
          participants: from("guest@hotel.example"),
          observedCreatorSentFromAddresses: new Set(["someone-else@example.com"]),
        }).responseClass,
      ).toBe("ambiguous_inbound");
    });

    it("a genuinely external sender still qualifies when it does NOT match any observed creator-sent address", () => {
      expect(
        classify({
          mailAccountEmail: "creator@example.com",
          participants: from("guest@hotel.example"),
          observedCreatorSentFromAddresses: new Set(["creator@example.com"]),
        }).responseClass,
      ).toBe("qualifying_human_reply");
    });
  });

  describe("closure pass §9: repeated/conflicting From evidence is never first-row-wins", () => {
    it("two IDENTICAL parsed From occurrences collapse safely and still qualify", () => {
      const participants: ReplyEvidenceParticipant[] = [
        ...from("guest@hotel.example"),
        ...from("guest@hotel.example"),
      ];
      expect(classify({ participants }).responseClass).toBe("qualifying_human_reply");
    });

    it("two DIFFERENT parsed From addresses on the same message cannot safely resolve to one sender — ambiguous_inbound", () => {
      const participants: ReplyEvidenceParticipant[] = [
        ...from("guest@hotel.example"),
        { ...from("other@hotel.example")[0]!, addrSpec: "other@hotel.example" },
      ];
      expect(classify({ participants }).responseClass).toBe("ambiguous_inbound");
    });

    it("a parsed From alongside a malformed From occurrence is ambiguous_inbound, not the parsed one winning", () => {
      const participants: ReplyEvidenceParticipant[] = [
        ...from("guest@hotel.example"),
        { ...from(null, "malformed")[0]! },
      ];
      expect(classify({ participants }).responseClass).toBe("ambiguous_inbound");
    });
  });

  describe("closure pass §10: repeated Subject evidence — no occurrence is silently ignored", () => {
    function subjects(...values: string[]): ReplyEvidenceSubject[] {
      return values.map((rawValue) => ({ providerMessageId: MSG, rawValue }));
    }

    it("automation language in a SECOND Subject occurrence is honored, not ignored because it wasn't first", () => {
      expect(
        classify({ subjects: subjects("Re: collaboration", "Automatic reply") }).responseClass,
      ).toBe("automated_response");
    });

    it("two identical repeated Subjects collapse safely with no change in outcome", () => {
      expect(
        classify({ subjects: subjects("Re: collaboration", "Re: collaboration") }).responseClass,
      ).toBe("qualifying_human_reply");
    });

    it("a conflicting (non-automation) repeated Subject does not suppress automation language present in another occurrence", () => {
      expect(
        classify({ subjects: subjects("Automatic reply", "Something else entirely") })
          .responseClass,
      ).toBe("automated_response");
    });
  });
});

describe("B06 classifier.ts: observedCreatorSentFromAddresses (closure pass §8)", () => {
  it("collects only From addresses of provider_sent=true messages, lowercased", () => {
    const participants: ReplyEvidenceParticipant[] = [
      {
        providerMessageId: "sent-1",
        role: "from",
        addrSpec: "Creator@Example.com",
        domainLower: "example.com",
        parseStatus: "parsed",
      },
      {
        providerMessageId: "reply-1",
        role: "from",
        addrSpec: "guest@hotel.example",
        domainLower: "hotel.example",
        parseStatus: "parsed",
      },
    ];
    const messages = [
      { providerMessageId: "sent-1", providerSent: true },
      { providerMessageId: "reply-1", providerSent: false },
    ];
    expect(observedCreatorSentFromAddresses(messages, participants)).toEqual(
      new Set(["creator@example.com"]),
    );
  });

  it("excludes a creator-sent message whose own From is ambiguous (repeated/malformed)", () => {
    const participants: ReplyEvidenceParticipant[] = [
      {
        providerMessageId: "sent-1",
        role: "from",
        addrSpec: "a@example.com",
        domainLower: "example.com",
        parseStatus: "parsed",
      },
      {
        providerMessageId: "sent-1",
        role: "from",
        addrSpec: "b@example.com",
        domainLower: "example.com",
        parseStatus: "parsed",
      },
    ];
    const messages = [{ providerMessageId: "sent-1", providerSent: true }];
    expect(observedCreatorSentFromAddresses(messages, participants).size).toBe(0);
  });
});
