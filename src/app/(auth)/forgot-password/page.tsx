import type { Metadata } from "next";
import Link from "next/link";

import { ForgotPasswordForm } from "@/components/auth-forms";

export const metadata: Metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  return (
    <div className="space-y-5">
      <header className="v12-pagehead">
        <div>
          <h1>Reset your password</h1>
          <p>We&apos;ll email you a secure reset link.</p>
        </div>
      </header>
      <ForgotPasswordForm />
      <p className="text-sm text-muted">
        <Link href="/login" className="text-accent">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
