import type { Metadata } from "next";
import Link from "next/link";

import { SignupForm } from "@/components/auth-forms";

export const metadata: Metadata = { title: "Create account" };

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
}) {
  const { redirect } = await searchParams;
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-text">Create your account</h1>
        <p className="mt-1 text-sm text-muted">Start free in under a minute.</p>
      </div>
      <SignupForm redirectTo={redirect} />
      <p className="text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="text-accent">
          Sign in
        </Link>
      </p>
    </div>
  );
}
