"use client";

/**
 * Editable pitch draft (D110).
 *
 * Copy puts the text on the clipboard. The mail link opens the creator's own
 * client. Neither button sends mail, and neither marks the hotel as pitched.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";

import { draftPitchWithAssistantAction } from "@/lib/ai/actions";
import { CREDITS_CONFIG } from "@/lib/credits/config";
import {
  recordPitchDeliveryAction,
  savePitchDraftAction,
  type PitchActionResult,
} from "@/lib/pitch/actions";
import { buildMailto, copyText, type SystemTemplateKey } from "@/lib/pitch/contract";

const FIELD =
  "w-full rounded-[var(--radius-app)] border border-border bg-background px-3 py-2 text-sm text-text";

function messageOf(result: PitchActionResult): string {
  if (result.result === "saved") return "Draft saved. It is not marked as pitched.";
  if (result.result === "recorded") return "Saved on this draft. The message was not sent.";
  if (result.result === "invalid_input") return result.message;
  if (result.result === "not_found") return "That draft isn’t available.";
  return "Something went wrong. Try again.";
}

export function PitchComposer({
  hotelId,
  hotelName,
  draftId,
  tripId,
  trips,
  templateId,
  systemKey,
  subject,
  body,
  recipientEmail,
  suggestionHref,
  assistant,
}: {
  hotelId: string;
  hotelName: string;
  draftId: string | null;
  tripId: string | null;
  trips: readonly { id: string; label: string }[];
  templateId: string | null;
  systemKey: SystemTemplateKey | null;
  subject: string;
  body: string;
  recipientEmail: string | null;
  suggestionHref: string;
  assistant:
    | { status: "on"; priority: boolean; mail: readonly { id: string; subject: string }[] }
    | { status: "off"; reason: "free" | "unknown" };
}) {
  const router = useRouter();
  const [subjectValue, setSubjectValue] = useState(subject);
  const [bodyValue, setBodyValue] = useState(body);
  const [savedId, setSavedId] = useState(draftId);
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [selectedMail, setSelectedMail] = useState<string[]>([]);

  function formData(): FormData {
    const data = new FormData();
    data.set("hotelId", hotelId);
    data.set("draftId", savedId ?? "");
    data.set("tripId", tripId ?? "");
    data.set("templateId", templateId ?? "");
    data.set("systemKey", systemKey ?? "");
    data.set("subject", subjectValue);
    data.set("body", bodyValue);
    return data;
  }

  async function save(): Promise<string | null> {
    const result = await savePitchDraftAction(formData());
    if (result.result === "saved" && result.draftId) {
      setSavedId(result.draftId);
      setNote(messageOf(result));
      return result.draftId;
    }
    setNote(messageOf(result));
    return null;
  }

  async function onSave() {
    setPending(true);
    await save();
    setPending(false);
    router.refresh();
  }

  async function onCopy() {
    setPending(true);
    try {
      await navigator.clipboard.writeText(copyText(subjectValue, bodyValue));
    } catch {
      setNote("Couldn’t copy. Select the text and copy it yourself.");
      setPending(false);
      return;
    }
    const id = savedId ?? (await save());
    if (!id) {
      setNote("Copied. The draft could not be saved.");
      setPending(false);
      return;
    }
    const data = new FormData();
    data.set("draftId", id);
    data.set("delivery", "copied");
    const recorded = await recordPitchDeliveryAction(data);
    setNote(
      recorded.result === "recorded"
        ? "Copied. The message was not sent, and the hotel is not marked as pitched."
        : "Copied. The message was not sent.",
    );
    setPending(false);
  }

  const mailto = buildMailto({
    email: recipientEmail,
    subject: subjectValue,
    body: bodyValue,
  });

  async function onAssist() {
    setPending(true);
    const data = new FormData();
    data.set("hotelId", hotelId);
    data.set("tripId", tripId ?? "");
    for (const id of selectedMail) data.append("messageId", id);
    const result = await draftPitchWithAssistantAction(data);
    if (result.result === "drafted") {
      setSubjectValue(result.subject);
      setBodyValue(result.body);
      if (result.draftId) setSavedId(result.draftId);
      setNote("AI draft saved. It was not sent, and the hotel is not marked as pitched.");
      router.refresh();
    } else if (result.result === "templates_only") {
      setNote("AI drafts are included with Pro. This page still fills your template.");
    } else if (result.result === "out_of_credits") {
      setNote("You're out of credits, so this draft wasn't created.");
    } else if (result.result === "daily_limit") {
      setNote("You've reached today's AI draft limit.");
    } else if (result.result === "rate_limited") {
      setNote("Wait a moment before another AI draft.");
    } else if (result.result === "paused") {
      setNote("AI drafts are paused right now. Your template is still here.");
    } else if (result.result === "invalid_input") {
      setNote(result.message);
    } else {
      setNote("The draft couldn't be created. You were not charged.");
    }
    setPending(false);
  }

  const creditLabel =
    CREDITS_CONFIG.aiDraftCost === 1 ? "1 credit" : `${CREDITS_CONFIG.aiDraftCost} credits`;

  return (
    <div className="space-y-4">
      {assistant.status === "on" ? (
        <div className="space-y-3 rounded-[var(--radius-app)] border border-border p-3">
          <p className="max-w-prose text-sm text-text">
            Draft with AI from your profile, this hotel, and your pipeline.
            {assistant.priority ? " Priority AI uses a fuller note." : ""} This uses {creditLabel}{" "}
            and does not send the email.
          </p>
          {assistant.mail.length > 0 ? (
            <fieldset className="space-y-1">
              <legend className="text-xs font-medium text-muted">
                Include a message you choose. Unchecked mail stays out of the draft.
              </legend>
              {assistant.mail.map((message) => (
                <label key={message.id} className="flex items-start gap-2 text-sm text-text">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selectedMail.includes(message.id)}
                    onChange={(event) => {
                      setSelectedMail((current) =>
                        event.target.checked
                          ? [...current, message.id].slice(0, 3)
                          : current.filter((id) => id !== message.id),
                      );
                    }}
                  />
                  <span>{message.subject}</span>
                </label>
              ))}
            </fieldset>
          ) : null}
          <button
            type="button"
            disabled={pending}
            onClick={() => void onAssist()}
            className="inline-flex bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast disabled:opacity-60"
          >
            Draft with AI
          </button>
        </div>
      ) : (
        <p className="max-w-prose text-sm text-muted">
          {assistant.reason === "free"
            ? "AI drafts are included with Pro. You can still fill a template, copy it, or open it in your mail app."
            : "We couldn't check your plan, so an AI draft isn't offered on this load. Your template is still here."}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <label className="block min-w-48 flex-1 space-y-1 text-xs font-medium text-muted">
          Trip
          <select
            className={FIELD}
            value={tripId ?? ""}
            onChange={(event) => {
              const params = new URLSearchParams(window.location.search);
              if (event.target.value) params.set("trip", event.target.value);
              else params.delete("trip");
              params.set("fresh", "1");
              router.push(`/app/hotels/${hotelId}/pitch?${params.toString()}`);
            }}
          >
            <option value="">No trip</option>
            {trips.map((trip) => (
              <option key={trip.id} value={trip.id}>
                {trip.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block space-y-1 text-xs font-medium text-muted">
        Subject
        <input
          className={FIELD}
          value={subjectValue}
          maxLength={200}
          onChange={(event) => setSubjectValue(event.target.value)}
        />
      </label>
      <label className="block space-y-1 text-xs font-medium text-muted">
        Message
        <textarea
          className={`${FIELD} min-h-64`}
          value={bodyValue}
          maxLength={8000}
          onChange={(event) => setBodyValue(event.target.value)}
        />
      </label>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => void onSave()}
          className="inline-flex bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast disabled:opacity-60"
        >
          Save draft
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => void onCopy()}
          className="inline-flex border border-border px-4 py-2 text-sm font-medium text-text disabled:opacity-60"
        >
          Copy
        </button>
        <a
          href={mailto}
          className="inline-flex border border-border px-4 py-2 text-sm font-medium text-text"
          onClick={(event) => {
            event.preventDefault();
            void (async () => {
              const id = savedId ?? (await save());
              if (id) {
                const data = new FormData();
                data.set("draftId", id);
                data.set("delivery", "mailto_opened");
                await recordPitchDeliveryAction(data);
                setNote("Mail draft opened. The message was not sent.");
              }
              window.location.assign(mailto);
            })();
          }}
        >
          {recipientEmail ? `Open mail draft to ${hotelName}` : "Open mail draft"}
        </a>
      </div>
      <p className="max-w-prose text-sm text-muted">
        Copy and the mail draft stay on your device. Neither sends the message, and neither marks{" "}
        {hotelName} as pitched.{" "}
        <a className="underline" href={suggestionHref}>
          Start again from the suggestion
        </a>
        .
      </p>
      {note ? (
        <p className="text-sm text-text" role="status">
          {note}
        </p>
      ) : null}
    </div>
  );
}
