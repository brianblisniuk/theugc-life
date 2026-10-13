"use client";

import { useRef, useState, type FormEvent } from "react";

import { setPublicProfileEnabled } from "@/lib/profile/actions";
import { publicProfileIsOn, type PublicProfileToggleState } from "@/lib/profile/public-toggle";

/**
 * D096. Turns the social profile on or off. Does not publish past
 * collaborations, portfolio assets, or the hotel share link.
 *
 * The label is the stored flag: the action result until the server prop
 * matches it. `useActionState` is not used. Its pending flag follows the
 * router transition, and that transition can stay open after the write has
 * already been stored, which leaves the control on "Saving…".
 */
export function PublicProfileToggle({ enabled, username }: { enabled: boolean; username: string }) {
  const [actionState, setActionState] = useState<PublicProfileToggleState>(null);
  const request = useRef(0);
  const on = publicProfileIsOn(enabled, actionState);
  const href = username ? `/creators/${username}` : null;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const next = formData.get("enabled") === "true";
    const id = ++request.current;
    setActionState({ result: "saved", enabled: next });
    void setPublicProfileEnabled(null, formData).then((result) => {
      if (id !== request.current) return;
      setActionState(
        result.result === "saved"
          ? { result: "saved", enabled: result.enabled }
          : { result: "error" },
      );
    });
  }

  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold text-text">Public profile</h2>
      <p className="max-w-prose text-sm text-muted">
        Private by default. Turning it on shares your basic details and simple counts. It does not
        share hotel names, contacts, amounts, or past collaborations.
      </p>
      <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="enabled" value={on ? "false" : "true"} />
        <button
          type="submit"
          className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
        >
          {on ? "Make private" : "Make public"}
        </button>
        {on && href ? (
          <a href={href} className="text-sm underline">
            {href}
          </a>
        ) : null}
      </form>
      {actionState?.result === "error" ? (
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
