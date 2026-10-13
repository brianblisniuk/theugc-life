"use client";

import { useActionState } from "react";

import { dismissOnboardingChecklist } from "@/lib/onboarding/actions";

export function DismissChecklistButton() {
  const [state, action, pending] = useActionState(dismissOnboardingChecklist, null);
  return (
    <form action={action} className="mt-3">
      <button type="submit" disabled={pending} className="text-sm text-[#555] underline">
        {pending ? "Ocultando…" : "Ocultar esta lista"}
      </button>
      {state && "error" in state ? (
        <p className="text-sm text-text" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
