"use client";

import { useState } from "react";

import { requestAccountDeletion, type AccountDeletionActionResult } from "@/lib/account/actions";

const FIELD =
  "w-full rounded-[var(--radius-app)] border border-border bg-background px-3 py-2 text-sm text-text";

export interface ScheduledDeletion {
  deletionRequestedAt: string;
  deleteAfter: string;
}

function formatUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function noticeFor(result: AccountDeletionActionResult): string | null {
  switch (result.result) {
    case "scheduled":
    case "already_scheduled":
      return null;
    case "confirmation_required":
      return "Type DELETE to confirm.";
    case "not_creator":
      return "This account cannot be deleted from here.";
    case "not_found":
    case "error":
      return "We couldn’t schedule deletion. Try again.";
    default:
      return "We couldn’t schedule deletion. Try again.";
  }
}

export function DeleteAccountPanel({ schedule }: { schedule: ScheduledDeletion | null }) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [current, setCurrent] = useState<ScheduledDeletion | null>(schedule);
  const [confirming, setConfirming] = useState(false);
  const [phrase, setPhrase] = useState("");

  async function onSubmit(formData: FormData) {
    setPending(true);
    const result = await requestAccountDeletion(formData);
    setPending(false);
    setNotice(noticeFor(result));
    if (result.result === "scheduled" || result.result === "already_scheduled") {
      setCurrent({
        deletionRequestedAt: result.deletionRequestedAt,
        deleteAfter: result.deleteAfter,
      });
      setConfirming(false);
      setPhrase("");
    }
  }

  return (
    <section className="space-y-3 rounded-[var(--radius-app)] border border-border bg-surface p-5">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-text">Delete account</h2>
        <p className="text-sm text-muted">
          Your name, email, mailbox, contacts, profile, drafts, and other personal data are deleted
          within 30 days. Aggregated statistics that cannot be traced back to you may remain.
        </p>
      </div>

      {current ? (
        <p className="text-sm text-text">
          Deletion is scheduled. Personal data is removed by {formatUtc(current.deleteAfter)} (UTC).
        </p>
      ) : confirming ? (
        <form action={onSubmit} className="space-y-3">
          <label className="block space-y-1 text-sm text-text" htmlFor="delete-confirmation">
            Type DELETE to confirm
            <input
              id="delete-confirmation"
              name="confirmation"
              className={FIELD}
              value={phrase}
              autoComplete="off"
              onChange={(event) => setPhrase(event.target.value)}
            />
          </label>
          {notice ? <p className="text-sm text-danger">{notice}</p> : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={pending || phrase !== "DELETE"}
              className="rounded-[var(--radius-app)] border border-danger px-3 py-1.5 text-sm text-danger disabled:opacity-50"
            >
              {pending ? "Scheduling…" : "Delete my account"}
            </button>
            <button
              type="button"
              className="rounded-[var(--radius-app)] border border-border px-3 py-1.5 text-sm text-text"
              onClick={() => {
                setConfirming(false);
                setPhrase("");
                setNotice(null);
              }}
            >
              Back
            </button>
          </div>
        </form>
      ) : (
        <div className="space-y-2">
          {notice ? <p className="text-sm text-danger">{notice}</p> : null}
          <button
            type="button"
            className="rounded-[var(--radius-app)] border border-danger px-3 py-1.5 text-sm text-danger"
            onClick={() => setConfirming(true)}
          >
            Delete account
          </button>
        </div>
      )}
    </section>
  );
}
