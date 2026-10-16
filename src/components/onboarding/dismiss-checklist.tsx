"use client";

import { useActionState } from "react";

import { dismissOnboardingChecklist } from "@/lib/onboarding/actions";

export function DismissChecklistButton() {
  const [state, action, pending] = useActionState(dismissOnboardingChecklist, null);
  return (
    <form action={action} className="mt-3">
      <button type="submit" disabled={pending} className="text-sm text-muted underline">
        {pending ? "Hiding…" : "Hide this list"}
      </button>
      {state && "error" in state ? (
        <p className="text-sm text-text" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
