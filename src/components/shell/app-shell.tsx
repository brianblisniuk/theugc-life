"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { SignOutButton } from "@/components/sign-out-button";
import { BreadcrumbTrail } from "@/components/shell/breadcrumbs";
import { BreadcrumbProvider, useBreadcrumbs } from "@/components/shell/breadcrumb-context";
import { NavIcon } from "@/components/shell/nav-icon";
import {
  MOBILE_NAV,
  SIDEBAR_SECTIONS,
  activePrimaryHref,
  parseHotelOrigin,
  shellCrumbs,
  shellSectionLabel,
  type ShellNavItem,
} from "@/lib/shell/navigation";

function ItemLink({ item, current }: { item: ShellNavItem; current: string | null }) {
  const active = item.href === current;
  return (
    <Link href={item.href} className="v12-nav-link" aria-current={active ? "page" : undefined}>
      <NavIcon name={item.icon} />
      <span>{item.label}</span>
    </Link>
  );
}

function ShellChrome({
  isStaff,
  creditLabel,
  planLabel,
  pathname,
  origin,
  children,
}: {
  isStaff: boolean;
  creditLabel: string;
  planLabel: string | null;
  pathname: string;
  origin: ReturnType<typeof parseHotelOrigin> | null;
  children: React.ReactNode;
}) {
  const current = activePrimaryHref(pathname, origin);
  const section = shellSectionLabel(current);
  const registered = useBreadcrumbs();
  const crumbs = registered && registered.length > 0 ? registered : shellCrumbs(pathname);
  const location = crumbs[crumbs.length - 1]?.label ?? "Workspace";
  const [menuOpen, setMenuOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const apply = () => setNarrow(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const sidebarHidden = narrow && !menuOpen;

  return (
    <div className="v12-shell">
      <a className="v12-skip" href="#main">
        Skip to content
      </a>
      <button
        type="button"
        className={menuOpen ? "v12-scrim is-open" : "v12-scrim"}
        aria-label="Close navigation"
        tabIndex={menuOpen && narrow ? 0 : -1}
        onClick={() => setMenuOpen(false)}
      />
      <aside
        className={menuOpen ? "v12-sidebar is-open" : "v12-sidebar"}
        aria-label="Main navigation"
        aria-hidden={sidebarHidden || undefined}
        inert={sidebarHidden ? true : undefined}
      >
        <Link href="/app" className="v12-brand">
          <span>theugc</span>
          <span className="v12-dot" aria-hidden="true" />
          <span>life</span>
        </Link>
        {SIDEBAR_SECTIONS.map((group) => (
          <div key={group.id}>
            <div className="v12-nav-section">{group.label}</div>
            <nav aria-label={group.label}>
              {group.items.map((item) => (
                <ItemLink key={item.href} item={item} current={current} />
              ))}
            </nav>
          </div>
        ))}
        <div className="v12-nav-spacer" />
        <div className="v12-sidebar-bottom">
          {isStaff ? (
            <nav aria-label="Staff">
              <Link
                className="v12-nav-link"
                href="/app/ui-guide"
                aria-current={
                  pathname === "/app/ui-guide" || pathname.startsWith("/app/ui-guide/")
                    ? "page"
                    : undefined
                }
              >
                <span>UI guide</span>
              </Link>
              <Link className="v12-nav-link" href="/admin">
                <span>Admin</span>
              </Link>
            </nav>
          ) : null}
          <div className="v12-profile">
            <span className="v12-avatar" aria-hidden="true">
              Y
            </span>
            <span>
              <strong>Your workspace</strong>
              <small>{planLabel ?? "Plan unavailable"}</small>
            </span>
          </div>
          <p className="v12-motto">
            Verified contacts.
            <br />
            Real creator signals.
            <br />
            Smarter outreach.
          </p>
          <SignOutButton className="v12-signout" />
        </div>
      </aside>
      <div className="v12-maincol">
        <header className="v12-topbar">
          <button
            type="button"
            className="v12-menu"
            aria-label={menuOpen ? "Close navigation" : "Open navigation"}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <NavIcon name="menu" />
          </button>
          <strong className="v12-location">{location}</strong>
          {section ? (
            <>
              <span className="v12-dotsep" aria-hidden="true">
                /
              </span>
              <span className="v12-subtle">{section}</span>
            </>
          ) : null}
          <div className="v12-topbar-right">
            {planLabel ? <span className="v12-top-pill">{planLabel}</span> : null}
            <p data-testid="credit-balance" className="v12-top-pill is-lime">
              {creditLabel}
            </p>
            <Link href="/app/profile" className="v12-top-icon" aria-label="Open your profile">
              <NavIcon name="profile" />
            </Link>
          </div>
        </header>
        <main id="main" tabIndex={-1} className="v12-content">
          <BreadcrumbTrail crumbs={crumbs} />
          {children}
        </main>
      </div>
      <nav className="v12-mobile" aria-label="Quick navigation">
        {MOBILE_NAV.map((item) => {
          const active = item.href === current;
          return (
            <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined}>
              <NavIcon name={item.icon} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

function ShellHeader(props: {
  isStaff: boolean;
  creditLabel: string;
  planLabel: string | null;
  pathname: string;
  children: React.ReactNode;
}) {
  const search = useSearchParams();
  const origin = useMemo(() => {
    if (!props.pathname.startsWith("/app/hotels/")) return null;
    const raw: Record<string, string> = {};
    search.forEach((value, key) => {
      raw[key] = value;
    });
    return parseHotelOrigin(raw);
  }, [props.pathname, search]);
  return <ShellChrome {...props} origin={origin} />;
}

function ShellFrame(props: {
  isStaff: boolean;
  creditLabel: string;
  planLabel: string | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname() || "/app";
  return (
    <Suspense fallback={<ShellChrome {...props} pathname={pathname} origin={null} />}>
      <ShellHeader {...props} pathname={pathname} />
    </Suspense>
  );
}

/**
 * V12.1 shell (D182). Light canvas, dark sidebar, lime accent on the
 * active item and the credit pill. One theme. No theme toggle.
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
    <BreadcrumbProvider>
      <ShellFrame isStaff={isStaff} creditLabel={creditLabel} planLabel={planLabel}>
        {children}
      </ShellFrame>
    </BreadcrumbProvider>
  );
}
