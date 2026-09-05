/**
 * B05 SYNTHETIC EVALUATION CORPUS — hand-labeled fixtures only, never
 * production data and never a database table (D070, contract §20). Every
 * gold label here is an author's judgment call on a synthetic example, not a
 * ground truth extracted from a real creator's mailbox.
 */
import type {
  EvidenceRecipient,
  MatchQuality,
  OutreachStatus,
} from "@/lib/gmail/outreach/contract";

export interface OutreachExample {
  readonly id: string;
  readonly gold: OutreachStatus;
  readonly subject: string;
  /** One or more creator-SENT message bodies in this synthetic thread. */
  readonly sentBodies: readonly string[];
}

export const OUTREACH_CORPUS: readonly OutreachExample[] = [
  // --- qualified_outreach: varied phrasing of a genuine commercial pitch ---
  {
    id: "qo-1",
    gold: "qualified_outreach",
    subject: "Collaboration opportunity",
    sentBodies: ["Hi! I'd love to collaborate with your hotel on some UGC content for Instagram."],
  },
  {
    id: "qo-2",
    gold: "qualified_outreach",
    subject: "Partnership idea",
    sentBodies: [
      "Hello, I run a travel content account and wanted to pitch a paid partnership for a upcoming stay.",
    ],
  },
  {
    id: "qo-3",
    gold: "qualified_outreach",
    subject: "Press trip inquiry",
    sentBodies: [
      "Following up on our call — happy to arrange a press trip in exchange for content coverage.",
    ],
  },
  {
    id: "qo-4",
    gold: "qualified_outreach",
    subject: "Media kit attached",
    sentBodies: [
      "Attaching my media kit and rate card in case you're interested in a sponsored stay.",
    ],
  },
  {
    id: "qo-5",
    gold: "qualified_outreach",
    subject: "Influencer collab",
    sentBodies: [
      "I'm an influencer in the luxury travel space and would love to feature your property in exchange for a complimentary stay.",
    ],
  },
  {
    id: "qo-6",
    gold: "qualified_outreach",
    subject: "Content creation proposal",
    sentBodies: [
      "We specialize in content creation for hospitality brands — open to a barter arrangement for a hosted stay?",
    ],
  },
  {
    id: "qo-7",
    gold: "qualified_outreach",
    subject: "re: creator collaboration",
    sentBodies: [
      "Thanks for getting back to me! Yes, I'd like to move forward pitching the creator collaboration we discussed.",
    ],
  },
  {
    id: "qo-8",
    gold: "qualified_outreach",
    subject: "Sponsorship follow-up",
    sentBodies: [
      "Just checking in on the sponsorship we talked about last week — still interested in featuring your brand.",
    ],
  },

  // --- not_outreach: guest-service and unrelated correspondence ---
  {
    id: "no-1",
    gold: "not_outreach",
    subject: "Booking question",
    sentBodies: [
      "Hi, I'd like to make a reservation for two nights, check-in Friday and check-out Sunday.",
    ],
  },
  {
    id: "no-2",
    gold: "not_outreach",
    subject: "Refund request",
    sentBodies: [
      "I'm very disappointed with our stay and would like a refund — this is unacceptable.",
    ],
  },
  {
    id: "no-3",
    gold: "not_outreach",
    subject: "Job application",
    sentBodies: [
      "Please find my resume attached. I would like to apply for the position of front desk associate.",
    ],
  },
  {
    id: "no-4",
    gold: "not_outreach",
    subject: "Family vacation planning",
    sentBodies: [
      "We're planning a family vacation for spring break and wanted to ask about connecting rooms.",
    ],
  },
  {
    id: "no-5",
    gold: "not_outreach",
    subject: "Honeymoon package",
    sentBodies: [
      "My partner and I are looking into a honeymoon package — do you have any availability in June?",
    ],
  },
  {
    id: "no-6",
    gold: "not_outreach",
    subject: "Unsubscribe",
    sentBodies: [
      "Please unsubscribe me from this list. View this email in your browser if the link above doesn't work.",
    ],
  },
  {
    id: "no-7",
    gold: "not_outreach",
    subject: "Pricing plans",
    sentBodies: ["Wanted to share our pricing plans — book a demo any time this week if useful."],
  },
  {
    id: "no-8",
    gold: "not_outreach",
    subject: "Complaint about check-in",
    sentBodies: [
      "Our check-in and check-out experience was a mess and I want to file a complaint.",
    ],
  },

  // --- needs_review: genuinely mixed/conflicting signal ---
  {
    id: "nr-1",
    gold: "needs_review",
    subject: "Collaboration opportunity",
    sentBodies: ["cover letter: I would like to apply for the position of marketing collaborator."],
  },
  {
    id: "nr-2",
    gold: "needs_review",
    subject: "Partnership vs refund",
    sentBodies: [
      "I loved our sponsored stay but honestly this trip left me disappointed with our stay — unacceptable service.",
    ],
  },

  // --- insufficient_evidence: no conclusive language either way ---
  {
    id: "ie-1",
    gold: "insufficient_evidence",
    subject: "Hi",
    sentBodies: ["Hi there, hope you are well. Talk soon."],
  },
  {
    id: "ie-2",
    gold: "insufficient_evidence",
    subject: "Quick question",
    sentBodies: ["Just wanted to say thanks for the chat earlier, catch up soon!"],
  },
];

