import Link from "next/link";

import { AppNav } from "@/components/app-nav";
import { Brand } from "@/components/brand";
import { SignOutButton } from "@/components/sign-out-button";
import { requireUser } from "@/lib/auth/guards";

/**
 * Authenticated app shell. Route-group middleware already gates authentication;
 * requireUser here is the server-side source of truth and provides the session
 * context to child surfaces.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireUser("/app");
  const isStaff = session.role === "admin" || session.role === "editor";

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-6">
            <Brand href="/app" />
            <AppNav />
          </div>
          <div className="flex items-center gap-3 text-sm">
            <Link href="/app/account" className="text-muted hover:text-text">
              Account
            </Link>
            <Link href="/app/billing" className="text-muted hover:text-text">
              Billing
            </Link>
            {isStaff ? (
              <Link href="/admin" className="text-muted hover:text-text">
                Admin
              </Link>
            ) : null}
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
