import Link from "next/link";

import { Brand } from "@/components/brand";
import { SignOutButton } from "@/components/sign-out-button";
import { requireRole } from "@/lib/auth/guards";

/**
 * Admin shell. Authorization is enforced SERVER-SIDE here (PRD §25.4,
 * PERMISSIONS.md §11): non admin/editor users are redirected even if they type
 * the URL directly. Middleware only guarantees authentication; this layout is
 * the authoritative role gate.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireRole(["admin", "editor"], "/admin");

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <Brand href="/admin" />
            <span className="rounded-[var(--radius-app)] bg-background px-2 py-0.5 text-xs font-medium capitalize text-muted">
              {session.role}
            </span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <Link href="/app" className="text-muted hover:text-text">
              Back to app
            </Link>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
