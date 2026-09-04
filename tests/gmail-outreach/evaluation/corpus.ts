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
}

export const CONTACT_CORPUS: readonly ContactExample[] = [
  {
    id: "ct-1",
    gold: "strong_match",
    recipients: [
      recipientFixture({ role: "to", sourceParticipantId: "p1", localPart: "jane.doe" }),
    ],
  },
  {
    id: "ct-2",
    gold: "strong_match",
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
      recipientFixture({ role: "to", sourceParticipantId: "p1", domainLower: "hotel-a.example" }),
      recipientFixture({ role: "to", sourceParticipantId: "p2", domainLower: "hotel-b.example" }),
    ],
  },
  {
    id: "ct-6",
    // Finding 8: a lone `to` recipient at a GENERIC inbox is no longer an
    // automatic strong_match — role alone is not corroborating evidence.
    gold: "needs_review",
    recipients: [
      recipientFixture({ role: "to", sourceParticipantId: "p1", localPart: "partnerships" }),
    ],
  },
];
