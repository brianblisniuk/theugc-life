import type { Metadata } from "next";
import Link from "next/link";

import { ForgotPasswordForm } from "@/components/auth-forms";

export const metadata: Metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-text">Reset your password</h1>
        <p className="mt-1 text-sm text-muted">We&apos;ll email you a secure reset link.</p>
      </div>
      <ForgotPasswordForm />
      <p className="text-sm text-muted">
        <Link href="/login" className="text-accent">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
