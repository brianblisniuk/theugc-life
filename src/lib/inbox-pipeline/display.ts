/**
 * Copy for the inbox link on the hotel activity panel.
 *
 * The title is the creator's pipeline status. A Gmail reading is a notice,
 * never the heading.
 */
import { pipelineStatusLabel } from "@/lib/pipeline/types";

import type { InboxSuggestionKind, InboxUnity, InboxWriteResult } from "./contract";

export const INBOX_COPY = {
  sectionTitle: "Inbox link",
  unlinkedBody:
    "Link a stored Gmail thread when you want this pipeline cycle and that conversation to stay side by side. Linking does not change the pipeline status.",
  authoritativeBody:
    "The pipeline status above is your record. A Gmail reading stays a suggestion until you accept it.",
  pendingBody:
    "Gmail has a suggestion. Your pipeline status does not change until you accept one that records a reply or opens negotiation.",
  redirectNotice: "A redirect is not a rejection, and it does not close this pipeline cycle.",
  agreementNotice:
    "Gmail observed language that looks like an agreement. That has not been recorded as a won deal.",
  declineNotice:
    "Gmail observed a rejection. Acknowledging it does not close this pipeline cycle.",
  staleNotice: "This Gmail reading is stale, so it was not applied.",
  errorTitle: "The inbox link couldn’t be loaded",
  errorBody: "Your pipeline status is unchanged. Reload the page to try the inbox link again.",
  noMailbox: "Connect Gmail on your account page before linking a thread.",
} as const;

const KIND_LABEL: Record<InboxSuggestionKind, string> = {
  mark_replied: "Record the reply",
  open_negotiation: "Open negotiation",
  review_agreement: "Acknowledge the agreement reading",
  review_decline: "Acknowledge the rejection reading",
};

export function suggestionKindLabel(kind: InboxSuggestionKind): string {
  return KIND_LABEL[kind];
}

export interface InboxPanelModel {
  title: string;
  body: string;
  notices: string[];
  pipelineLabel: string;
}

export function inboxPanelModel(unity: InboxUnity): InboxPanelModel {
  const pipelineLabel = pipelineStatusLabel(unity.pipelineStatus);
  const notices: string[] = [];
  if (unity.reading?.stale) notices.push(INBOX_COPY.staleNotice);
  if (unity.reading?.hasRedirect) notices.push(INBOX_COPY.redirectNotice);
  if (
    unity.reading?.commercialState === "agreement_observed" &&
    unity.pipelineStatus !== "won" &&
    unity.pipelineStatus !== "closed"
  ) {
    notices.push(INBOX_COPY.agreementNotice);
  }
  if (unity.reading?.declineSupported && unity.pipelineStatus !== "closed") {
    notices.push(INBOX_COPY.declineNotice);
  }

  if (unity.unity === "unlinked") {
    return {
      title: INBOX_COPY.sectionTitle,
      body: INBOX_COPY.unlinkedBody,
      notices,
      pipelineLabel,
    };
  }
  if (unity.unity === "suggestion_pending") {
    return {
      title: INBOX_COPY.sectionTitle,
      body: INBOX_COPY.pendingBody,
      notices,
      pipelineLabel,
    };
  }
  return {
    title: INBOX_COPY.sectionTitle,
    body: INBOX_COPY.authoritativeBody,
    notices,
    pipelineLabel,
  };
}

export function inboxWriteMessage(result: InboxWriteResult["result"]): string {
  switch (result) {
    case "refreshed":
    case "no_reading":
    case "stale":
    case "applied":
    case "already_applied":
    case "acknowledged":
    case "dismissed":
    case "unbound":
      return "Saved";
    case "already_bound":
      return "That thread is already linked to this pipeline cycle.";
    case "item_already_bound":
      return "Unlink the current thread before linking a different one.";
    case "thread_already_bound":
      return "That thread is already linked to another pipeline cycle.";
    case "thread_not_stored":
      return "That thread is not in the stored mail for this mailbox.";
    case "mailbox_not_connected":
      return "That mailbox is not connected.";
    case "not_bound":
      return "This pipeline cycle has no inbox link.";
    case "invalid_transition":
      return "The pipeline is not at a step that can take that suggestion. Nothing was changed.";
    case "needs_event_time":
      return "Add the date of the reply. Nothing was changed.";
    case "stale_reading":
    case "reading_moved":
      return "That Gmail reading is no longer current. Nothing was changed.";
    case "not_pending":
      return "That suggestion is no longer waiting. Nothing was changed.";
    case "invalid_input":
      return "Check the values and try again.";
    case "not_found":
      return "That pipeline cycle is not available.";
    default:
      return "Could not save";
  }
}
