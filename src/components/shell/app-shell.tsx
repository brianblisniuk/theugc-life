"use client";

import { Suspense, useMemo } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { Brand } from "@/components/brand";
import { SignOutButton } from "@/components/sign-out-button";
import {
  PRIMARY_NAV,
  UTILITY_NAV,
  activePrimaryHref,
  activeUtilityHref,
  parseHotelOrigin,
} from "@/lib/shell/navigation";

function linkClass(active: boolean, mobile: boolean): string {
  const size = mobile
    ? "flex min-h-11 items-center rounded-[var(--radius-app)] px-3 text-sm"
    : "rounded-[var(--radius-app)] px-3 py-1.5 text-sm";
  return size + (active ? " bg-surface font-semibold text-text" : " text-muted hover:text-text");
}

function ShellChrome({
  isStaff,
  pathname,
  origin,
  navKey,
}: {
  isStaff: boolean;
  pathname: string;
  origin: ReturnType<typeof parseHotelOrigin> | null;
  navKey: string;
}) {
  const primary = activePrimaryHref(pathname, origin);
  const utility = activeUtilityHref(pathname);

  const primaryLinks = (mobile: boolean) =>
    PRIMARY_NAV.map((item) => {
      const active = item.href === primary;
      return (
        <Link
          key={item.href}
          href={item.href}
          aria-current={active ? "page" : undefined}
          className={linkClass(active, mobile)}
        >
          {item.label}
        </Link>
      );
    });

  const utilityLinks = (mobile: boolean) => (
    <>
      {UTILITY_NAV.map((item) => {
        const active = item.href === utility;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={linkClass(active, mobile)}
          >
            {item.label}
          </Link>
        );
      })}
      {isStaff ? (
        <Link href="/admin" className={linkClass(false, mobile)}>
          Admin
        </Link>
      ) : null}
      <SignOutButton />
    </>
  );

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-6">
          <Brand href="/app" />
          <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
            {primaryLinks(false)}
          </nav>
        </div>
        <div className="hidden items-center gap-3 text-sm md:flex">{utilityLinks(false)}</div>
        <details key={navKey} className="relative md:hidden">
          <summary className="flex min-h-11 cursor-pointer list-none items-center rounded-[var(--radius-app)] px-3 text-sm font-medium text-text [&::-webkit-details-marker]:hidden">
            Menu
          </summary>
          <div className="absolute right-0 z-40 mt-2 w-[min(100vw-2rem,18rem)] rounded-[var(--radius-app)] border border-border bg-background p-2">
            <nav aria-label="Primary" className="flex flex-col">
              {primaryLinks(true)}
            </nav>
            <div className="mt-2 flex flex-col gap-1 border-t border-border pt-2">
              {utilityLinks(true)}
            </div>
          </div>
        </details>
      </div>
    </header>
  );
}

function ShellHeader({ isStaff, pathname }: { isStaff: boolean; pathname: string }) {
  const search = useSearchParams();
  const origin = useMemo(() => {
    if (!pathname.startsWith("/app/hotels/") && pathname !== "/app/hotels") return null;
    const raw: Record<string, string> = {};
    search.forEach((value, key) => {
      raw[key] = value;
    });
    return parseHotelOrigin(raw);
  }, [pathname, search]);
  const navKey = `${pathname}?${search.toString()}`;
  return <ShellChrome isStaff={isStaff} pathname={pathname} origin={origin} navKey={navKey} />;
}

function ShellFrame({ isStaff }: { isStaff: boolean }) {
  const pathname = usePathname() || "/app";
  return (
    <Suspense
      fallback={
        <ShellChrome isStaff={isStaff} pathname={pathname} origin={null} navKey={pathname} />
      }
    >
      <ShellHeader isStaff={isStaff} pathname={pathname} />
    </Suspense>
  );
}

/**
 * One authenticated shell. Desktop keeps the bar in one row. Below the `md`
 * breakpoint the same links sit in a Menu disclosure with 44px targets.
 * The disclosure remounts closed when the route changes.
 */
export function AppShell({ isStaff, children }: { isStaff: boolean; children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <ShellFrame isStaff={isStaff} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
