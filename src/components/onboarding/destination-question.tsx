"use client";

import { useMemo, useRef, useState } from "react";
import { useActionState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  chooseOnboardingDestination,
  rememberOnboardingDestination,
} from "@/lib/onboarding/actions";
import {
  createDestinationSaveQueue,
  filterDestinations,
  shouldPersistDestinationBeforeLeave,
  suggestedChips,
  type DestinationChoice,
} from "@/lib/onboarding/destination";

export function DestinationQuestion({ destinations }: { destinations: DestinationChoice[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [state, action, pending] = useActionState(chooseOnboardingDestination, null);
  const chips = useMemo(() => suggestedChips(destinations), [destinations]);
  const matches = useMemo(() => filterDestinations(destinations, query), [destinations, query]);
  const choices = query.trim() ? matches : chips.length > 0 ? chips : matches;
  const queue = useRef<ReturnType<typeof createDestinationSaveQueue> | null>(null);
  if (queue.current === null) {
    queue.current = createDestinationSaveQueue((id) => rememberOnboardingDestination(id));
  }
  const saves = queue.current;

  function persist(id: string) {
    return saves.enqueue(id);
  }

  function selectDestination(id: string) {
    setSelected(id);
    setSaveError(null);
    void persist(id).then((result) => {
      if ("error" in result) setSaveError(result.error);
    });
  }

  function leave(href: string, event: { preventDefault: () => void }) {
    if (!shouldPersistDestinationBeforeLeave(selected)) return;
    event.preventDefault();
    void persist(selected).then((result) => {
      if ("error" in result) {
        setSaveError(result.error);
        return;
      }
      router.push(href);
    });
  }

  return (
    <form action={action} className="s6-stack">
      <p className="s6-muted">
        Which destination are you aiming at now? We only use it to show relevant hotels. You can
        change it later.
      </p>
      <label className="v12-field" htmlFor="destination-search">
        <span>Search destination</span>
        <input
          id="destination-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Bali, Mexico, Japan"
        />
      </label>
      <div className="s6-actions">
        {choices.map((destination) => (
          <label
            key={destination.id}
            className="v12-chip"
            aria-pressed={selected === destination.id}
          >
            <input
              type="radio"
              name="destinationId"
              value={destination.id}
              checked={selected === destination.id}
              onChange={() => selectDestination(destination.id)}
            />
            {destination.name}
          </label>
        ))}
      </div>
      {choices.length === 0 ? (
        <p className="text-sm text-muted">No destination in our catalog matches that name.</p>
      ) : null}
      {state && "error" in state ? (
        <p className="text-sm" role="alert">
          {state.error}
        </p>
      ) : null}
      {saveError ? (
        <p className="text-sm" role="alert">
          {saveError}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-4">
        <button type="submit" disabled={pending} className="v12-btn v12-btn-primary">
          {pending ? "Saving…" : "View hotels"}
        </button>
        <Link
          href="/app/onboarding/hotels"
          className="v12-btn"
          onClick={(event) => leave("/app/onboarding/hotels", event)}
        >
          Hotels for this destination
        </Link>
        <Link
          href="/app"
          className="text-sm text-muted underline"
          onClick={(event) => leave("/app", event)}
        >
          Back to home
        </Link>
      </div>
    </form>
  );
}