/**
 * EXTERNAL AUDIT AMENDMENT #5, Finding 4: unlike `OUTREACH_CORPUS` (which
 * evaluates ONLY `classifyOutreach`'s own proposal-language signal), this
 * corpus exercises the REAL end-to-end `interpretOneThread` combination
 * against a real Postgres database — the actual final B05 outreach status a
 * creator would see, including D070 §5's third (target-directed) requirement.
 */
export interface FinalInterpretationExample {
  readonly id: string;
  readonly gold: OutreachStatus;
  readonly subject: string;
  readonly sentBodies: readonly string[];
  readonly toRecipient: string;
  /** When set, a real canonical hotel row is inserted with this exact name before interpretation. */
  readonly hotelName?: string;
}

export const FINAL_INTERPRETATION_CORPUS: readonly FinalInterpretationExample[] = [
  {
    id: "fi-1",
    gold: "qualified_outreach",
    subject: "Collaboration opportunity",
    sentBodies: ["I'd love to collaborate with your hotel on some UGC content."],
    toRecipient: "marketing@fi-business-hotel.example",
  },
  {
    id: "fi-2",
    gold: "needs_review",
    subject: "Collaboration opportunity",
    sentBodies: ["I'd love to collaborate on some UGC content and a paid partnership."],
    toRecipient: "me@gmail.com",
  },
  {
    id: "fi-3",
    gold: "qualified_outreach",
    subject: "Collaboration via agency",
    sentBodies: ["I'd love to collaborate with FI Ambassador Hotel on a paid partnership."],
    toRecipient: "jane@fi-agency.example",
    hotelName: "FI Ambassador Hotel",
  },
  {
    id: "fi-4",
    gold: "not_outreach",
    subject: "Booking question",
    sentBodies: ["I would like a reservation for two nights, check-in Friday check-out Sunday."],
    toRecipient: "frontdesk@fi-quiet-hotel.example",
  },
  {
    id: "fi-5",
    gold: "insufficient_evidence",
    subject: "Hi",
    sentBodies: ["Hi there, hope you are well. Talk soon."],
    toRecipient: "someone@fi-other-hotel.example",
  },
  {
    // EXTERNAL AUDIT AMENDMENT #6, Finding 6: a NATURAL coordinated
    // multi-target list — the commercial verb is NOT repeated before each
    // item — is exactly the real-world phrasing this evaluation must guard
    // against regressing (Finding 1's fix). Deliberately distinct from
    // "collaborate with Hotel A and also collaborate with Hotel B", which
    // would pass even without the coordinated-list fix. A FREEMAIL recipient
    // means `qualified_outreach` can ONLY be reached via the authored-text
    // coordinated-list match succeeding — a non-freemail recipient would
    // qualify via domain evidence alone regardless of whether the
    // coordinated-list fix regresses. Only "FI Multi Hotel Beta" (the
    // SECOND, non-verb-adjacent item) is a real catalog hotel — recognizing
    // it can ONLY happen via the coordinated-list fix, never the original
    // per-phrase-adjacency-only check (which only ever recognized the FIRST
    // item, directly next to the verb).
    id: "fi-6",
    gold: "qualified_outreach",
    subject: "Multi-property collaboration",
    sentBodies: [
      "I'd love to collaborate with FI Multi Hotel Alpha and FI Multi Hotel Beta during my upcoming trip.",
    ],
    toRecipient: "someone@gmail.com",
    hotelName: "FI Multi Hotel Beta",
  },
  {
    // EXTERNAL AUDIT AMENDMENT #7, Finding 2: real end-to-end regression for
    // safe coordinated-name segmentation. Before the fix, `of` was treated as
    // a generic decomposition split point, so "Bank of America" could
    // fragment into "Bank" + "America" — and if the catalog happens to
    // contain an UNRELATED business literally named "America" (as it does
    // here), that fragment would wrongly match it, creating a spurious
    // resolved canonical link and (via a FREEMAIL recipient, so domain
    // evidence can't independently qualify this thread) incorrectly flipping
    // the final status to `qualified_outreach`. With the fix, "of" is never a
    // split point at all — "Bank of America" is evaluated as ONE phrase,
    // matches nothing in this catalog, and the thread honestly stays
    // `needs_review`.
    id: "fi-7",
    gold: "needs_review",
    subject: "Collaboration opportunity",
    sentBodies: ["I'd love to collaborate with Bank of America on this campaign."],
    toRecipient: "someone@gmail.com",
    hotelName: "America",
  },
];

