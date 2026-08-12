import type { Metadata } from "next";

import { OnboardingForm } from "@/components/auth-forms";
import { requireUser } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Welcome" };

/**
 * Lightweight onboarding (ROUTES.md §3): capture the minimum to make the app
 * useful. Requires an authenticated user; the profile row already exists (from
 * the signup trigger) and is updated under the owner's RLS.
 */
export default async function OnboardingPage() {
  await requireUser("/onboarding");
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-text">Welcome</h1>
        <p className="mt-1 text-sm text-muted">Set up your creator profile to get started.</p>
      </div>
      <OnboardingForm />
    </div>
  );
}
