"use client";

import { useState } from "react";

import {
  setCollaborationShareable,
  setDeliverableShareable,
  type ShareWriteResult,
} from "@/lib/profile/share-actions";

export function ShareMarkButton({
  id,
  shared,
  kind,
}: {
  id: string;
  shared: boolean;
  kind: "collaboration" | "deliverable";
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit() {
    setPending(true);
    const result: ShareWriteResult =
      kind === "collaboration"
        ? await setCollaborationShareable(id, !shared)
        : await setDeliverableShareable(id, !shared);
    setPending(false);
    setMessage(result.result === "saved" ? "Updated." : "We couldn’t update that mark.");
  }

  return (
    <form action={onSubmit} className="flex flex-wrap items-center gap-2">
      <button
        type="submit"
        disabled={pending}
        className="inline-flex rounded-[var(--radius-app)] border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-background disabled:opacity-60"
      >
        {pending ? "Saving…" : shared ? "Stop sharing" : "Share on the hotel link"}
      </button>
      {message ? (
        <p className="text-xs text-muted" role="status">
          {message}
        </p>
      ) : null}
    </form>
  );
}
