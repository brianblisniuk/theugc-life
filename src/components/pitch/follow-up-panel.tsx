"use client";

/**
 * What the next follow-up will do (D176, Proposed).
 *
 * Scheduling stores the text in the boxes. Drafting fills the boxes and
 * does not schedule. Nothing here calls Gmail.
 */

import { useState } from "react";

import { draftFollowUpWithAssistantAction } from "@/lib/ai/actions";
import { PITCH_LANGUAGES, PITCH_TONES } from "@/lib/ai/structured";
import { cancelFollowUpAction, scheduleFollowUpAction } from "@/lib/gmail/followup/actions";
import {
  describeFollowUp,
  type FollowUpItem,
  type FollowUpNext,
} from "@/lib/gmail/followup/next-action";
import { SUPPORT_EMAIL } from "@/lib/support";

const FIELD =
  "w-full rounded-[var(--radius-app)] border border-border bg-background px-3 py-2 text-sm text-text";

function whenLabel(iso: string | null, timeZone: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timeZone || "UTC",
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(date);
  }
}

function prefillSubject(original: string): string {
  const subject = original.trim();
  if (!subject) return "Following up";
  if (/^re:/i.test(subject)) return subject;
  return `Re: ${subject}`.slice(0, 200);
}

export function FollowUpPanel({
  hotelId,
  hotelName,
  eventId,
  originalSubject,
  recipient,
  next,
  history,
  timeZone,
  assistantOn,
  canSchedule,
}: {
  hotelId: string;
  hotelName: string;
  eventId: string;
  originalSubject: string;
  recipient: string;
  next: FollowUpNext;
  history: readonly FollowUpItem[];
  timeZone: string;
  assistantOn: boolean;
  canSchedule: boolean;
}) {
  const copy = describeFollowUp(next, whenLabel(next.earliestSendAt, timeZone));
  const visible = history.find((item) => item.id === next.followupId) ?? null;
  const shownSubject = next.subject ?? visible?.subject ?? null;
  const shownBody = next.body ?? visible?.body ?? null;
  const [subject, setSubject] = useState(prefillSubject(originalSubject));
  const [body, setBody] = useState("");
  const [tone, setTone] = useState<(typeof PITCH_TONES)[number]>("professional");
  const [language, setLanguage] = useState<(typeof PITCH_LANGUAGES)[number]>("English");
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const open = next.state === "needs_opt_in" && canSchedule;

  async function onDraft() {
    setPending(true);
    const data = new FormData();
    data.set("hotelId", hotelId);
    data.set("tone", tone);
    data.set("language", language);
    data.set("keyPoint", `Follow up on the pitch already sent to ${hotelName}`);
    const result = await draftFollowUpWithAssistantAction(data);
    if (result.result === "drafted") {
      setSubject(result.subject);
      setBody(result.body);
      setNote(
        "Draft only. It is not scheduled and it was not sent. Read it, then schedule it if you want it to go.",
      );
    } else if (result.result === "templates_only") {
      setNote("AI drafts are included with Pro. You can still write the follow-up yourself.");
    } else if (result.result === "off_topic") {
      setNote(
        "That draft wasn't a follow-up about a collaboration with this hotel, so it wasn't used.",
      );
    } else if (result.result === "paused") {
      setNote(`AI is paused on this account. Email ${SUPPORT_EMAIL} and we'll review it.`);
    } else if (result.result === "monthly_limit" || result.result === "pool_exhausted") {
      setNote("This month's AI budget is used up. You can still write the follow-up yourself.");
    } else if (result.result === "out_of_credits") {
      setNote("You're out of credits, so this draft wasn't created.");
    } else {
      setNote("The draft couldn't be created. Nothing was scheduled.");
    }
    setPending(false);
  }

  async function onSchedule() {
    setPending(true);
    const data = new FormData();
    data.set("hotelId", hotelId);
    data.set("eventId", eventId);
    data.set("subject", subject);
    data.set("body", body);
    const result = await scheduleFollowUpAction(data);
    setNote(result.message);
    setPending(false);
  }

  async function onCancel() {
    if (!next.followupId) return;
    setPending(true);
    const data = new FormData();
    data.set("hotelId", hotelId);
    data.set("followupId", next.followupId);
    const result = await cancelFollowUpAction(data);
    setNote(result.message);
    setPending(false);
  }

  return (
    <section className="space-y-3 rounded-[var(--radius-app)] border border-border p-4">
      <h2 className="text-base text-text">Next follow-up</h2>
      <p className="text-sm text-text">{copy.heading}</p>
      <p className="text-sm text-muted">{copy.detail}</p>
      <p className="text-sm text-muted">
        To {recipient}. This does not change the hotel’s pipeline stage.
      </p>
      {shownSubject && shownBody ? (
        <div className="space-y-1 text-sm text-text">
          <p className="font-medium">{shownSubject}</p>
          <p className="whitespace-pre-wrap">{shownBody}</p>
        </div>
      ) : null}
      {open ? (
        <div className="space-y-3">
          {assistantOn ? (
            <div className="flex flex-wrap gap-2">
              <label className="text-sm text-muted">
                Tone
                <select
                  className={FIELD}
                  value={tone}
                  onChange={(event) => setTone(event.target.value as (typeof PITCH_TONES)[number])}
                >
                  {PITCH_TONES.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm text-muted">
                Language
                <select
                  className={FIELD}
                  value={language}
                  onChange={(event) =>
                    setLanguage(event.target.value as (typeof PITCH_LANGUAGES)[number])
                  }
                >
                  {PITCH_LANGUAGES.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="self-end rounded-[var(--radius-app)] border border-border px-3 py-2 text-sm text-text"
                disabled={pending}
                onClick={() => void onDraft()}
              >
                Draft follow-up
              </button>
            </div>
          ) : null}
          <label className="block text-sm text-muted">
            Subject
            <input
              className={FIELD}
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            />
          </label>
          <label className="block text-sm text-muted">
            Message you have read
            <textarea
              className={`${FIELD} min-h-32`}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="rounded-[var(--radius-app)] border border-border px-3 py-2 text-sm text-text"
            disabled={pending || body.trim().length === 0 || subject.trim().length === 0}
            onClick={() => void onSchedule()}
          >
            Schedule this text
          </button>
        </div>
      ) : null}
      {next.followupId &&
      (next.state === "scheduled" || next.state === "queued" || next.state === "held") ? (
        <button
          type="button"
          className="rounded-[var(--radius-app)] border border-border px-3 py-2 text-sm text-text"
          disabled={pending}
          onClick={() => void onCancel()}
        >
          Cancel follow-up
        </button>
      ) : null}
      {note ? <p className="text-sm text-muted">{note}</p> : null}
    </section>
  );
}
