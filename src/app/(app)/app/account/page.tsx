import type { Metadata } from "next";
import Link from "next/link";

import { requireUser } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage() {
  const session = await requireUser("/app/account");
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-text">Account</h1>
      <dl className="grid gap-4 rounded-[var(--radius-app)] border border-border bg-surface p-5 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted">Email</dt>
          <dd className="text-text">{session.email ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted">Role</dt>
          <dd className="text-text capitalize">{session.role}</dd>
        </div>
      </dl>
      <p className="text-sm text-muted">
        Need to change your password?{" "}
        <Link href="/forgot-password" className="text-accent">
          Reset it
        </Link>
        .
      </p>
    </div>
  );
}