export interface TargetMatchExample {
  readonly id: string;
  readonly gold: "strong_match" | "needs_review" | "ambiguous" | "insufficient_evidence";
  readonly observedDomain: string;
  readonly observedName: string | null;
  readonly associatedAddresses: readonly string[];
  readonly hotels: readonly { id: string; name: string; websiteDomain: string | null }[];
  readonly organizations: readonly { id: string; name: string; websiteDomain: string | null }[];
  readonly hotelContactEmails: Readonly<Record<string, string>>;
  readonly organizationContactEmails: Readonly<Record<string, string>>;
  /** Gold expected canonical target id when `gold` is `strong_match`, else null. */
  readonly expectedTargetId: string | null;
}

export const TARGET_MATCH_CORPUS: readonly TargetMatchExample[] = [
  {
    id: "tm-1",
    gold: "strong_match",
    observedDomain: "acmehotel.example",
    observedName: "Acme Hotel",
    associatedAddresses: ["marketing@acmehotel.example"],
    hotels: [{ id: "hotel-acme", name: "Acme Hotel", websiteDomain: "acmehotel.example" }],
    organizations: [],
    hotelContactEmails: { "marketing@acmehotel.example": "hotel-acme" },
    organizationContactEmails: {},
    expectedTargetId: "hotel-acme",
  },
  {
    id: "tm-2",
    gold: "needs_review",
    observedDomain: "acmehotel.example",
    observedName: "Unrelated brand name",
    associatedAddresses: [],
    hotels: [{ id: "hotel-acme", name: "Something Unrelated", websiteDomain: "acmehotel.example" }],
    organizations: [],
    hotelContactEmails: {},
    organizationContactEmails: {},
    expectedTargetId: null,
  },
  {
    id: "tm-3",
    gold: "ambiguous",
    observedDomain: "sharedchain.example",
    observedName: null,
    associatedAddresses: [],
    hotels: [
      { id: "hotel-a", name: "Chain Hotel A", websiteDomain: "sharedchain.example" },
      { id: "hotel-b", name: "Chain Hotel B", websiteDomain: "sharedchain.example" },
    ],
    organizations: [],
    hotelContactEmails: {},
    organizationContactEmails: {},
    expectedTargetId: null,
  },
  {
    id: "tm-4",
    gold: "insufficient_evidence",
    observedDomain: "unknown-brand.example",
    observedName: "Unknown Brand",
    associatedAddresses: [],
    hotels: [],
    organizations: [],
    hotelContactEmails: {},
    organizationContactEmails: {},
    expectedTargetId: null,
  },
  {
    id: "tm-5",
    gold: "strong_match",
    observedDomain: "agencyx.example",
    observedName: "Agency X",
    associatedAddresses: ["contact@agencyx.example"],
    hotels: [],
    organizations: [{ id: "org-agencyx", name: "Agency X", websiteDomain: "agencyx.example" }],
    hotelContactEmails: {},
    organizationContactEmails: { "contact@agencyx.example": "org-agencyx" },
    expectedTargetId: "org-agencyx",
  },
  {
    id: "tm-6",
    gold: "needs_review",
    observedDomain: "onlyemailmatch.example",
    observedName: null,
    associatedAddresses: ["front-desk@onlyemailmatch.example"],
    hotels: [{ id: "hotel-only-email", name: "Totally Different Name", websiteDomain: null }],
    organizations: [],
    hotelContactEmails: { "front-desk@onlyemailmatch.example": "hotel-only-email" },
    organizationContactEmails: {},
    expectedTargetId: null,
  },
];

