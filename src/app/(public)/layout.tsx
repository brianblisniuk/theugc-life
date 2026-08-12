import Link from "next/link";

import { Brand } from "@/components/brand";

/** Public marketing shell (unauthenticated). Minimal, non-final. */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Brand />
          <nav aria-label="Public" className="flex items-center gap-3 text-sm">
            <Link href="/pricing" className="text-muted hover:text-text">
              Pricing
            </Link>
            <Link href="/login" className="text-muted hover:text-text">
              Sign in
            </Link>
            <Link
              href="/signup"
              className="rounded-[var(--radius-app)] bg-accent px-3 py-1.5 font-semibold text-accent-contrast"
            >
              Start free
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10">{children}</main>
      <footer className="border-t border-border">
        <div className="mx-auto max-w-5xl px-4 py-6 text-sm text-muted">
          © theugc.life — the operating system for travel UGC creators.
        </div>
      </footer>
    </div>
  );
}
