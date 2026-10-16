"use client";

/**
 * Editable pitch draft (D110).
 *
 * Copy puts the text on the clipboard. The mail link opens the creator's own
 * client. Send is a separate explicit action. None of them mark the hotel
 * as pitched.
 */
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { draftPitchWithAssistantAction } from "@/lib/ai/actions";
import { AI_ACCOUNT_PAUSED_COPY, AI_UNAVAILABLE_COPY } from "@/lib/ai/copy";
import { PITCH_LANGUAGES, PITCH_TONES } from "@/lib/ai/structured";
import { CREDITS_CONFIG } from "@/lib/credits/config";
import { SUPPORT_EMAIL } from "@/lib/support";
import { sendPitchFromGmailAction } from "@/lib/gmail/send/actions";
import {
  recordPitchDeliveryAction,
  savePitchDraftAction,
  type PitchActionResult,
} from "@/lib/pitch/actions";
import { buildMailto, copyText, type SystemTemplateKey } from "@/lib/pitch/contract";
import { recipientLine, tripChangeForOpportunity } from "@/lib/pitch/studio";

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
  contactLocked = false,
  contactUnchecked = false,
  templateRequested = false,
  replaceRequested = false,
  suggestionHref,
  assistant,
  budgetWarning = false,
  accountPaused = false,
  sendsPaused = false,
  canSend = false,
  mailAccountId = null,
  hasSendScope = false,
  pipelineItemId = null,
  oauthReturnPath,
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
  contactLocked?: boolean;
  contactUnchecked?: boolean;
  /** A template chip. Saving may replace the draft with that template. */
  templateRequested?: boolean;
  /** Start again from the suggestion. A trip change does not set this. */
  replaceRequested?: boolean;
  suggestionHref: string;
  assistant:
    | { status: "on"; priority: boolean; mail: readonly { id: string; subject: string }[] }
    | { status: "off"; reason: "free" | "unknown" };
  budgetWarning?: boolean;
  accountPaused?: boolean;
  sendsPaused?: boolean;
  canSend?: boolean;
  mailAccountId?: string | null;
  hasSendScope?: boolean;
  pipelineItemId?: string | null;
  oauthReturnPath: string;
}) {
  const router = useRouter();
  const [subjectValue, setSubjectValue] = useState(subject);
  const [bodyValue, setBodyValue] = useState(body);
  const [savedId, setSavedId] = useState(draftId);
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [selectedMail, setSelectedMail] = useState<string[]>([]);
  const [tone, setTone] = useState<(typeof PITCH_TONES)[number]>("professional");
  const [language, setLanguage] = useState<(typeof PITCH_LANGUAGES)[number]>("English");
  const [points, setPoints] = useState<string[]>([""]);
  const idempotencyKey = useRef<string | null>(null);
  const inflight = useRef(false);
  const locked = useRef(false);

  function mintKey(): string {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function formData(): FormData {
    const data = new FormData();
    data.set("hotelId", hotelId);
    data.set("draftId", savedId ?? "");
    data.set("tripId", tripId ?? "");
    data.set("templateId", templateId ?? "");
    data.set("systemKey", systemKey ?? "");
    data.set("subject", subjectValue);
    data.set("body", bodyValue);
    if (pipelineItemId) data.set("opportunityId", pipelineItemId);
    if (templateRequested || replaceRequested) data.set("templateIntent", "1");
    if (subjectValue !== subject || bodyValue !== body) data.set("edited", "1");
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
    const id = await save();
    setPending(false);
    if (id) router.refresh();
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

  async function onSend() {
    if (!canSend || !mailAccountId || !hasSendScope || !recipientEmail) return;
    if (inflight.current || locked.current) return;
    inflight.current = true;
    setPending(true);
    if (!idempotencyKey.current) idempotencyKey.current = mintKey();
    const data = new FormData();
    data.set("hotelId", hotelId);
    data.set("mailAccountId", mailAccountId);
    data.set("idempotencyKey", idempotencyKey.current);
    data.set("kind", "pitch");
    data.set("recipient", recipientEmail);
    data.set("subject", subjectValue);
    data.set("body", bodyValue);
    data.set("tripId", tripId ?? "");
    data.set("draftId", savedId ?? "");
    if (pipelineItemId) data.set("pipelineItemId", pipelineItemId);
    const result = await sendPitchFromGmailAction(data);
    if (result.result === "sent" || result.result === "unknown") locked.current = true;
    else if (result.retry) idempotencyKey.current = mintKey();
    setNote(result.message);
    inflight.current = false;
    setPending(false);
  }

  const returnTo = encodeURIComponent(oauthReturnPath);
  const connectHref = `/api/integrations/gmail/oauth/start?return_to=${returnTo}`;
  const allowSendHref = mailAccountId
    ? `/api/integrations/gmail/oauth/start?purpose=grant_send&mail_account_id=${mailAccountId}&return_to=${returnTo}`
    : connectHref;

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
    if (pipelineItemId) data.set("pipelineItemId", pipelineItemId);
    data.set("tone", tone);
    data.set("language", language);
    for (const point of points) data.append("keyPoint", point);
    for (const id of selectedMail) data.append("messageId", id);
    const result = await draftPitchWithAssistantAction(data);
    if (result.result === "drafted") {
      setSubjectValue(result.subject);
      setBodyValue(result.body);
      if (result.draftId) setSavedId(result.draftId);
      setNote(
        result.warning === "budget_80"
          ? "AI draft saved. You've used 80% of this month's AI budget. It was not sent."
          : "AI draft saved. It was not sent, and the hotel is not marked as pitched.",
      );
      router.refresh();
    } else if (result.result === "templates_only") {
      setNote("AI drafts are included with Pro. This page still fills your template.");
    } else if (result.result === "out_of_credits") {
      setNote("You're out of credits, so this draft wasn't created.");
    } else if (result.result === "monthly_limit") {
      setNote("You've used this month's AI budget. Your template is still here.");
    } else if (result.result === "pool_exhausted") {
      setNote(
        "AI drafts are paused until next month. This month's shared AI budget is used up. Your template is still here.",
      );
    } else if (result.result === "rate_limited") {
      setNote("Wait a moment before another AI draft.");
    } else if (result.result === "paused") {
      setNote(AI_ACCOUNT_PAUSED_COPY);
    } else if (result.result === "unavailable") {
      setNote(AI_UNAVAILABLE_COPY);
    } else if (result.result === "off_topic") {
      setNote("That draft wasn't about a collaboration with this hotel, so it wasn't saved.");
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
      {accountPaused ? (
        <p className="max-w-prose text-sm text-text" role="status">
          {AI_ACCOUNT_PAUSED_COPY}
        </p>
      ) : null}
      {sendsPaused && !accountPaused ? (
        <p className="max-w-prose text-sm text-text" role="status">
          Sending is paused because too many recent messages bounced. Email {SUPPORT_EMAIL} and
          we&apos;ll review it.
        </p>
      ) : null}
      {budgetWarning && !accountPaused ? (
        <p className="max-w-prose text-sm text-text" role="status">
          You&apos;ve used 80% of this month&apos;s AI budget.
        </p>
      ) : null}
      {assistant.status === "on" && !accountPaused ? (
        <div className="space-y-3 rounded-[var(--radius-app)] border border-border p-3">
          <p className="max-w-prose text-sm text-text">
            Draft with AI from your profile, this hotel, and your pipeline.
            {assistant.priority ? " Priority AI uses a fuller note." : ""} Choose a tone, a
            language, and the points to include. The first draft for a hotel uses {creditLabel}. The
            next three drafts for that hotel this month do not. Later drafts use {creditLabel}. This
            does not send the email.
          </p>
          <label className="block space-y-1 text-xs font-medium text-muted">
            Tone
            <select
              className={FIELD}
              value={tone}
              onChange={(event) => setTone(event.target.value as (typeof PITCH_TONES)[number])}
            >
              {PITCH_TONES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-xs font-medium text-muted">
            Language
            <select
              className={FIELD}
              value={language}
              onChange={(event) =>
                setLanguage(event.target.value as (typeof PITCH_LANGUAGES)[number])
              }
            >
              {PITCH_LANGUAGES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-muted">Key points</legend>
            {points.map((point, index) => (
              <input
                key={index}
                className={FIELD}
                maxLength={160}
                value={point}
                placeholder="One point the hotel should hear"
                onChange={(event) => {
                  const next = [...points];
                  next[index] = event.target.value;
                  setPoints(next);
                }}
              />
            ))}
            {points.length < 5 ? (
              <button
                type="button"
                className="text-sm text-text underline"
                onClick={() => setPoints((current) => [...current, ""])}
              >
                Add a point
              </button>
            ) : null}
          </fieldset>
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
            className="v12-btn"
          >
            Draft with AI
          </button>
        </div>
      ) : assistant.status === "off" ? (
        <p className="max-w-prose text-sm text-muted">
          {assistant.reason === "free"
            ? "AI drafts are included with Pro. You can still fill a template, copy it, or open it in your mail app."
            : "We couldn't check your plan, so an AI draft isn't offered on this load. Your template is still here."}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <label className="block min-w-48 flex-1 space-y-1 text-xs font-medium text-muted">
          Trip
          <select
            className={FIELD}
            value={tripId ?? ""}
            disabled={Boolean(pipelineItemId)}
            onChange={(event) => {
              const change = tripChangeForOpportunity({
                opportunitySelected: Boolean(pipelineItemId),
                nextTripId: event.target.value || null,
              });
              if (change.kind === "disabled") return;
              const params = new URLSearchParams(window.location.search);
              if (change.tripId) params.set("trip", change.tripId);
              else params.delete("trip");
              params.delete("fresh");
              params.delete("replace");
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
        {pipelineItemId ? (
          <p className="max-w-prose text-sm text-muted">
            This trip belongs to this opportunity. Choose another opportunity to pitch a different
            trip.
          </p>
        ) : null}
      </div>

      <div className="v12-field">
        <span>To / contact</span>
        <p>
          {recipientLine({
            email: recipientEmail,
            locked: contactLocked,
            unchecked: contactUnchecked,
          })}
        </p>
      </div>
      <label className="v12-field">
        <span>Subject</span>
        <input
          value={subjectValue}
          maxLength={200}
          onChange={(event) => setSubjectValue(event.target.value)}
        />
      </label>
      <label className="v12-field">
        <span>Message</span>
        <textarea
          className="min-h-64"
          value={bodyValue}
          maxLength={8000}
          onChange={(event) => setBodyValue(event.target.value)}
        />
      </label>

      <div className="v12-head-actions">
        <button
          type="button"
          disabled={pending}
          onClick={() => void onSave()}
          className="v12-btn v12-btn-dark"
        >
          Save draft
        </button>
        <button type="button" disabled={pending} onClick={() => void onCopy()} className="v12-btn">
          Copy email
        </button>
        <a
          href={mailto}
          className="v12-btn"
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
        {canSend && mailAccountId && hasSendScope && recipientEmail ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => void onSend()}
            className="v12-btn v12-btn-primary"
          >
            Send
          </button>
        ) : null}
        {canSend && !mailAccountId ? (
          <a href={connectHref} className="v12-btn">
            Connect Gmail to send
          </a>
        ) : null}
        {canSend && mailAccountId && !hasSendScope ? (
          <a href={allowSendHref} className="v12-btn">
            Allow sending
          </a>
        ) : null}
      </div>
      <p className="max-w-prose text-sm text-muted">
        Copy and the mail draft stay on your device. Neither sends the message, and neither marks{" "}
        {hotelName} as pitched. Send is a separate action from your connected Gmail, and it does not
        mark {hotelName} as pitched either.{" "}
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