function recipientFixture(overrides: Partial<EvidenceRecipient>): EvidenceRecipient {
  return {
    normalizedMessageId: "msg-1",
    sourceHeaderId: "header-1",
    sourceParticipantId: overrides.sourceParticipantId ?? "participant-1",
    role: "to",
    displayName: null,
    addrSpec: "someone@example.com",
    localPart: "someone",
    domain: "example.com",
    domainLower: "example.com",
    parseStatus: "parsed",
    ...overrides,
  };
}

export interface ContactExample {
  readonly id: string;
  readonly gold: MatchQuality;
  readonly recipients: readonly EvidenceRecipient[];
  /** Lower-cased addresses with independent target+contact corroboration (EXTERNAL AUDIT AMENDMENT #2, Finding 6). Defaults to none. */
  readonly independentlyConfirmedAddresses?: readonly string[];
}

export const CONTACT_CORPUS: readonly ContactExample[] = [
  {
    id: "ct-1",
    // EXTERNAL AUDIT AMENDMENT #2, Finding 6: a named-person local part is
    // address MORPHOLOGY, not independent commercial corroboration — absent
    // real corroboration this is needs_review, never a fabricated
    // strong_match.
    gold: "needs_review",
    recipients: [
      recipientFixture({ role: "to", sourceParticipantId: "p1", localPart: "jane.doe" }),
    ],
  },
  {
    id: "ct-1b",
    // The SAME shape as ct-1, but the address is independently corroborated
    // (an exact canonical-contact match for a hotel/organization a SEPARATE
    // domain/name signal also strongly identified) — this is what actually
    // earns strong_match now.
    gold: "strong_match",
    recipients: [
      recipientFixture({
        role: "to",
        sourceParticipantId: "p1",
        localPart: "jane.doe",
        addrSpec: "jane.doe@corroborated.example",
      }),
    ],
    independentlyConfirmedAddresses: ["jane.doe@corroborated.example"],
  },
  {
    id: "ct-2",
    // Finding 6: neither a named-person `to` nor a `cc` manager is
    // independent corroboration on its own.
    gold: "needs_review",
    recipients: [
      recipientFixture({ role: "to", sourceParticipantId: "p1", localPart: "jane.doe" }),
      recipientFixture({ role: "cc", sourceParticipantId: "p2", localPart: "manager" }),
    ],
  },
  {
    id: "ct-3",
    gold: "needs_review",
    recipients: [recipientFixture({ role: "cc", sourceParticipantId: "p3", localPart: "manager" })],
  },
  {
    id: "ct-4",
    gold: "insufficient_evidence",
    recipients: [recipientFixture({ role: "bcc", sourceParticipantId: "p4", localPart: "me" })],
  },
  {
    id: "ct-5",
    gold: "ambiguous",
    recipients: [
      recipientFixture({
        role: "to",
        sourceParticipantId: "p1",
        domainLower: "hotel-a.example",
        addrSpec: "a@hotel-a.example",
      }),
      recipientFixture({
        role: "to",
        sourceParticipantId: "p2",
        domainLower: "hotel-b.example",
        addrSpec: "b@hotel-b.example",
      }),
    ],
    // Ambiguity (genuinely different businesses addressed) is a scope
    // signal, not a confidence claim — it must dominate even WITH
    // corroboration on one of the two addresses.
    independentlyConfirmedAddresses: ["a@hotel-a.example"],
  },
  {
    id: "ct-6",
    // Finding 8/6: a lone `to` recipient at a GENERIC inbox is no longer an
    // automatic strong_match — role alone is not corroborating evidence.
    gold: "needs_review",
    recipients: [
      recipientFixture({ role: "to", sourceParticipantId: "p1", localPart: "partnerships" }),
    ],
  },
  {
    id: "ct-7",
    // Finding 6: two `to` recipients at the SAME domain is no longer an
    // automatic strong_match by address count alone.
    gold: "needs_review",
    recipients: [
      recipientFixture({ role: "to", sourceParticipantId: "p1", localPart: "jane.doe" }),
      recipientFixture({ role: "to", sourceParticipantId: "p2", localPart: "john.smith" }),
    ],
  },
];
