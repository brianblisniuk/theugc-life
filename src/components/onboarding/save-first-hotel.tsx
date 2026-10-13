"use client";

import { useActionState } from "react";

import { saveOnboardingHotelAction } from "@/lib/pipeline/actions";
import { saveControlState } from "@/lib/pipeline/view";
import type { SaveResult } from "@/lib/pipeline/types";

export function SaveFirstHotelButton({ hotelId }: { hotelId: string }) {
  const [state, action, pending] = useActionState(
    async (_prev: SaveResult | null, formData: FormData) => saveOnboardingHotelAction(formData),
    null,
  );
  const view = state ? saveControlState(state) : null;
  return (
    <form action={action}>
      <input type="hidden" name="hotelId" value={hotelId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast disabled:opacity-60"
      >
        {pending ? "Guardando…" : "Guardar en mi pipeline"}
      </button>
      {view && (view.kind === "limit" || view.kind === "problem") ? (
        <p className="mt-2 text-sm" role="alert">
          {view.message}
        </p>
      ) : null}
    </form>
  );
}
