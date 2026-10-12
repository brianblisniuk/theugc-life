"use client";

import { useState } from "react";

import { saveShareOptIns, type ShareWriteResult } from "@/lib/profile/share-actions";
import {
  SHARE_FIELD_KEYS,
  SHARE_FIELD_LABELS,
  type ShareFieldKey,
} from "@/lib/profile/share-contract";

function saveMessage(result: ShareWriteResult): string | null {
  if (result.result === "saved") return "Saved. A field you turned off is gone from the link.";
  if (result.result === "invalid_input") return result.message;
  return "We couldn’t save those choices. Try again.";
}

export function ShareOptIns({ optIns }: { optIns: Record<ShareFieldKey, boolean> }) {
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(formData: FormData) {
    const result = await saveShareOptIns(formData);
    setMessage(saveMessage(result));
  }

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-text">What a hotel can see</h2>
        <p className="max-w-prose text-sm text-muted">
          Every field is off until you turn it on. Past collaborations and content examples also
          need their own share mark. Turning a field off removes it from the link immediately.
        </p>
      </div>
      <form action={onSubmit} className="space-y-3">
        <ul className="space-y-2">
          {SHARE_FIELD_KEYS.map((key) => (
            <li key={key}>
              <label className="flex items-start gap-2 text-sm text-text">
                <input
                  type="checkbox"
                  name={`opt_${key}`}
                  defaultChecked={optIns[key]}
                  className="mt-1"
                />
                <span>
                  {SHARE_FIELD_LABELS[key]}
                  {key === "audience" ? (
                    <span className="mt-0.5 block text-xs text-muted">
                      Followers and engagement are labeled self-reported. They are not verified.
                    </span>
                  ) : null}
                  {key === "compensation" ? (
                    <span className="mt-0.5 block text-xs text-muted">
                      Shown only on collaborations you mark, and only as the type or amount you
                      recorded. Unknown stays unknown.
                    </span>
                  ) : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
        <button
          type="submit"
          className="inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
        >
          Save sharing choices
        </button>
        {message ? (
          <p className="text-sm text-text" role="status">
            {message}
          </p>
        ) : null}
      </form>
    </section>
  );
}
