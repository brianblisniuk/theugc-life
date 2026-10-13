import type { CollaborationSuggestionKind } from "./contract";

export const COLLABORATION_COPY = {
  paused:
    "Gmail detection stays paused on Free. An active Pro plan or Destination Pass resumes it. Nothing here was recorded.",
  pitch:
    "Gmail saw a pitch you sent. Confirming records it as your own pitch. A pitch you already recorded stays as it is.",
  reply:
    "Gmail saw a reply from a person. An automatic reply is not offered. Your reading of the reply is the one that is recorded.",
  collaboration:
    "Gmail saw a pitch and a human reply that look like an agreement. Confirming this does not create a collaboration and does not publish a hotel fact.",
  error: "Gmail suggestions could not be loaded. Your pipeline record is unchanged.",
} as const;

const KIND_LABEL: Record<CollaborationSuggestionKind, string> = {
  pitch_sent: "Record the pitch Gmail saw",
  human_reply: "Record the human reply Gmail saw",
  collaboration: "This looks like a collaboration",
};

export function collaborationKindLabel(kind: CollaborationSuggestionKind): string {
  return KIND_LABEL[kind];
}

export function collaborationKindBody(kind: CollaborationSuggestionKind): string {
  if (kind === "pitch_sent") return COLLABORATION_COPY.pitch;
  if (kind === "human_reply") return COLLABORATION_COPY.reply;
  return COLLABORATION_COPY.collaboration;
}

export function collaborationWriteMessage(result: string, kind: string | null): string {
  if (result === "paused") return COLLABORATION_COPY.paused;
  if (result === "applied" || result === "confirmed") {
    if (kind === "collaboration") {
      return "Saved. This did not create a collaboration.";
    }
    return "Saved on your record.";
  }
  if (result === "manual_overrides" || result === "already_applied") {
    return "Your existing record was kept. Nothing new was written.";
  }
  if (result === "dismissed") return "Dismissed. Nothing was recorded.";
  if (result === "invalid_transition" || result === "engaged_limit_reached") {
    return "The pipeline cannot take that step right now. Nothing was changed.";
  }
  if (result === "invalid_input") return "Choose how you read the reply. Nothing was changed.";
  if (result === "not_pending") return "That suggestion is no longer waiting. Nothing was changed.";
  return "That suggestion could not be saved. Nothing was changed.";
}
