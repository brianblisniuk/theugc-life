/**
 * "Your next step" is one primary action from the relationship the server
 * already loaded. A failed relationship read does not offer Save or Unlock.
 * A failed credit read is not zero. Generate pitch is the primary only once
 * contact access is open and the cycle is not already in conversation or won.
 */
import { OUT_OF_CREDITS_COPY, unlockContactLabel } from "@/lib/credits/config";
import { pipelineStatusLabel, type PipelineStatus } from "@/lib/pipeline/types";

import {
  COLLABORATION_BEFORE_WIN,
  CONTACT_ERROR_BODY,
  CONTACT_ERROR_TITLE,
  CREDITS_UNAVAILABLE,
  GENERATE_PITCH,
  UNLOCK_ASSURANCE,
} from "./copy";

export type RelationshipFact =
  | { status: "none" }
  | { status: "error" }
  | { status: "not_open" }
  | { status: "choose" }
  | { status: "open"; stage: PipelineStatus };

export type ContactFact = "locked" | "ready" | "empty" | "error";

export type StageTone = "neutral" | "process" | "warning" | "success";

const CONTACTED: readonly PipelineStatus[] = ["pitched", "replied", "follow_up", "negotiating"];

export interface NextStepModel {
  kind:
    | "unlock"
    | "generate_pitch"
    | "open_conversation"
    | "manage_collaboration"
    | "relationship_unknown"
    | "contact_error";
  title: string;
  primaryLabel: string;
  /** In-page or route target. Null when the primary is only a disabled control. */
  primaryHref: string | null;
  primaryDisabled: boolean;
  /** Save is offered only when we know there is no open relationship. */
  offerSave: boolean;
  offerAddToTrip: boolean;
  offerViewPipeline: boolean;
  stageLabel: string | null;
  stageTone: StageTone | null;
  creditsText: string | null;
  creditsUnknown: boolean;
  assurance: string | null;
  outOfCredits: string | null;
  note: string | null;
}

export function creditsAvailableLabel(balance: number): string {
  const unit = balance === 1 ? "credit" : "credits";
  return `${balance} ${unit} available`;
}

export function stageTone(stage: PipelineStatus): StageTone {
  if (stage === "won") return "success";
  if (stage === "follow_up") return "warning";
  if (stage === "pitched" || stage === "replied" || stage === "negotiating") return "process";
  return "neutral";
}

export function pipelineChipLabel(stageLabel: string): string {
  return `Your pipeline · ${stageLabel}`;
}

function creditFields(balance: number | null, cost: number): Pick<
  NextStepModel,
  "creditsText" | "creditsUnknown" | "outOfCredits" | "primaryDisabled"
> {
  if (balance === null || !Number.isInteger(balance)) {
    return {
      creditsText: CREDITS_UNAVAILABLE,
      creditsUnknown: true,
      outOfCredits: null,
      primaryDisabled: true,
    };
  }
  const zero = balance < cost;
  return {
    creditsText: creditsAvailableLabel(balance),
    creditsUnknown: false,
    outOfCredits: zero ? OUT_OF_CREDITS_COPY : null,
    primaryDisabled: zero,
  };
}

