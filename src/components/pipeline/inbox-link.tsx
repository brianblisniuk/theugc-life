"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";

import {
  acceptInboxSuggestionAction,
  bindInboxThreadAction,
  dismissInboxSuggestionAction,
  unbindInboxThreadAction,
} from "@/lib/inbox-pipeline/actions";
import { REPLY_SENTIMENTS, type InboxLoad, type MailboxLoad } from "@/lib/inbox-pipeline/contract";
import {
  INBOX_COPY,
  inboxPanelModel,
  inboxWriteMessage,
  suggestionKindLabel,
} from "@/lib/inbox-pipeline/display";

const fieldClass =
  "w-full rounded-[var(--radius-app)] border border-border bg-background px-3 py-2 text-sm text-text";
const labelClass = "block text-xs font-medium text-muted";

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast disabled:opacity-60"
    >
      {pending ? "Saving…" : label}
    </button>
  );
}

export function InboxLink({
  pipelineItemId,
  hotelId,
  inbox,
  mailboxes,
}: {
  pipelineItemId: string;
  hotelId: string;
  inbox: InboxLoad;
  mailboxes: MailboxLoad;
}) {
  const [message, setMessage] = useState<string | null>(null);

  if (inbox.status === "error" || mailboxes.status === "error") {
    return (
      <div className="space-y-1 rounded-[var(--radius-app)] border border-border bg-background p-4">
        <h4 className="text-sm font-semibold text-text">{INBOX_COPY.errorTitle}</h4>
        <p className="max-w-prose text-sm text-muted">{INBOX_COPY.errorBody}</p>
      </div>
    );
  }
  if (inbox.status !== "ok") return null;

  const model = inboxPanelModel(inbox.unity);
  const binding = inbox.unity.binding;
  const reading = inbox.unity.reading;

  return (
    <div className="space-y-3 rounded-[var(--radius-app)] border border-border bg-background p-4">
      <div className="space-y-1">
        <h4 className="text-sm font-semibold text-text">{model.title}</h4>
        <p className="max-w-prose text-sm text-muted">{model.body}</p>
        <p className="text-sm text-text">
          Pipeline status: <span className="font-medium">{model.pipelineLabel}</span>
        </p>
        {reading ? (
          <p className="text-sm text-muted">
            Gmail reading: {reading.commercialState ?? "no commercial state"}
            {reading.stale ? " (stale)" : ""}
          </p>
        ) : null}
        {model.notices.map((notice) => (
          <p key={notice} className="max-w-prose text-sm text-muted">
            {notice}
          </p>
        ))}
      </div>

      {message ? <p className="text-sm text-text">{message}</p> : null}

      {binding ? (
        <form
          action={async (formData) => {
            const result = await unbindInboxThreadAction(formData);
            setMessage(inboxWriteMessage(result.result));
          }}
          className="space-y-2"
        >
          <input type="hidden" name="pipelineItemId" value={pipelineItemId} />
          <input type="hidden" name="hotelId" value={hotelId} />
          <p className="text-sm text-muted">
            Linked thread {binding.providerThreadId}
            {binding.emailAddress ? ` · ${binding.emailAddress}` : ""}
          </p>
          <SubmitButton label="Unlink thread" />
        </form>
      ) : mailboxes.mailboxes.length === 0 ? (
        <p className="text-sm text-muted">{INBOX_COPY.noMailbox}</p>
      ) : (
        <form
          action={async (formData) => {
            const result = await bindInboxThreadAction(formData);
            setMessage(inboxWriteMessage(result.result));
          }}
          className="grid gap-3 sm:grid-cols-2"
        >
          <input type="hidden" name="pipelineItemId" value={pipelineItemId} />
          <input type="hidden" name="hotelId" value={hotelId} />
          <label className={labelClass}>
            Mailbox
            <select name="mailAccountId" required className={fieldClass}>
              {mailboxes.mailboxes.map((mailbox) => (
                <option key={mailbox.id} value={mailbox.id}>
                  {mailbox.emailAddress ?? "Connected mailbox"}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            Gmail thread id
            <input name="providerThreadId" required maxLength={256} className={fieldClass} />
          </label>
          <div className="sm:col-span-2">
            <SubmitButton label="Link thread" />
          </div>
        </form>
      )}

      {inbox.unity.suggestions.map((suggestion) => (
        <div key={suggestion.id} className="space-y-2 border-t border-border pt-3">
          <p className="text-sm font-medium text-text">{suggestionKindLabel(suggestion.kind)}</p>
          <form
            action={async (formData) => {
              const result = await acceptInboxSuggestionAction(formData);
              setMessage(inboxWriteMessage(result.result));
            }}
            className="flex flex-wrap items-end gap-3"
          >
            <input type="hidden" name="pipelineItemId" value={pipelineItemId} />
            <input type="hidden" name="hotelId" value={hotelId} />
            <input type="hidden" name="suggestionId" value={suggestion.id} />
            <input type="hidden" name="kind" value={suggestion.kind} />
            {suggestion.kind === "mark_replied" ? (
              <>
                <label className={labelClass}>
                  Your reading of the reply
                  <select name="sentiment" required className={fieldClass} defaultValue="">
                    <option value="" disabled>
                      Choose
                    </option>
                    {REPLY_SENTIMENTS.map((sentiment) => (
                      <option key={sentiment} value={sentiment}>
                        {sentiment}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={labelClass}>
                  Reply date, if you want to set it
                  <input name="eventDate" type="date" className={fieldClass} />
                </label>
              </>
            ) : null}
            <SubmitButton
              label={suggestion.appliesCrm ? "Apply to pipeline" : "Acknowledge"}
            />
          </form>
          <form
            action={async (formData) => {
              const result = await dismissInboxSuggestionAction(formData);
              setMessage(inboxWriteMessage(result.result));
            }}
          >
            <input type="hidden" name="pipelineItemId" value={pipelineItemId} />
            <input type="hidden" name="hotelId" value={hotelId} />
            <input type="hidden" name="suggestionId" value={suggestion.id} />
            <button type="submit" className="text-sm text-muted underline">
              Dismiss
            </button>
          </form>
        </div>
      ))}
    </div>
  );
}
