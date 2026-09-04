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
    expect(buildClassifierInputForMessage(parts)).toBe("plain");
  });

  it("falls back to heuristically-stripped HTML when no plain part decoded", () => {
    const parts = [part({ mimeType: "text/html", decodedText: "<p>Hello <b>World</b></p>" })];
    expect(buildClassifierInputForMessage(parts)).toBe("Hello World");
  });

  it("returns null when nothing decoded (undecodable / body absent)", () => {
    const parts = [part({ decodeStatus: "body_absent", decodedText: null })];
    expect(buildClassifierInputForMessage(parts)).toBeNull();
  });

  it("empty_decoded is usable (a real empty body, not absence of evidence)", () => {
    const parts = [part({ decodeStatus: "empty_decoded", decodedText: "" })];
    expect(buildClassifierInputForMessage(parts)).toBe("");
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

  it("qualified_outreach: UGC/collaboration pitch in SENT text", () => {
    const result = classifyOutreach({
      messages: [sentMsg],
      sentTextParts: [
        textPart("m1", "Hi! I'd love to collaborate with your hotel on some UGC content."),
      ],
      subjects: [],
    });
    expect(result.status).toBe("qualified_outreach");
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
    expect(result.status).toBe("qualified_outreach");
  });
});

describe("B05 unit: recipients.ts (observed recipient vs target-contact)", () => {
  it("a `to` recipient yields strong_match; a lone `bcc` (e.g. creator's own second address) never does", () => {
    const toOnly = assessTargetContacts([recipient({ role: "to", sourceParticipantId: "p1" })]);
    expect(toOnly.matchQuality).toBe("strong_match");

    const bccOnly = assessTargetContacts([
      recipient({ role: "bcc", sourceParticipantId: "p2", localPart: "me" }),
    ]);
    expect(bccOnly.matchQuality).toBe("insufficient_evidence");
  });

  it("a lone `cc` (e.g. a manager) yields needs_review, never strong_match", () => {
    const ccOnly = assessTargetContacts([
      recipient({ role: "cc", sourceParticipantId: "p3", localPart: "manager" }),
    ]);
    expect(ccOnly.matchQuality).toBe("needs_review");
  });

  it("two `to` recipients at the SAME domain remain strong_match (multiple legitimate contacts)", () => {
    const result = assessTargetContacts([
      recipient({ role: "to", sourceParticipantId: "p1", localPart: "jane.doe" }),
      recipient({ role: "to", sourceParticipantId: "p2", localPart: "john.smith" }),
    ]);
    expect(result.matchQuality).toBe("strong_match");
    expect(result.candidates).toHaveLength(2);
  });

  it("two `to` recipients at DIFFERENT domains is ambiguous", () => {
    const result = assessTargetContacts([
      recipient({ role: "to", sourceParticipantId: "p1", domainLower: "hotel-a.example" }),
      recipient({ role: "to", sourceParticipantId: "p2", domainLower: "hotel-b.example" }),
    ]);
    expect(result.matchQuality).toBe("ambiguous");
  });

  it("distinguishes a generic inbox from a named person by local part", () => {
    const generic = assessTargetContacts([recipient({ role: "to", localPart: "partnerships" })]);
    expect(generic.candidates[0]!.addressPatternEvidence).toBe("generic_inbox");

    const named = assessTargetContacts([recipient({ role: "to", localPart: "jane.doe" })]);
    expect(named.candidates[0]!.addressPatternEvidence).toBe("named_person");
  });

  it("never fabricates evidence for a malformed recipient (null local part -> unavailable)", () => {
    const result = assessTargetContacts([
      recipient({ role: "to", localPart: null, parseStatus: "malformed" }),
    ]);
    expect(result.candidates[0]!.addressPatternEvidence).toBe("unavailable");
  });

  it("candidateSetFingerprint changes when the observed recipient set changes", () => {
    const a = assessTargetContacts([recipient({ sourceParticipantId: "p1" })]);
    const b = assessTargetContacts([recipient({ sourceParticipantId: "p2" })]);
    expect(a.candidateSetFingerprint).not.toBe(b.candidateSetFingerprint);
  });
});

