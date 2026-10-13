"use client";

import { useActionState } from "react";

import { setPublicProfileEnabled } from "@/lib/profile/actions";

/**
 * D096. Turns the social profile on or off. Does not publish past
 * collaborations, portfolio assets, or the hotel share link.
 */
export function PublicProfileToggle({
  enabled,
  username,
}: {
  enabled: boolean;
  username: string;
}) {
  const [state, action, pending] = useActionState(
    async (_prev: { result: "saved" } | { result: "error" } | null, formData: FormData) =>
      setPublicProfileEnabled(formData),
    null,
  );
  const on = state?.result === "saved" ? !enabled : enabled;
  const href = username ? `/creators/${username}` : null;
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold text-text">Public profile</h2>
      <p className="max-w-prose text-sm text-muted">
        Private by default. Turning it on shares your basic details and simple counts. It does not
        share hotel names, contacts, amounts, or past collaborations.
      </p>
      <form action={action} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="enabled" value={on ? "false" : "true"} />
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast disabled:opacity-60"
        >
          {pending ? "Saving…" : on ? "Make private" : "Make public"}
        </button>
        {on && href ? (
          <a href={href} className="text-sm underline">
            {href}
          </a>
        ) : null}
      </form>
      {state?.result === "error" ? (
        <p className="text-sm" role="alert">
          We couldn’t update the public profile. Try again.
        </p>
      ) : null}
      {!username ? (
        <p className="text-sm text-muted">Add a username before the public link can be opened.</p>
      ) : null}
    </section>
  );
}
