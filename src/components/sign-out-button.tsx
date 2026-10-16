"use client";

import { signOut } from "@/lib/auth/actions";

/** Sign-out control. Posts to the signOut server action (clears the session). */
export function SignOutButton() {
  return (
    <form action={signOut}>
      <button type="submit" className="v12-btn">
        Sign out
      </button>
    </form>
  );
}
