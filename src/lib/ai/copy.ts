import { SUPPORT_EMAIL } from "@/lib/support";

/** Shown only when `ai_account_pauses` has an open row for this account (D165). */
export const AI_ACCOUNT_PAUSED_COPY = `AI and sending are paused on this account. Email ${SUPPORT_EMAIL} and we'll review it.`;

export const AI_FOLLOW_UP_PAUSED_COPY = `AI is paused on this account. Email ${SUPPORT_EMAIL} and we'll review it.`;

/** Missing provider key or budget floor. Not an account pause. */
export const AI_UNAVAILABLE_COPY =
  "AI drafts are temporarily unavailable. Your template is still here.";

export const AI_FOLLOW_UP_UNAVAILABLE_COPY =
  "AI drafts are temporarily unavailable. You can still write the follow-up yourself.";