describe("B05 unit: target-extraction.ts (private target observations, D028 conservatism)", () => {
  it("extractDomain strips scheme and www, lower-cases", () => {
    expect(extractDomain("https://www.AcmeHotel.example/path")).toBe("acmehotel.example");
    expect(extractDomain("acmehotel.example")).toBe("acmehotel.example");
    expect(extractDomain(null)).toBeNull();
    expect(extractDomain("not a url")).toBeNull();
  });

  it("generates one observation per distinct non-freemail `to` domain; never from cc/bcc alone", () => {
    const observations = extractTargetObservations([
      recipient({ role: "to", domainLower: "acmehotel.example", sourceParticipantId: "p1" }),
      recipient({ role: "cc", domainLower: "other-domain.example", sourceParticipantId: "p2" }),
    ]);
    expect(observations).toHaveLength(1);
    expect(observations[0]!.observedDomain).toBe("acmehotel.example");
  });

  it("excludes freemail domains entirely — never a target observation for gmail.com etc", () => {
    const observations = extractTargetObservations([
      recipient({
        role: "to",
        domainLower: "gmail.com",
        addrSpec: "someone@gmail.com",
        sourceParticipantId: "p1",
      }),
    ]);
    expect(observations).toHaveLength(0);
  });

  it("observation fingerprint is stable for the same domain across independent extractions (reconciliation key)", () => {
    const a = extractTargetObservations([
      recipient({ role: "to", domainLower: "acmehotel.example" }),
    ]);
    const b = extractTargetObservations([
      recipient({ role: "to", domainLower: "acmehotel.example", sourceParticipantId: "different" }),
    ]);
    expect(a[0]!.observationFingerprint).toBe(b[0]!.observationFingerprint);
  });

  it("matchTargetObservation: exact domain agreement alone yields needs_review, never strong_match (D028 — one signal is not enough)", () => {
    const [observation] = extractTargetObservations([
      recipient({ role: "to", domainLower: "acmehotel.example" }),
    ]);
    const result = matchTargetObservation(observation!, [], {
      epoch: 1,
      hotels: [{ id: "hotel-1", name: "Something Unrelated", websiteDomain: "acmehotel.example" }],
      organizations: [],
      hotelIdByContactEmail: new Map(),
      organizationIdByContactEmail: new Map(),
    });
    expect(result.observation.machineCanonicalLinkAssessment).toBe("needs_review");
    expect(result.links).toHaveLength(1);
    expect(result.links[0]!.domainEvidence).toBe("agrees");
  });

  it("matchTargetObservation: domain AND contact-email agreement together yields strong_match", () => {
    const [observation] = extractTargetObservations([
      recipient({ role: "to", domainLower: "acmehotel.example" }),
    ]);
    const result = matchTargetObservation(observation!, ["marketing@acmehotel.example"], {
      epoch: 1,
      hotels: [{ id: "hotel-1", name: "Acme Hotel", websiteDomain: "acmehotel.example" }],
      organizations: [],
      hotelIdByContactEmail: new Map([["marketing@acmehotel.example", "hotel-1"]]),
      organizationIdByContactEmail: new Map(),
    });
    expect(result.observation.machineCanonicalLinkAssessment).toBe("strong_match");
  });

  it("matchTargetObservation: two equally-strong candidates yields ambiguous, never an arbitrary pick", () => {
    const [observation] = extractTargetObservations([
      recipient({ role: "to", domainLower: "sharedchain.example" }),
    ]);
    const result = matchTargetObservation(observation!, [], {
      epoch: 1,
      hotels: [
        { id: "hotel-1", name: "Chain Hotel A", websiteDomain: "sharedchain.example" },
        { id: "hotel-2", name: "Chain Hotel B", websiteDomain: "sharedchain.example" },
      ],
      organizations: [],
      hotelIdByContactEmail: new Map(),
      organizationIdByContactEmail: new Map(),
    });
    expect(result.observation.machineCanonicalLinkAssessment).toBe("ambiguous");
    expect(result.links).toHaveLength(2);
  });

  it("matchTargetObservation: zero candidates yields insufficient_evidence, a valid B05 state, never an error", () => {
    const [observation] = extractTargetObservations([
      recipient({ role: "to", domainLower: "unknown-brand.example" }),
    ]);
    const result = matchTargetObservation(observation!, [], {
      epoch: 1,
      hotels: [],
      organizations: [],
      hotelIdByContactEmail: new Map(),
      organizationIdByContactEmail: new Map(),
    });
    expect(result.observation.machineCanonicalLinkAssessment).toBe("insufficient_evidence");
    expect(result.links).toHaveLength(0);
  });

  it("an organization is a legitimate target kind in its own right (D029), never forced into a hotel", () => {
    const [observation] = extractTargetObservations([
      recipient({ role: "to", domainLower: "agencyx.example" }),
    ]);
    const result = matchTargetObservation(observation!, ["contact@agencyx.example"], {
      epoch: 1,
      hotels: [],
      organizations: [{ id: "org-1", name: "Agency X", websiteDomain: "agencyx.example" }],
      hotelIdByContactEmail: new Map(),
      organizationIdByContactEmail: new Map([["contact@agencyx.example", "org-1"]]),
    });
    expect(result.links[0]!.targetKind).toBe("organization");
    expect(result.links[0]!.targetOrganizationId).toBe("org-1");
    expect(result.links[0]!.targetHotelId).toBeUndefined();
  });
});
