"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
  archivePitchTemplateAction,
  savePitchTemplateAction,
  type PitchActionResult,
} from "@/lib/pitch/actions";

const FIELD =
  "w-full rounded-[var(--radius-app)] border border-border bg-background px-3 py-2 text-sm text-text";

function messageOf(result: PitchActionResult): string {
  if (result.result === "saved") return "Template saved. Only you can see it.";
  if (result.result === "archived") return "Template archived.";
  if (result.result === "invalid_input") return result.message;
  if (result.result === "not_found") return "That template isn’t available.";
  return "Something went wrong. Try again.";
}

export function PitchTemplateForm() {
  const router = useRouter();
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <form
      className="space-y-3"
      action={async (formData) => {
        setPending(true);
        const result = await savePitchTemplateAction(formData);
        setNote(messageOf(result));
        setPending(false);
        if (result.result === "saved") router.refresh();
      }}
    >
      <label className="block space-y-1 text-xs font-medium text-muted">
        Name
        <input name="name" required maxLength={80} className={FIELD} />
      </label>
      <label className="block space-y-1 text-xs font-medium text-muted">
        Subject
        <input name="subject" required maxLength={200} className={FIELD} />
      </label>
      <label className="block space-y-1 text-xs font-medium text-muted">
        Body
        <textarea
          name="body"
          required
          maxLength={8000}
          className={`${FIELD} min-h-40`}
          placeholder="Use {{hotel_name}}, {{creator_name}}, or {{trip_start}} where a fact should go."
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="inline-flex bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast disabled:opacity-60"
      >
        Save template
      </button>
      {note ? (
        <p className="text-sm text-text" role="status">
          {note}
        </p>
      ) : null}
    </form>
  );
}

export function ArchivePitchTemplate({ templateId }: { templateId: string }) {
  const router = useRouter();
  const [note, setNote] = useState<string | null>(null);

  return (
    <form
      action={async (formData) => {
        const result = await archivePitchTemplateAction(formData);
        setNote(messageOf(result));
        if (result.result === "archived") router.refresh();
      }}
    >
      <input type="hidden" name="templateId" value={templateId} />
      <button type="submit" className="text-sm text-muted underline">
        Archive
      </button>
      {note ? (
        <p className="text-xs text-text" role="status">
          {note}
        </p>
      ) : null}
    </form>
  );
}
