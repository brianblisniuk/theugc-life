"use client";

import { signOut } from "@/lib/auth/actions";

/** Sign-out control. Posts to the signOut server action (clears the session). */
export function SignOutButton() {
  return (
    <form action={signOut}>
      <button
        type="submit"
        className="rounded-[var(--radius-app)] border border-border px-3 py-1.5 text-sm text-text hover:bg-surface"
      >
        Sign out
      </button>
    </form>
  );
}
