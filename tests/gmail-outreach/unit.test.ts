import { describe, expect, it } from "vitest";

import {
  computeEvidenceDigest,
  digestOfSortedStrings,
  digestOfString,
} from "@/lib/gmail/outreach/digest";
import { classifyOutreach } from "@/lib/gmail/outreach/interpreter";
import { assessTargetContacts } from "@/lib/gmail/outreach/recipients";
import { buildClassifierInputForMessage } from "@/lib/gmail/outreach/text-transform";
import {
  computeAuthoredTextTargetEvidence,
  deriveMachineTargetScope,
  detectScopeLanguage,
  extractAuthoredTextNameCandidates,
  extractDomain,
  extractTargetObservations,
  matchTargetObservation,
} from "@/lib/gmail/outreach/target-extraction";
import type { EvidenceRecipient, EvidenceTextPart } from "@/lib/gmail/outreach/contract";

function recipient(overrides: Partial<EvidenceRecipient>): EvidenceRecipient {
  return {
    normalizedMessageId: "msg-1",
    sourceHeaderId: "header-1",
    sourceParticipantId: overrides.sourceParticipantId ?? "participant-1",
    role: "to",
    displayName: null,
    addrSpec: "marketing@acmehotel.example",
    localPart: "marketing",
    domain: "acmehotel.example",
    domainLower: "acmehotel.example",
    parseStatus: "parsed",
    ...overrides,
  };
}

