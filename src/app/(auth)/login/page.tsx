import type { Metadata } from "next";
import Link from "next/link";

import { LoginForm } from "@/components/auth-forms";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
}) {
  const { redirect } = await searchParams;
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-text">Sign in</h1>
        <p className="mt-1 text-sm text-muted">Welcome back.</p>
      </div>
      <LoginForm redirectTo={redirect} />
      <p className="text-sm text-muted">
        New here?{" "}
        <Link href="/signup" className="text-accent">
          Create an account
        </Link>
      </p>
    </div>
  );
}