export function nextStep(input: {
  relationship: RelationshipFact;
  contact: ContactFact;
  balance: number | null;
  cost: number;
  pitchHref: string;
  plan: "Free" | "Pro" | "Max" | "Pass" | null;
}): NextStepModel {
  const credits = creditFields(input.balance, input.cost);
  const base = {
    offerSave: false,
    offerAddToTrip: false,
    offerViewPipeline: false,
    stageLabel: null as string | null,
    stageTone: null as StageTone | null,
    assurance: null as string | null,
    note: null as string | null,
    creditsText: credits.creditsText,
    creditsUnknown: credits.creditsUnknown,
    outOfCredits: null as string | null,
  };

  if (input.relationship.status === "choose") {
    return {
      ...base,
      kind: "relationship_unknown",
      title: "Choose an opportunity",
      primaryLabel: "See opportunities",
      primaryHref: "#work",
      primaryDisabled: false,
      offerSave: false,
      note: "More than one opportunity is open. This page did not pick one.",
    };
  }

  if (input.relationship.status === "not_open") {
    return {
      ...base,
      kind: "relationship_unknown",
      title: "That opportunity isn’t open",
      primaryLabel: "See opportunities",
      primaryHref: "#work",
      primaryDisabled: false,
      offerSave: false,
      note: "This link names an opportunity that isn’t open. Another open opportunity was not used.",
    };
  }

  if (input.relationship.status === "error") {
    return {
      ...base,
      kind: "relationship_unknown",
      title: "We couldn’t load your activity",
      primaryLabel: "Retry",
      primaryHref: null,
      primaryDisabled: false,
      note: "This is not an unsaved hotel. Reload the page to try again.",
    };
  }

  if (input.relationship.status === "open" && input.relationship.stage === "won") {
    return {
      ...base,
      kind: "manage_collaboration",
      title: "Manage collaboration",
      primaryLabel: "Manage collaboration",
      primaryHref: "#collaboration",
      primaryDisabled: false,
      stageLabel: pipelineStatusLabel("won"),
      stageTone: "success",
    };
  }

  if (input.relationship.status === "open" && CONTACTED.includes(input.relationship.stage)) {
    const stage = input.relationship.stage;
    return {
      ...base,
      kind: "open_conversation",
      title: "Open conversation",
      primaryLabel: "Open conversation",
      primaryHref: "#inbox",
      primaryDisabled: false,
      offerViewPipeline: true,
      stageLabel: pipelineStatusLabel(stage),
      stageTone: stageTone(stage),
    };
  }

  if (input.contact === "error") {
    return {
      ...base,
      kind: "contact_error",
      title: CONTACT_ERROR_TITLE,
      primaryLabel: "Retry",
      primaryHref: null,
      primaryDisabled: false,
      note: CONTACT_ERROR_BODY,
      stageLabel:
        input.relationship.status === "open"
          ? pipelineStatusLabel(input.relationship.stage)
          : null,
      stageTone:
        input.relationship.status === "open" ? stageTone(input.relationship.stage) : null,
    };
  }

  if (input.contact === "locked") {
    const knownEnough = !credits.creditsUnknown && !credits.primaryDisabled;
    return {
      ...base,
      kind: "unlock",
      title: "Unlock contact",
      primaryLabel: unlockContactLabel(input.cost),
      primaryHref: knownEnough ? "#contact" : null,
      primaryDisabled: credits.primaryDisabled,
      offerSave: input.relationship.status === "none",
      offerAddToTrip: true,
      assurance: knownEnough ? UNLOCK_ASSURANCE : null,
      outOfCredits: credits.outOfCredits,
      stageLabel:
        input.relationship.status === "open"
          ? pipelineStatusLabel(input.relationship.stage)
          : null,
      stageTone:
        input.relationship.status === "open" ? stageTone(input.relationship.stage) : null,
      note: input.plan === "Free" ? null : null,
    };
  }

  const freeNote =
    input.plan === "Free"
      ? "Free includes pitch templates. Claude drafts are on Pro and Max. The first AI draft is 1 credit. Gmail send is on Pro and Max."
      : null;

  return {
    ...base,
    kind: "generate_pitch",
    title: GENERATE_PITCH,
    primaryLabel: GENERATE_PITCH,
    primaryHref: input.pitchHref,
    primaryDisabled: false,
    offerSave: false,
    note: freeNote,
    stageLabel:
      input.relationship.status === "open" ? pipelineStatusLabel(input.relationship.stage) : null,
    stageTone: input.relationship.status === "open" ? stageTone(input.relationship.stage) : null,
  };
}

export { COLLABORATION_BEFORE_WIN };
