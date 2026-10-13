"use client";

import { useMemo, useState } from "react";
import { useActionState } from "react";
import Link from "next/link";

import { chooseOnboardingDestination } from "@/lib/onboarding/actions";
import {
  filterDestinations,
  suggestedChips,
  type DestinationChoice,
} from "@/lib/onboarding/destination";

export function DestinationQuestion({ destinations }: { destinations: DestinationChoice[] }) {
  const [query, setQuery] = useState("");
  const [state, action, pending] = useActionState(chooseOnboardingDestination, null);
  const chips = useMemo(() => suggestedChips(destinations), [destinations]);
  const matches = useMemo(() => filterDestinations(destinations, query), [destinations, query]);
  const choices = query.trim() ? matches : chips.length > 0 ? chips : matches;

  return (
    <form action={action} className="space-y-5">
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight">
          ¿A qué destino estás apuntando ahora?
        </h1>
        <p className="mt-2 text-sm text-[#555]">
          Solo lo usamos para mostrarte hoteles relevantes. Podés cambiarlo después.
        </p>
      </div>
      <label className="block text-sm font-semibold" htmlFor="destination-search">
        Buscar destino
        <input
          id="destination-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="mt-1 w-full rounded-md border border-[#ccc] px-3 py-2 text-sm"
          placeholder="Bali, México, Japón…"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        {choices.map((destination) => (
          <label
            key={destination.id}
            className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-[#ccc] px-3 py-1.5 text-sm font-semibold has-[:checked]:border-[#111] has-[:checked]:bg-[#111] has-[:checked]:text-accent"
          >
            <input type="radio" name="destinationId" value={destination.id} className="sr-only" />
            {destination.name}
          </label>
        ))}
      </div>
      {choices.length === 0 ? (
        <p className="text-sm text-[#555]">No hay un destino con ese nombre en nuestra base.</p>
      ) : null}
      {state && "error" in state ? (
        <p className="text-sm" role="alert">
          {state.error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast disabled:opacity-60"
        >
          {pending ? "Guardando…" : "Ver hoteles"}
        </button>
        <Link href="/app" className="text-sm text-[#555] underline">
          Ir al inicio
        </Link>
      </div>
    </form>
  );
}
