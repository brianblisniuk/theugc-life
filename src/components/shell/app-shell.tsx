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

function primaryClass(active: boolean): string {
  return (
    "border-b-[3px] px-3.5 py-2 text-sm font-semibold " +
    (active ? "border-accent text-text" : "border-transparent text-[#555]")
  );
}

function mobileClass(active: boolean): string {
  return (
    "flex min-h-11 flex-1 flex-col items-center justify-center px-1 text-[12px] font-semibold " +
    (active ? "text-text" : "text-[#555]")
  );
}

function CreditCounter({ label }: { label: string }) {
  return (
    <p data-testid="credit-balance" className="text-sm font-semibold text-text">
      {label}
    </p>
  );
}

function ShellChrome({
  isStaff,
  initials,
  creditLabel,
  pathname,
  origin,
  navKey,
}: {
  isStaff: boolean;
  initials: string;
  creditLabel: string;
  pathname: string;
  origin: ReturnType<typeof parseHotelOrigin> | null;
  navKey: string;
}) {
  const primary = activePrimaryHref(pathname, origin);
  const utility = activeUtilityHref(pathname);

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-[#e6e6e6] bg-white">
        <div className="flex h-14 items-center gap-3 px-4 md:h-16 md:gap-10 md:px-10">
          <Brand href="/app" />
          <nav aria-label="Primary" className="hidden flex-1 items-center gap-1.5 md:flex">
            {PRIMARY_NAV.map((item) => {
              const active = item.href === primary;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={primaryClass(active)}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <CreditCounter label={creditLabel} />
            <div className="hidden items-center gap-3 md:flex">
              {UTILITY_NAV.map((item) => {
                const active = item.href === utility;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={active ? "text-sm font-semibold text-text" : "text-sm text-[#555]"}
                  >
                    {item.label}
                  </Link>
                );
              })}
              {isStaff ? (
                <Link href="/admin" className="text-sm text-[#555]">
                  Admin
                </Link>
              ) : null}
              <SignOutButton />
              <span className="grid h-[34px] w-[34px] place-items-center rounded-full bg-[#111] text-[13px] font-bold text-accent">
                {initials}
              </span>
            </div>
          </div>
          <details key={navKey} className="relative md:hidden">
            <summary className="grid h-11 w-11 cursor-pointer list-none place-items-center rounded-full bg-[#111] text-[13px] font-bold text-accent [&::-webkit-details-marker]:hidden">
              {initials}
            </summary>
            <div className="absolute right-0 z-40 mt-2 w-56 rounded-md border border-[#e6e6e6] bg-white p-2">
              {UTILITY_NAV.map((item) => (
                <Link key={item.href} href={item.href} className="block px-3 py-2 text-sm">
                  {item.label}
                </Link>
              ))}
              {isStaff ? (
                <Link href="/admin" className="block px-3 py-2 text-sm">
                  Admin
                </Link>
              ) : null}
              <SignOutButton />
            </div>
          </details>
        </div>
      </header>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-30 flex border-t border-[#e6e6e6] bg-white md:hidden"
      >
        {PRIMARY_NAV.map((item) => {
          const active = item.href === primary;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={mobileClass(active)}
            >
              <span className={active ? "border-b-[3px] border-accent" : ""}>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}

function ShellHeader({
  isStaff,
  initials,
  creditLabel,
  pathname,
}: {
  isStaff: boolean;
  initials: string;
  creditLabel: string;
  pathname: string;
}) {
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
  return (
    <ShellChrome
      isStaff={isStaff}
      initials={initials}
      creditLabel={creditLabel}
      pathname={pathname}
      origin={origin}
      navKey={navKey}
    />
  );
}

function ShellFrame({
  isStaff,
  initials,
  creditLabel,
}: {
  isStaff: boolean;
  initials: string;
  creditLabel: string;
}) {
  const pathname = usePathname() || "/app";
  return (
    <Suspense
      fallback={
        <ShellChrome
          isStaff={isStaff}
          initials={initials}
          creditLabel={creditLabel}
          pathname={pathname}
          origin={null}
          navKey={pathname}
        />
      }
    >
      <ShellHeader
        isStaff={isStaff}
        initials={initials}
        creditLabel={creditLabel}
        pathname={pathname}
      />
    </Suspense>
  );
}

/**
 * Direction A shell. Desktop keeps one row. Narrow screens pin the five
 * primary items to the bottom. Sun is the active underline, not a status color.
 */
export function AppShell({
  isStaff,
  initials,
  creditLabel,
  children,
}: {
  isStaff: boolean;
  initials: string;
  creditLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-white text-[#111]">
      <ShellFrame isStaff={isStaff} initials={initials} creditLabel={creditLabel} />
      <main className="w-full flex-1 px-4 py-6 pb-24 md:px-10 md:py-7 md:pb-8">{children}</main>
    </div>
  );
}
