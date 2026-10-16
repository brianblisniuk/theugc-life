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
      <header className="v12-pagehead">
        <div>
          <h1>Sign in</h1>
          <p>Welcome back.</p>
        </div>
      </header>
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
