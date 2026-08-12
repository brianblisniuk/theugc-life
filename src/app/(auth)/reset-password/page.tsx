import type { Metadata } from "next";

import { ResetPasswordForm } from "@/components/auth-forms";

export const metadata: Metadata = { title: "Set new password" };

/**
 * Reached via the recovery link (which establishes a recovery session through
 * /auth/callback). updatePassword verifies there is an authenticated user
 * server-side before changing the password.
 */
export default function ResetPasswordPage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-text">Set a new password</h1>
        <p className="mt-1 text-sm text-muted">
          Choose a strong password you don&apos;t use elsewhere.
        </p>
      </div>
      <ResetPasswordForm />
    </div>
  );
}
