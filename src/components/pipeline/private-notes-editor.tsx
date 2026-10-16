"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";

import { updatePipelineNotesAction } from "@/lib/pipeline/actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex rounded-[var(--radius-app)] bg-accent px-3 py-1.5 text-sm font-semibold text-accent-contrast disabled:opacity-60"
    >
      {pending ? "Saving…" : "Save notes"}
    </button>
  );
}

export function PrivateNotesEditor({
  pipelineItemId,
  initialNotes,
}: {
  pipelineItemId: string;
  initialNotes: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const loaded = initialNotes ?? "";

  async function onSubmit(formData: FormData) {
    const notes = formData.get("notes");
    const text = typeof notes === "string" ? notes : "";
    if (loaded.trim().length > 0 && text.trim().length === 0) formData.set("clearNotes", "1");
    else formData.delete("clearNotes");
    const outcome = await updatePipelineNotesAction(formData);
    if (outcome.result === "updated") {
      setStatus("Saved");
      setOpen(false);
      return;
    }
    if (outcome.result === "preserved") {
      setStatus("Notes were not changed");
      return;
    }
    setStatus("Could not save");
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-muted underline hover:text-text"
      >
        {initialNotes ? "Edit notes" : "Add notes"}
      </button>
    );
  }

  return (
    <form action={onSubmit} className="mt-2 space-y-2">
      <input type="hidden" name="pipelineItemId" value={pipelineItemId} />
      <textarea
        name="notes"
        defaultValue={loaded}
        rows={3}
        className="w-full rounded-[var(--radius-app)] border border-border bg-background px-3 py-2 text-sm text-text"
        placeholder="Private notes (only you can see these)"
      />
      <div className="flex items-center gap-3">
        <SubmitButton />
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-muted underline"
        >
          Cancel
        </button>
        {status ? <span className="text-xs text-muted">{status}</span> : null}
      </div>
    </form>
  );
}