describe("B05 unit: digest.ts", () => {
  it("is deterministic and order-independent (matches the SQL `order by id` re-sort)", () => {
    const messages = [
      {
        normalizedMessageId: "b",
        providerMessageId: "b",
        providerSent: true,
        internalDateMs: 0,
        sourcePayloadSha256: "x",
      },
      {
        normalizedMessageId: "a",
        providerMessageId: "a",
        providerSent: false,
        internalDateMs: 0,
        sourcePayloadSha256: "y",
      },
    ];
    const d1 = computeEvidenceDigest(messages);
    const d2 = computeEvidenceDigest([...messages].reverse());
    expect(d1).toBe(d2);
    expect(d1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any message's digest or sent flag changes", () => {
    const base = [
      {
        normalizedMessageId: "a",
        providerMessageId: "a",
        providerSent: true,
        internalDateMs: 0,
        sourcePayloadSha256: "x",
      },
    ];
    const changed = [{ ...base[0]!, sourcePayloadSha256: "z" }];
    expect(computeEvidenceDigest(base)).not.toBe(computeEvidenceDigest(changed));
  });

  it("empty message list has a stable, well-formed digest", () => {
    expect(computeEvidenceDigest([])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("digestOfSortedStrings and digestOfString are deterministic and order-independent", () => {
    expect(digestOfSortedStrings(["b", "a"])).toBe(digestOfSortedStrings(["a", "b"]));
    expect(digestOfString("x")).toBe(digestOfString("x"));
    expect(digestOfString("x")).not.toBe(digestOfString("y"));
  });
});

describe("B05 unit: text-transform.ts (classifier-input, D4/H)", () => {
  const part = (over: Partial<EvidenceTextPart>): EvidenceTextPart => ({
    normalizedMessageId: "m",
    partPath: [],
    mimeType: "text/plain",
    decodeStatus: "decoded",
    decodedText: "plain text",
    ...over,
  });

  it("prefers decoded text/plain over text/html (never double-counts multipart/alternative)", () => {
    const parts = [
      part({ mimeType: "text/plain", decodedText: "plain" }),
      part({ mimeType: "text/html", decodedText: "<p>html</p>" }),
    ];
    expect(buildClassifierInputForMessage(parts).cleanText).toBe("plain");
  });

  it("falls back to heuristically-stripped HTML when no plain part decoded", () => {
    const parts = [part({ mimeType: "text/html", decodedText: "<p>Hello <b>World</b></p>" })];
    expect(buildClassifierInputForMessage(parts).cleanText).toBe("Hello World");
  });

  it("returns null cleanText when nothing decoded (undecodable / body absent)", () => {
    const parts = [part({ decodeStatus: "body_absent", decodedText: null })];
    const result = buildClassifierInputForMessage(parts);
    expect(result.cleanText).toBeNull();
    expect(result.uncertainAuthorshipText).toBeNull();
  });

  it("empty_decoded is usable (a real empty body, not absence of evidence)", () => {
    const parts = [part({ decodeStatus: "empty_decoded", decodedText: "" })];
    expect(buildClassifierInputForMessage(parts).cleanText).toBe("");
  });

  it("Finding 10: truncates at a Gmail-style quote introducer, keeping only newly-authored text", () => {
    const parts = [
      part({
        decodedText:
          "Thanks!\n\nOn Mon, Jan 1, 2026 at 9:00 AM Hotel Marketing <marketing@acmehotel.example> wrote:\nWe'd love to collaborate on UGC content.",
      }),
    ];
    expect(buildClassifierInputForMessage(parts).cleanText).toBe("Thanks!");
  });

  it("Finding 10: truncates at a contiguous run of `>`-quoted lines with no introducer", () => {
    const parts = [
      part({
        decodedText:
          "Sounds good.\n> We'd love to collaborate on a paid partnership.\n> Let us know.",
      }),
    ];
    expect(buildClassifierInputForMessage(parts).cleanText).toBe("Sounds good.");
  });

  it("Finding 10: truncates at the RFC 3676 signature delimiter", () => {
    const parts = [
      part({
        decodedText: "Just checking in, thanks!\n-- \nJane Doe — UGC Creator / Influencer",
      }),
    ];
    expect(buildClassifierInputForMessage(parts).cleanText).toBe("Just checking in, thanks!");
  });

  it("Finding 10: an unrecognized quote format passes through untouched (not lossless, may abstain)", () => {
    const parts = [part({ decodedText: "Hi there, hope you are well." })];
    expect(buildClassifierInputForMessage(parts).cleanText).toBe("Hi there, hope you are well.");
  });

  describe("Finding 7: uncertain-authorship signature tail", () => {
    it("splits an ordinary non-RFC closing ('Thanks,' + name/title block) into clean vs uncertain text", () => {
      const parts = [
        part({
          decodedText:
            "Hi there, just checking on the dates for next month.\n\nThanks,\nJane Doe\nUGC Creator\nTravel Influencer",
        }),
      ];
      const result = buildClassifierInputForMessage(parts);
      expect(result.cleanText).toBe("Hi there, just checking on the dates for next month.");
      expect(result.uncertainAuthorshipText).toContain("UGC Creator");
      expect(result.uncertainAuthorshipText).toContain("Travel Influencer");
    });

    it("recognizes common valediction variants ('Best,', 'Regards,', 'Best regards,')", () => {
      for (const valediction of ["Best,", "Regards,", "Best regards,", "Cheers,"]) {
        const parts = [part({ decodedText: `See you soon.\n\n${valediction}\nJane Doe` })];
        const result = buildClassifierInputForMessage(parts);
        expect(result.cleanText).toBe("See you soon.");
        expect(result.uncertainAuthorshipText).toContain("Jane Doe");
      }
    });

    it("no valediction line means no uncertain tail at all", () => {
      const parts = [part({ decodedText: "Hi there, hope you are well." })];
      const result = buildClassifierInputForMessage(parts);
      expect(result.uncertainAuthorshipText).toBeNull();
    });

    it("an RFC 3676 `-- ` signature is still fully stripped (never surfaces as an uncertain tail — it is discarded, not downgraded)", () => {
      const parts = [
        part({
          decodedText: "Just checking in, thanks!\n-- \nJane Doe — UGC Creator / Influencer",
        }),
      ];
      const result = buildClassifierInputForMessage(parts);
      expect(result.cleanText).toBe("Just checking in, thanks!");
      expect(result.uncertainAuthorshipText).toBeNull();
    });
  });

  describe("EXTERNAL AUDIT AMENDMENT #4, Finding 3: HTML boundary preservation", () => {
    it("HTML-only: a <blockquote> quoted reply is cut, not merged into the creator's own trailing sentence", () => {
      const parts = [
        part({
          mimeType: "text/html",
          decodedText:
            '<div><p>Thanks!</p><blockquote class="gmail_quote">We\'d love to collaborate on UGC content.</blockquote></div>',
        }),
      ];
      const result = buildClassifierInputForMessage(parts);
      expect(result.cleanText).toBe("Thanks!");
    });

    it("HTML-only: an ordinary <br>-separated signature ('Thanks,' / name / title) splits into clean vs uncertain text exactly like the plain-text case", () => {
      const parts = [
        part({
          mimeType: "text/html",
          decodedText:
            "<div>Just checking in on the dates for next month.<br><br>Thanks,<br>Jane Doe<br>UGC Creator<br>Travel Influencer</div>",
        }),
      ];
      const result = buildClassifierInputForMessage(parts);
      expect(result.cleanText).toBe("Just checking in on the dates for next month.");
      expect(result.uncertainAuthorshipText).toContain("UGC Creator");
    });

    it("HTML-only: a genuine authored pitch ABOVE a <blockquote> quoted history is preserved in full", () => {
      const parts = [
        part({
          mimeType: "text/html",
          decodedText:
            "<p>I'd love to collaborate on a paid partnership.</p><blockquote>some old unrelated thread</blockquote>",
        }),
      ];
      const result = buildClassifierInputForMessage(parts);
      expect(result.cleanText).toBe("I'd love to collaborate on a paid partnership.");
    });

    it("multipart/alternative still never double-counts: the plain part is chosen even when the HTML part has different (quoted) content", () => {
      const parts = [
        part({ mimeType: "text/plain", decodedText: "Thanks!" }),
        part({
          mimeType: "text/html",
          decodedText: "<p>Thanks!</p><blockquote>We'd love to collaborate.</blockquote>",
        }),
      ];
      expect(buildClassifierInputForMessage(parts).cleanText).toBe("Thanks!");
    });
  });
});

describe("B05 unit: interpreter.ts (deterministic V1 outreach classification)", () => {
  const sentMsg = {
    normalizedMessageId: "m1",
    providerMessageId: "m1",
    providerSent: true,
    internalDateMs: 0,
    sourcePayloadSha256: "x",
  };
  const notSentMsg = {
    normalizedMessageId: "m2",
    providerMessageId: "m2",
    providerSent: false,
    internalDateMs: 0,
    sourcePayloadSha256: "y",
  };

  function textPart(messageId: string, text: string): EvidenceTextPart {
    return {
      normalizedMessageId: messageId,
      partPath: [],
      mimeType: "text/plain",
      decodeStatus: "decoded",
      decodedText: text,
    };
  }

  it("EXTERNAL AUDIT AMENDMENT #4, Finding 1: a UGC/collaboration pitch in SENT text alone is needs_review, never a self-certified qualified_outreach — classifyOutreach has no target evidence to prove D070 §5's third requirement", () => {
    const result = classifyOutreach({
      messages: [sentMsg],
      sentTextParts: [
        textPart("m1", "Hi! I'd love to collaborate with your hotel on some UGC content."),
      ],
      subjects: [],
    });
    expect(result.status).toBe("needs_review");
    expect(result.reasonCodes).toContain("creator_commercial_proposal_language_detected");
  });

  it("not_outreach: a reservation request", () => {
    const result = classifyOutreach({
      messages: [sentMsg],
      sentTextParts: [
        textPart(
          "m1",
          "I would like a reservation for two nights, check-in Friday check-out Sunday.",
        ),
      ],
      subjects: [],
    });
    expect(result.status).toBe("not_outreach");
  });

  it("not_outreach: a job application", () => {
    const result = classifyOutreach({
      messages: [sentMsg],
      sentTextParts: [
        textPart("m1", "Please find my resume attached. I would like to apply for the position."),
      ],
      subjects: [],
    });
    expect(result.status).toBe("not_outreach");
  });

  it("needs_review: subject says collaboration but body reads like a job application", () => {
    const result = classifyOutreach({
      messages: [sentMsg],
      sentTextParts: [
        textPart(
          "m1",
          "cover letter: I would like to apply for the position of marketing collaborator.",
        ),
      ],
      subjects: [{ normalizedMessageId: "m1", rawValue: "Collaboration opportunity" }],
    });
    expect(result.status).toBe("needs_review");
  });

  it("insufficient_evidence: SENT text exists but contains no conclusive language", () => {
    const result = classifyOutreach({
      messages: [sentMsg],
      sentTextParts: [textPart("m1", "Hi there, hope you are well. Talk soon.")],
      subjects: [],
    });
    expect(result.status).toBe("insufficient_evidence");
  });

  it("Finding 10: new text 'Thanks' + quoted hotel 'we'd love to collaborate' is NOT qualified_outreach — the quote is not creator-authored", () => {
    const result = classifyOutreach({
      messages: [sentMsg],
      sentTextParts: [
        textPart(
          "m1",
          "Thanks!\n\nOn Mon, Jan 1, 2026 at 9:00 AM Hotel <marketing@acmehotel.example> wrote:\nWe'd love to collaborate on some UGC content.",
        ),
      ],
      subjects: [],
    });
    expect(result.status).not.toBe("qualified_outreach");
  });

  it("Finding 10: a signature reading 'UGC Creator / Influencer' on an otherwise plain email is NOT qualified_outreach", () => {
    const result = classifyOutreach({
      messages: [sentMsg],
      sentTextParts: [
        textPart(
          "m1",
          "Just checking in on the dates, thanks!\n-- \nJane Doe — UGC Creator / Influencer",
        ),
      ],
      subjects: [],
    });
    expect(result.status).not.toBe("qualified_outreach");
  });

  it("Finding 10: a genuine creator-authored pitch ABOVE a quote still detects proposal language (target evidence decided elsewhere, Amendment #4 Finding 1)", () => {
    const result = classifyOutreach({
      messages: [sentMsg],
      sentTextParts: [
        textPart(
          "m1",
          "Following up — I'd love to collaborate on a paid partnership for a stay next month.\n\nOn Mon wrote:\nsome unrelated quoted text",
        ),
      ],
      subjects: [],
    });
    expect(result.status).toBe("needs_review");
    expect(result.reasonCodes).toContain("creator_commercial_proposal_language_detected");
  });

  it("Finding 7: 'UGC Creator / Travel Influencer' signature (no `-- ` delimiter) on an ordinary message is NOT qualified_outreach", () => {
    const result = classifyOutreach({
      messages: [sentMsg],
      sentTextParts: [
        textPart(
          "m1",
          "Hi there, just checking on the dates for next month.\n\nThanks,\nJane Doe\nUGC Creator\nTravel Influencer",
        ),
      ],
      subjects: [],
    });
    expect(result.status).not.toBe("qualified_outreach");
    expect(result.status).toBe("needs_review");
    expect(result.reasonCodes).toContain("positive_language_uncertain_authorship_only");
  });

  it("Finding 7: the SAME positive vocabulary in the CLEAN body (above the signature) still detects proposal language", () => {
    const result = classifyOutreach({
      messages: [sentMsg],
      sentTextParts: [
        textPart(
          "m1",
          "I'd love to collaborate with your hotel on a paid partnership.\n\nThanks,\nJane Doe\nUGC Creator\nTravel Influencer",
        ),
      ],
      subjects: [],
    });
    expect(result.status).toBe("needs_review");
    expect(result.reasonCodes).toContain("creator_commercial_proposal_language_detected");
  });

  it("insufficient_evidence: no usable SENT text at all (undecodable)", () => {
    const result = classifyOutreach({ messages: [sentMsg], sentTextParts: [], subjects: [] });
    expect(result.status).toBe("insufficient_evidence");
  });

  it("non-SENT content never establishes the positive claim, even with strong collaboration language", () => {
    const result = classifyOutreach({
      messages: [notSentMsg],
      sentTextParts: [textPart("m2", "We would love to collaborate on a UGC partnership!")],
      subjects: [],
    });
    // m2 is not SENT, so its text is never read as evidence — no usable SENT
    // text at all falls back to `no_sent_message`.
    expect(result.status).toBe("insufficient_evidence");
    expect(result.reasonCodes).toContain("no_sent_message");
  });

  it("multiple SENT messages: collaboration language anywhere across them is aggregated", () => {
    const secondSent = { ...sentMsg, normalizedMessageId: "m3", providerMessageId: "m3" };
    const result = classifyOutreach({
      messages: [sentMsg, secondSent],
      sentTextParts: [
        textPart("m1", "hi there"),
        textPart("m3", "following up — would you like to collaborate on a paid partnership?"),
      ],
      subjects: [],
    });
    expect(result.status).toBe("needs_review");
    expect(result.reasonCodes).toContain("creator_commercial_proposal_language_detected");
  });
});

describe("B05 unit: recipients.ts (observed recipient vs target-contact)", () => {
  const noCorroboration = new Set<string>();

  it("EXTERNAL AUDIT AMENDMENT #2, Finding 6: a lone named-person `to` recipient WITHOUT independent corroboration is needs_review, never strong_match", () => {
    const toOnly = assessTargetContacts(
      [recipient({ role: "to", sourceParticipantId: "p1", localPart: "jane.doe" })],
      noCorroboration,
    );
    expect(toOnly.matchQuality).toBe("needs_review");

    const bccOnly = assessTargetContacts(
      [recipient({ role: "bcc", sourceParticipantId: "p2", localPart: "me" })],
      noCorroboration,
    );
    expect(bccOnly.matchQuality).toBe("insufficient_evidence");
  });

  it("Finding 6: a lone `to` recipient WITH independent corroboration (canonical-contact + independently-matched target) IS strong_match", () => {
    const addr = "marketing@acmehotel.example";
    const result = assessTargetContacts(
      [recipient({ role: "to", sourceParticipantId: "p1", localPart: "jane.doe", addrSpec: addr })],
      new Set([addr]),
    );
    expect(result.matchQuality).toBe("strong_match");
  });

  it("a lone `to` recipient at a GENERIC inbox is needs_review, never strong_match (Finding 8 — role alone is not target identity)", () => {
    const result = assessTargetContacts(
      [recipient({ role: "to", sourceParticipantId: "p1", localPart: "marketing" })],
      noCorroboration,
    );
    expect(result.matchQuality).toBe("needs_review");
  });

  it("a lone `cc` (e.g. a manager) yields needs_review, never strong_match", () => {
    const ccOnly = assessTargetContacts(
      [recipient({ role: "cc", sourceParticipantId: "p3", localPart: "manager" })],
      noCorroboration,
    );
    expect(ccOnly.matchQuality).toBe("needs_review");
  });

  it("Finding 6: two `to` recipients at the SAME domain WITHOUT independent corroboration is needs_review, never strong_match by address count alone", () => {
    const result = assessTargetContacts(
      [
        recipient({ role: "to", sourceParticipantId: "p1", localPart: "jane.doe" }),
        recipient({ role: "to", sourceParticipantId: "p2", localPart: "john.smith" }),
      ],
      noCorroboration,
    );
    expect(result.matchQuality).toBe("needs_review");
    expect(result.candidates).toHaveLength(2);
  });

  it("Finding 6: two `to` recipients at the SAME domain, one independently corroborated, IS strong_match", () => {
    const addr = "jane.doe@acmehotel.example";
    const result = assessTargetContacts(
      [
        recipient({ role: "to", sourceParticipantId: "p1", localPart: "jane.doe", addrSpec: addr }),
        recipient({
          role: "to",
          sourceParticipantId: "p2",
          localPart: "john.smith",
          addrSpec: "john.smith@acmehotel.example",
        }),
      ],
      new Set([addr]),
    );
    expect(result.matchQuality).toBe("strong_match");
  });

  it("two `to` recipients at DIFFERENT domains is ambiguous, regardless of corroboration (a real scope signal, not a confidence claim)", () => {
    const result = assessTargetContacts(
      [
        recipient({
          role: "to",
          sourceParticipantId: "p1",
          domainLower: "hotel-a.example",
          addrSpec: "a@hotel-a.example",
        }),
        recipient({
          role: "to",
          sourceParticipantId: "p2",
          domainLower: "hotel-b.example",
          addrSpec: "b@hotel-b.example",
        }),
      ],
      new Set(["a@hotel-a.example"]),
    );
    expect(result.matchQuality).toBe("ambiguous");
  });

  it("distinguishes a generic inbox from a named person by local part (informational evidence, no longer gates strong_match alone)", () => {
    const generic = assessTargetContacts(
      [recipient({ role: "to", localPart: "partnerships" })],
      noCorroboration,
    );
    expect(generic.candidates[0]!.addressPatternEvidence).toBe("generic_inbox");

    const named = assessTargetContacts(
      [recipient({ role: "to", localPart: "jane.doe" })],
      noCorroboration,
    );
    expect(named.candidates[0]!.addressPatternEvidence).toBe("named_person");
  });

  it("never fabricates evidence for a malformed recipient (null local part -> unavailable)", () => {
    const result = assessTargetContacts(
      [recipient({ role: "to", localPart: null, parseStatus: "malformed" })],
      noCorroboration,
    );
    expect(result.candidates[0]!.addressPatternEvidence).toBe("unavailable");
  });

  it("candidateSetFingerprint changes when the observed recipient set changes", () => {
    const a = assessTargetContacts([recipient({ sourceParticipantId: "p1" })], noCorroboration);
    const b = assessTargetContacts([recipient({ sourceParticipantId: "p2" })], noCorroboration);
    expect(a.candidateSetFingerprint).not.toBe(b.candidateSetFingerprint);
  });
});

const PROVIDER_ID_MAP = new Map([["msg-1", "provider-msg-1"]]);

describe("B05 unit: target-extraction.ts (private target observations, D028 conservatism)", () => {
  it("extractDomain strips scheme and www, lower-cases", () => {
    expect(extractDomain("https://www.AcmeHotel.example/path")).toBe("acmehotel.example");
    expect(extractDomain("acmehotel.example")).toBe("acmehotel.example");
    expect(extractDomain(null)).toBeNull();
    expect(extractDomain("not a url")).toBeNull();
  });

  it("generates one observation per distinct non-freemail `to` domain; never from cc/bcc alone", () => {
    const observations = extractTargetObservations(
      [
        recipient({ role: "to", domainLower: "acmehotel.example", sourceParticipantId: "p1" }),
        recipient({ role: "cc", domainLower: "other-domain.example", sourceParticipantId: "p2" }),
      ],
      PROVIDER_ID_MAP,
    );
    expect(observations).toHaveLength(1);
    expect(observations[0]!.observedDomain).toBe("acmehotel.example");
  });

  it("excludes freemail domains entirely — never a target observation for gmail.com etc", () => {
    const observations = extractTargetObservations(
      [
        recipient({
          role: "to",
          domainLower: "gmail.com",
          addrSpec: "someone@gmail.com",
          sourceParticipantId: "p1",
        }),
      ],
      PROVIDER_ID_MAP,
    );
    expect(observations).toHaveLength(0);
  });

  it("observation fingerprint is stable for the same domain across independent extractions (reconciliation key)", () => {
    const a = extractTargetObservations(
      [recipient({ role: "to", domainLower: "acmehotel.example" })],
      PROVIDER_ID_MAP,
    );
    const b = extractTargetObservations(
      [
        recipient({
          role: "to",
          domainLower: "acmehotel.example",
          sourceParticipantId: "different",
        }),
      ],
      PROVIDER_ID_MAP,
    );
    expect(a[0]!.observationFingerprint).toBe(b[0]!.observationFingerprint);
  });

  it("never asserts a source provenance id the database has not itself proven (Finding 1/12): sourceProviderMessageIds carries provider_message_id, not a B04 row uuid", () => {
    const [observation] = extractTargetObservations(
      [recipient({ role: "to", domainLower: "acmehotel.example" })],
      PROVIDER_ID_MAP,
    );
    expect(observation!.sourceProviderMessageIds).toEqual(["provider-msg-1"]);
  });

  it("never synthesizes observedName from the domain (Finding 9 — one signal must not masquerade as two)", () => {
    const [observation] = extractTargetObservations(
      [recipient({ role: "to", domainLower: "acmehotel.example", displayName: null })],
      PROVIDER_ID_MAP,
    );
    expect(observation!.observedName).toBeNull();
  });

  it("uses genuine recipient display-name evidence when present, never a domain-derived label", () => {
    const [observation] = extractTargetObservations(
      [
        recipient({
          role: "to",
          domainLower: "acmehotel.example",
          displayName: "Acme Hotel Marketing",
        }),
      ],
      PROVIDER_ID_MAP,
    );
    expect(observation!.observedName).toBe("Acme Hotel Marketing");
  });

  it("matchTargetObservation: exact domain agreement alone yields needs_review, never strong_match (D028 — one signal is not enough)", () => {
    const [observation] = extractTargetObservations(
      [recipient({ role: "to", domainLower: "acmehotel.example" })],
      PROVIDER_ID_MAP,
    );
    const result = matchTargetObservation(observation!, [], {
      epoch: 1,
      hotels: [{ id: "hotel-1", name: "Something Unrelated", websiteDomain: "acmehotel.example" }],
      organizations: [],
      hotelIdByContactEmail: new Map(),
      organizationIdByContactEmail: new Map(),
      hotelOrganizationLinks: [],
    });
    expect(result.observation.machineCanonicalLinkAssessment).toBe("needs_review");
    expect(result.links).toHaveLength(1);
    expect(result.links[0]!.domainEvidence).toBe("agrees");
  });

  it("matchTargetObservation: domain AND contact-email agreement together yields strong_match", () => {
    const [observation] = extractTargetObservations(
      [recipient({ role: "to", domainLower: "acmehotel.example" })],
      PROVIDER_ID_MAP,
    );
    const result = matchTargetObservation(observation!, ["marketing@acmehotel.example"], {
      epoch: 1,
      hotels: [{ id: "hotel-1", name: "Acme Hotel", websiteDomain: "acmehotel.example" }],
      organizations: [],
      hotelIdByContactEmail: new Map([["marketing@acmehotel.example", new Set(["hotel-1"])]]),
      organizationIdByContactEmail: new Map(),
      hotelOrganizationLinks: [],
    });
    expect(result.observation.machineCanonicalLinkAssessment).toBe("strong_match");
  });

  it("matchTargetObservation: the SAME email matching TWO hotel_contacts is preserved as ambiguous evidence, never collapsed to one (Finding 5)", () => {
    const [observation] = extractTargetObservations(
      [recipient({ role: "to", domainLower: "sharedemail.example" })],
      PROVIDER_ID_MAP,
    );
    const result = matchTargetObservation(observation!, ["shared@sharedemail.example"], {
      epoch: 1,
      hotels: [
        { id: "hotel-1", name: "Hotel One", websiteDomain: null },
        { id: "hotel-2", name: "Hotel Two", websiteDomain: null },
      ],
      organizations: [],
      hotelIdByContactEmail: new Map([
        ["shared@sharedemail.example", new Set(["hotel-1", "hotel-2"])],
      ]),
      organizationIdByContactEmail: new Map(),
      hotelOrganizationLinks: [],
    });
    const withContactEvidence = result.links.filter((l) => l.contactEvidence === "agrees");
    expect(withContactEvidence).toHaveLength(2);
  });

  it("matchTargetObservation: two equally-strong candidates yields ambiguous, never an arbitrary pick", () => {
    const [observation] = extractTargetObservations(
      [recipient({ role: "to", domainLower: "sharedchain.example" })],
      PROVIDER_ID_MAP,
    );
    const result = matchTargetObservation(observation!, [], {
      epoch: 1,
      hotels: [
        { id: "hotel-1", name: "Chain Hotel A", websiteDomain: "sharedchain.example" },
        { id: "hotel-2", name: "Chain Hotel B", websiteDomain: "sharedchain.example" },
      ],
      organizations: [],
      hotelIdByContactEmail: new Map(),
      organizationIdByContactEmail: new Map(),
      hotelOrganizationLinks: [],
    });
    expect(result.observation.machineCanonicalLinkAssessment).toBe("ambiguous");
    expect(result.links).toHaveLength(2);
  });

  it("matchTargetObservation: zero candidates yields insufficient_evidence, a valid B05 state, never an error", () => {
    const [observation] = extractTargetObservations(
      [recipient({ role: "to", domainLower: "unknown-brand.example" })],
      PROVIDER_ID_MAP,
    );
    const result = matchTargetObservation(observation!, [], {
      epoch: 1,
      hotels: [],
      organizations: [],
      hotelIdByContactEmail: new Map(),
      organizationIdByContactEmail: new Map(),
      hotelOrganizationLinks: [],
    });
    expect(result.observation.machineCanonicalLinkAssessment).toBe("insufficient_evidence");
    expect(result.links).toHaveLength(0);
  });

  it("an organization is a legitimate target kind in its own right (D029), never forced into a hotel", () => {
    const [observation] = extractTargetObservations(
      [recipient({ role: "to", domainLower: "agencyx.example" })],
      PROVIDER_ID_MAP,
    );
    const result = matchTargetObservation(observation!, ["contact@agencyx.example"], {
      epoch: 1,
      hotels: [],
      organizations: [{ id: "org-1", name: "Agency X", websiteDomain: "agencyx.example" }],
      hotelIdByContactEmail: new Map(),
      organizationIdByContactEmail: new Map([["contact@agencyx.example", new Set(["org-1"])]]),
      hotelOrganizationLinks: [],
    });
    expect(result.links[0]!.targetKind).toBe("organization");
    expect(result.links[0]!.targetOrganizationId).toBe("org-1");
    expect(result.links[0]!.targetHotelId).toBeUndefined();
  });
});

describe("B05 unit: target-extraction.ts (EXTERNAL AUDIT AMENDMENT #4, Finding 2 — authored-text target evidence)", () => {
  it("extractAuthoredTextNameCandidates finds contiguous capitalized-word phrases, including internal connectors", () => {
    const phrases = extractAuthoredTextNameCandidates(
      "I'd love to collaborate with Hotel A and also Bank of America Resorts on a UGC campaign.",
    );
    expect(phrases).toContain("Hotel A");
    expect(phrases).toContain("Bank of America Resorts");
  });

  it("never treats an ordinary sentence-leading capital or a person's name as evidence by itself — only a REAL catalog exact match counts", () => {
    const text = "Thanks! Best, Jane Doe";
    const evidence = computeAuthoredTextTargetEvidence(
      extractAuthoredTextNameCandidates(text),
      { hotels: [{ id: "hotel-1", name: "Acme Hotel", websiteDomain: null }], organizations: [] },
      text,
    );
    expect(evidence.matchedHotelIds.size).toBe(0);
  });

  it("an exact (normalized) match against a real canonical hotel name IN A TARGET-DIRECTED CONTEXT is 'agrees' authored-text evidence", () => {
    const text = "I'd love to feature Acme Hotel on my channel.";
    const evidence = computeAuthoredTextTargetEvidence(
      extractAuthoredTextNameCandidates(text),
      { hotels: [{ id: "hotel-1", name: "Acme Hotel", websiteDomain: null }], organizations: [] },
      text,
    );
    expect(evidence.matchedHotelIds.has("hotel-1")).toBe(true);
  });

  it("EXTERNAL AUDIT AMENDMENT #5, Finding 1: a business explicitly named in authored text with ZERO domain/contact relation to THIS observation no longer enters ITS candidate universe at all — it becomes its own independent observation instead (see audit-amendment-5.test.ts)", () => {
    const [observation] = extractTargetObservations(
      [recipient({ role: "to", domainLower: "agencyx.example" })],
      PROVIDER_ID_MAP,
    );
    const text = "I'd love to feature Acme Hotel on my channel.";
    const result = matchTargetObservation(
      observation!,
      [],
      {
        epoch: 1,
        hotels: [{ id: "hotel-1", name: "Acme Hotel", websiteDomain: "unrelated-domain.example" }],
        organizations: [],
        hotelIdByContactEmail: new Map(),
        organizationIdByContactEmail: new Map(),
        hotelOrganizationLinks: [],
      },
      ["Acme Hotel"],
      text,
    );
    expect(result.links.find((l) => l.targetHotelId === "hotel-1")).toBeUndefined();
    expect(result.observation.machineCanonicalLinkAssessment).toBe("insufficient_evidence");
  });

  it("Finding 2: authored text explicitly naming a DIFFERENT real business than the domain/contact-strong one caps it at needs_review, never strong_match", () => {
    const text = "I'd like to collaborate with Hotel B instead.";
    const [observation] = extractTargetObservations(
      [recipient({ role: "to", domainLower: "hotel-a.example" })],
      PROVIDER_ID_MAP,
    );
    const result = matchTargetObservation(
      observation!,
      ["marketing@hotel-a.example"],
      {
        epoch: 1,
        hotels: [
          { id: "hotel-a", name: "Hotel A", websiteDomain: "hotel-a.example" },
          { id: "hotel-b", name: "Hotel B", websiteDomain: "hotel-b.example" },
        ],
        organizations: [],
        hotelIdByContactEmail: new Map([["marketing@hotel-a.example", new Set(["hotel-a"])]]),
        organizationIdByContactEmail: new Map(),
        hotelOrganizationLinks: [],
      },
      ["Hotel B"],
      text,
    );
    expect(result.observation.machineCanonicalLinkAssessment).toBe("needs_review");
    const hotelALink = result.links.find((l) => l.targetHotelId === "hotel-a");
    expect(hotelALink!.authoredTextEvidence).toBe("differs");
  });

  it("Finding 2: authored text agreeing with the domain-strong candidate ADDS corroboration (extra agreement), never displacing it", () => {
    const text = "I'd love to work with Hotel A on a paid partnership.";
    const [observation] = extractTargetObservations(
      [recipient({ role: "to", domainLower: "hotel-a.example" })],
      PROVIDER_ID_MAP,
    );
    const result = matchTargetObservation(
      observation!,
      ["marketing@hotel-a.example"],
      {
        epoch: 1,
        hotels: [{ id: "hotel-a", name: "Hotel A", websiteDomain: "hotel-a.example" }],
        organizations: [],
        hotelIdByContactEmail: new Map([["marketing@hotel-a.example", new Set(["hotel-a"])]]),
        organizationIdByContactEmail: new Map(),
        hotelOrganizationLinks: [],
      },
      ["Hotel A"],
      text,
    );
    expect(result.observation.machineCanonicalLinkAssessment).toBe("strong_match");
    expect(result.links[0]!.authoredTextEvidence).toBe("agrees");
  });

  it("no authored-text candidate phrases at all leaves authoredTextEvidence unavailable, never a false contradiction", () => {
    const [observation] = extractTargetObservations(
      [recipient({ role: "to", domainLower: "acmehotel.example" })],
      PROVIDER_ID_MAP,
    );
    const result = matchTargetObservation(observation!, ["marketing@acmehotel.example"], {
      epoch: 1,
      hotels: [{ id: "hotel-1", name: "Acme Hotel", websiteDomain: "acmehotel.example" }],
      organizations: [],
      hotelIdByContactEmail: new Map([["marketing@acmehotel.example", new Set(["hotel-1"])]]),
      organizationIdByContactEmail: new Map(),
      hotelOrganizationLinks: [],
    });
    expect(result.observation.machineCanonicalLinkAssessment).toBe("strong_match");
    expect(result.links[0]!.authoredTextEvidence).toBe("unavailable");
  });
});

describe("B05 unit: target-extraction.ts (EXTERNAL AUDIT AMENDMENT #5, Finding 2 — differs vs unavailable)", () => {
  it("required regression: strong domain/contact match for Hotel A + body naming no real business ('Hi Jane, I'd love to collaborate with your hotel.') stays 'unavailable', never 'differs'", () => {
    const text = "Hi Jane, I'd love to collaborate with your hotel.";
    const [observation] = extractTargetObservations(
      [recipient({ role: "to", domainLower: "hotel-a.example" })],
      PROVIDER_ID_MAP,
    );
    const result = matchTargetObservation(
      observation!,
      ["marketing@hotel-a.example"],
      {
        epoch: 1,
        hotels: [{ id: "hotel-a", name: "Hotel A", websiteDomain: "hotel-a.example" }],
        organizations: [],
        hotelIdByContactEmail: new Map([["marketing@hotel-a.example", new Set(["hotel-a"])]]),
        organizationIdByContactEmail: new Map(),
        hotelOrganizationLinks: [],
      },
      extractAuthoredTextNameCandidates(text),
      text,
    );
    expect(result.observation.machineCanonicalLinkAssessment).toBe("strong_match");
    expect(result.links[0]!.authoredTextEvidence).toBe("unavailable");
  });
});

describe("B05 unit: target-extraction.ts (EXTERNAL AUDIT AMENDMENT #5, Finding 3 — target-directed context)", () => {
  const catalog = {
    hotels: [{ id: "hotel-marriott", name: "Marriott", websiteDomain: null }],
    organizations: [],
  };

  it("required regression: a bare historical mention ('I worked with Marriott last year') is NOT target-directed evidence", () => {
    const text = "I worked with Marriott last year on a similar campaign.";
    const evidence = computeAuthoredTextTargetEvidence(
      extractAuthoredTextNameCandidates(text),
      catalog,
      text,
    );
    expect(evidence.matchedHotelIds.size).toBe(0);
    expect(evidence.hasAnyRealAuthoredTargetMatch).toBe(false);
  });

  it("required regression: genuine target-directed phrasing ('I'd love to collaborate with Marriott') IS target evidence", () => {
    const text = "I'd love to collaborate with Marriott on a UGC campaign.";
    const evidence = computeAuthoredTextTargetEvidence(
      extractAuthoredTextNameCandidates(text),
      catalog,
      text,
    );
    expect(evidence.matchedHotelIds.has("hotel-marriott")).toBe(true);
  });

  it("required regression: 'Hotel A was a previous client; I'd like to collaborate with Hotel B' — only Hotel B is current target evidence, Hotel A's historical mention never competes", () => {
    const text = "Hotel A was a previous client; I'd like to collaborate with Hotel B this year.";
    const twoHotelCatalog = {
      hotels: [
        { id: "hotel-a", name: "Hotel A", websiteDomain: null },
        { id: "hotel-b", name: "Hotel B", websiteDomain: null },
      ],
      organizations: [],
    };
    const evidence = computeAuthoredTextTargetEvidence(
      extractAuthoredTextNameCandidates(text),
      twoHotelCatalog,
      text,
    );
    expect(evidence.matchedHotelIds.has("hotel-b")).toBe(true);
    expect(evidence.matchedHotelIds.has("hotel-a")).toBe(false);
  });

  it("required regression: an ordinary proper name never becomes target evidence absent the full target-directed rule", () => {
    const text = "Marriott is a well-known hotel brand.";
    const evidence = computeAuthoredTextTargetEvidence(
      extractAuthoredTextNameCandidates(text),
      catalog,
      text,
    );
    expect(evidence.matchedHotelIds.size).toBe(0);
  });
});

describe("B05 unit: target-extraction.ts (detectScopeLanguage, Finding 5)", () => {
  it("detects portfolio/group language", () => {
    expect(
      detectScopeLanguage("We'd love to feature you across your portfolio of hotels")
        .hasPortfolioLanguage,
    ).toBe(true);
    expect(
      detectScopeLanguage("Would love to collaborate with each of your properties")
        .hasPortfolioLanguage,
    ).toBe(true);
  });

  it("detects single-entity language", () => {
    expect(
      detectScopeLanguage("I'd love to feature your hotel in my next video")
        .hasSingleEntityLanguage,
    ).toBe(true);
    expect(
      detectScopeLanguage("Excited to stay at your property next month").hasSingleEntityLanguage,
    ).toBe(true);
  });

  it("ordinary text with neither signal reports both false", () => {
    const result = detectScopeLanguage("Hi there, just checking on the dates.");
    expect(result.hasPortfolioLanguage).toBe(false);
    expect(result.hasSingleEntityLanguage).toBe(false);
  });
});

describe("B05 unit: target-extraction.ts (deriveMachineTargetScope, EXTERNAL AUDIT AMENDMENT #2 Finding 5 — intent-based, never cardinality)", () => {
  it("zero candidates is unresolved", () => {
    expect(
      deriveMachineTargetScope(
        [],
        { hasPortfolioLanguage: false, hasSingleEntityLanguage: false },
        [],
      ).scope,
    ).toBe("unresolved");
  });

  // D070 explicitly rejected deriving scope from observation COUNT. This is
  // the same single organization candidate in all three cases — the scope
  // must come from the message's own commercial-intent language, never from
  // how many observations were extracted.
  const orgObservation = {
    observationFingerprint: "fp-org-1",
    observedName: "Acme Hospitality Group",
    observedDomain: "acmegroup.example",
    targetKindHint: "organization" as const,
    observationSourceKind: "recipient_domain" as const,
    sourceProviderMessageIds: ["provider-msg-1"],
    machineCanonicalLinkAssessment: "strong_match" as const,
    candidateSetFingerprint: "fp",
  };
  const strongOrgLink = {
    observationFingerprint: "fp-org-1",
    targetKind: "organization" as const,
    targetOrganizationId: "org-1",
    nameEvidence: "agrees" as const,
    domainEvidence: "agrees" as const,
    addressEvidence: "unavailable" as const,
    contactEvidence: "unavailable" as const,
    authoredTextEvidence: "unavailable" as const,
    rank: 0,
  };
  const sameOrgCandidate = [{ observation: orgObservation, bestLink: strongOrgLink }];

  it("message A (direct proposal, single-entity language): infers single_target from the SAME single org candidate", () => {
    const language = detectScopeLanguage("I'd love to feature your hotel in an upcoming video.");
    const result = deriveMachineTargetScope(sameOrgCandidate, language, []);
    expect(result.scope).toBe("single_target");
  });

  it("message B (portfolio ask, portfolio language): infers portfolio_target from the SAME single org candidate", () => {
    const language = detectScopeLanguage(
      "Would love to collaborate across your portfolio of properties.",
    );
    const result = deriveMachineTargetScope(sameOrgCandidate, language, []);
    expect(result.scope).toBe("portfolio_target");
  });

  it("message C (ambiguous, no scope language): unresolved from the SAME single org candidate — never derived from cardinality", () => {
    const language = detectScopeLanguage("Thanks for getting back to me, let's talk soon.");
    const result = deriveMachineTargetScope(sameOrgCandidate, language, []);
    expect(result.scope).toBe("unresolved");
  });

  it("portfolio_target reason codes cite catalog corroboration when hotel_organizations shows a real multi-hotel portfolio", () => {
    const language = { hasPortfolioLanguage: true, hasSingleEntityLanguage: false };
    const links = [
      { hotelId: "hotel-1", organizationId: "org-1", relationship: "corporate_group" },
      { hotelId: "hotel-2", organizationId: "org-1", relationship: "corporate_group" },
    ];
    const result = deriveMachineTargetScope(sameOrgCandidate, language, links);
    expect(result.scope).toBe("portfolio_target");
    expect(result.reasonCodes).toContain("organization_portfolio_evidence");
  });

  it("two independently strong-matched candidates with no scope language is multiple_targets", () => {
    const candidateA = {
      observation: { ...orgObservation, observationFingerprint: "fp-a" },
      bestLink: { ...strongOrgLink, observationFingerprint: "fp-a", targetOrganizationId: "org-a" },
    };
    const candidateB = {
      observation: { ...orgObservation, observationFingerprint: "fp-b" },
      bestLink: { ...strongOrgLink, observationFingerprint: "fp-b", targetOrganizationId: "org-b" },
    };
    const language = { hasPortfolioLanguage: false, hasSingleEntityLanguage: false };
    const result = deriveMachineTargetScope([candidateA, candidateB], language, []);
    expect(result.scope).toBe("multiple_targets");
  });

  it("multiple candidates but only one strongly matched, no scope language: unresolved (never guesses from the weak one)", () => {
    const weakCandidate = {
      observation: {
        ...orgObservation,
        observationFingerprint: "fp-weak",
        machineCanonicalLinkAssessment: "needs_review" as const,
      },
      bestLink: null,
    };
    const language = { hasPortfolioLanguage: false, hasSingleEntityLanguage: false };
    const result = deriveMachineTargetScope([sameOrgCandidate[0]!, weakCandidate], language, []);
    expect(result.scope).toBe("unresolved");
  });
});
