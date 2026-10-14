/**
 * The sentence a creator reads before a follow-up can send (D176, Proposed).
 *
 * The database decides the state. This module only turns that state into
 * the words on the page. It does not schedule or send.
 */

export const FOLLOW_UP_STOP_REASONS = [
  "hotel_replied",
  "bounced",
  "pipeline_closed",
  "cancelled",
  "recipient_rejected",
] as const;

export const FOLLOW_UP_HOLDS = [
  "plan_required",
  "account_paused",
  "sends_paused",
  "mailbox",
  "recipient_rejected",
] as const;

export type FollowUpStopReason = (typeof FOLLOW_UP_STOP_REASONS)[number];
export type FollowUpHold = (typeof FOLLOW_UP_HOLDS)[number];
export type FollowUpState =
  "needs_opt_in" | "scheduled" | "queued" | "held" | "stopped" | "complete";

export interface FollowUpNext {
  state: FollowUpState;
  sequence: 1 | 2 | null;
  followupId: string | null;
  recipient: string | null;
  subject: string | null;
  body: string | null;
  earliestSendAt: string | null;
  stopReason: FollowUpStopReason | null;
  hold: FollowUpHold | null;
}

export interface FollowUpCopy {
  heading: string;
  detail: string;
}

export interface FollowUpItem {
  id: string;
  sequence: 1 | 2;
  status: string;
  stopReason: FollowUpStopReason | null;
  subject: string;
  body: string;
  recipient: string;
  earliestSendAt: string | null;
}

function sequenceLabel(sequence: 1 | 2 | null): string {
  if (sequence === 2) return "Follow-up 2";
  if (sequence === 1) return "Follow-up 1";
  return "This follow-up";
}

/**
 * `whenLabel` is the earliest send time already formatted for the creator.
 * An empty label means the time is not available.
 */
export function describeFollowUp(next: FollowUpNext, whenLabel: string): FollowUpCopy {
  const name = sequenceLabel(next.sequence);
  const who = next.recipient ? `to ${next.recipient}` : "to the original hotel address";
  const when = whenLabel.length > 0 ? whenLabel : "the next open business morning";

  if (next.state === "stopped") {
    const why: Record<FollowUpStopReason, string> = {
      hotel_replied: "The hotel replied on this thread, so nothing else will send.",
      bounced: "A message on this thread bounced, so nothing else will send.",
      pipeline_closed: "This hotel is won or closed in your pipeline, so nothing else will send.",
      cancelled: "You cancelled it. Nothing will send until you schedule the text again.",
      recipient_rejected: "That address is no longer a contact on this hotel, so it was not sent.",
    };
    return {
      heading: `${name} will not send.`,
      detail: why[next.stopReason ?? "cancelled"],
    };
  }

  if (next.state === "held") {
    const why: Record<FollowUpHold, string> = {
      plan_required: "Sending from Gmail is included with Pro, so this is waiting.",
      account_paused: "AI and sending are paused on this account, so this is waiting.",
      sends_paused:
        "Sending is paused because too many recent messages bounced, so this is waiting.",
      mailbox: "Gmail needs to be connected with permission to send, so this is waiting.",
      recipient_rejected:
        "That address is no longer a contact on this hotel. It will not send unless the contact is valid again before then.",
    };
    return {
      heading: `${name} will not send yet.`,
      detail: `${why[next.hold ?? "mailbox"]} The text below is the text that would send ${who}.`,
    };
  }

  if (next.state === "queued") {
    return {
      heading: `${name} is in your send queue ${who}.`,
      detail: `It sends during your business hours, a few minutes after your other mail. Not before ${when}. The text below is exactly what will send.`,
    };
  }

  if (next.state === "scheduled") {
    return {
      heading: `${name} is scheduled ${who}.`,
      detail: `It will not send before ${when}. After that it joins your send queue: business hours, a few minutes apart. The text below is exactly what will send.`,
    };
  }

  if (next.state === "complete") {
    return {
      heading: "Both follow-ups were sent.",
      detail: "This thread has no further follow-up. Nothing else is scheduled.",
    };
  }

  return {
    heading: `${name} is not scheduled.`,
    detail: `If you schedule the text in the box, it goes ${who} and will not send before ${when}. Nothing sends until you schedule that text.`,
  };
}
