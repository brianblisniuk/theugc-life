"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { SignOutButton } from "@/components/sign-out-button";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import {
  PRIMARY_NAV,
  UTILITY_NAV,
  activePrimaryHref,
  activeUtilityHref,
  parseHotelOrigin,
} from "@/lib/shell/navigation";

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const ICONS = [
  "M2 7.5 8 2l6 5.5V14H10V9H6v5H2z",
  "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2",
  "M2 4h12M2 8h12M2 12h8",
  "M2 12h12M4 12V7l4-3 4 3v5",
  "M8 6a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 13c1.2-2 2.8-3 5-3s3.8 1 5 3",
] as const;

function ShellChrome({
  isStaff,
  creditLabel,
  planLabel,
  pathname,
  origin,
  navKey,
}: {
  isStaff: boolean;
  creditLabel: string;
  planLabel: string | null;
  pathname: string;
  origin: ReturnType<typeof parseHotelOrigin> | null;
  navKey: string;
}) {
  const primary = activePrimaryHref(pathname, origin);
  const utility = activeUtilityHref(pathname);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <>
      <a className="ux-btn ux-skip" href="#main">
        Skip to content
      </a>
      <header className="ux-header">
        <Link href="/app" className="ux-wordmark">
          theugc<span>.life</span>
        </Link>
        <nav className="ux-nav" aria-label="Primary">
          {PRIMARY_NAV.map((item) => {
            const active = item.href === primary;
            return (
              <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined}>
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="ux-tools">
          {planLabel ? <span className="ux-plan">{planLabel}</span> : null}
          <p data-testid="credit-balance" className="ux-credit">
            {creditLabel}
          </p>
          <ThemeToggle />
          <div className="ux-desktop-tools">
            {UTILITY_NAV.map((item) => {
              const active = item.href === utility;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className="ux-credit"
                >
                  {item.label}
                </Link>
              );
            })}
            {isStaff ? (
              <Link href="/admin" className="ux-credit">
                Admin
              </Link>
            ) : null}
            <SignOutButton />
          </div>
          <button
            type="button"
            className="ux-btn ux-view-toggle"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            Account
          </button>
        </div>
      </header>
      {menuOpen ? (
        <div key={navKey} className="ux-lock" style={{ margin: "8px 16px" }}>
          {UTILITY_NAV.map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
          {isStaff ? <Link href="/admin">Admin</Link> : null}
          <SignOutButton />
        </div>
      ) : null}
      <nav className="ux-bottom" aria-label="Primary mobile">
        {PRIMARY_NAV.map((item, index) => {
          const active = item.href === primary;
          return (
            <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined}>
              <Icon d={ICONS[index] ?? ICONS[0]} />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </>
  );
}

function ShellHeader(props: {
  isStaff: boolean;
  creditLabel: string;
  planLabel: string | null;
  pathname: string;
}) {
  const search = useSearchParams();
  const origin = useMemo(() => {
    if (!props.pathname.startsWith("/app/hotels/") && props.pathname !== "/app/hotels") return null;
    const raw: Record<string, string> = {};
    search.forEach((value, key) => {
      raw[key] = value;
    });
    return parseHotelOrigin(raw);
  }, [props.pathname, search]);
  const navKey = `${props.pathname}?${search.toString()}`;
  return <ShellChrome {...props} origin={origin} navKey={navKey} />;
}

function ShellFrame({
  isStaff,
  creditLabel,
  planLabel,
}: {
  isStaff: boolean;
  creditLabel: string;
  planLabel: string | null;
}) {
  const pathname = usePathname() || "/app";
  return (
    <Suspense
      fallback={
        <ShellChrome
          isStaff={isStaff}
          creditLabel={creditLabel}
          planLabel={planLabel}
          pathname={pathname}
          origin={null}
          navKey={pathname}
        />
      }
    >
      <ShellHeader
        isStaff={isStaff}
        creditLabel={creditLabel}
        planLabel={planLabel}
        pathname={pathname}
      />
    </Suspense>
  );
}

/**
 * UX02 shell. Desktop keeps one row. Narrow screens pin the five primary
 * items, each with an icon and a label. The underline is ink, not the accent.
 */
export function AppShell({
  isStaff,
  creditLabel,
  planLabel,
  children,
}: {
  isStaff: boolean;
  creditLabel: string;
  planLabel: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col" style={{ background: "var(--bg)", color: "var(--text)" }}>
      <ShellFrame isStaff={isStaff} creditLabel={creditLabel} planLabel={planLabel} />
      <main id="main" tabIndex={-1} className="ux-main flex-1">
        {children}
      </main>
    </div>
  );
}
