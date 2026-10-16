"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { SignOutButton } from "@/components/sign-out-button";
import {
  MOBILE_NAV,
  SIDEBAR_NAV,
  activeSidebarHref,
  parseHotelOrigin,
  shellCrumbs,
  shellHeading,
  workspaceInitials,
  type HotelOrigin,
  type ShellIcon,
} from "@/lib/shell/navigation";

function Icon({ name }: { name: ShellIcon }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (name === "home") {
    return (
      <svg {...common}>
        <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4z" />
      </svg>
    );
  }
  if (name === "discover") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="m16 8-2.5 5.5L8 16l2.5-5.5z" />
      </svg>
    );
  }
  if (name === "trips") {
    return (
      <svg {...common}>
        <path d="M3 7h18v12H3z" />
        <path d="M3 11h18M8 7V5h8v2" />
      </svg>
    );
  }
  if (name === "outreach") {
    return (
      <svg {...common}>
        <path d="m22 2-7 20-4-9-9-4zM22 2 11 13" />
      </svg>
    );
  }
  if (name === "pipeline") {
    return (
      <svg {...common}>
        <path d="M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v4H4zM14 15h6v4h-6z" />
      </svg>
    );
  }
  if (name === "inbox") {
    return (
      <svg {...common}>
        <path d="M4 6h16v12H4z" />
        <path d="m4 8 8 6 8-6" />
      </svg>
    );
  }
  if (name === "collaborations") {
    return (
      <svg {...common}>
        <path d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM16 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" />
        <path d="M3 19c.8-2.4 2.6-3.5 5-3.5s4.2 1.1 5 3.5M14 15.6c1.6-.2 3 .4 4.2 1.9" />
      </svg>
    );
  }
  if (name === "profile") {
    return (
      <svg {...common}>
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 19c1.2-2.6 3.2-4 7-4s5.8 1.4 7 4" />
      </svg>
    );
  }
  if (name === "billing") {
    return (
      <svg {...common}>
        <rect x="3" y="6" width="18" height="12" rx="2" />
        <path d="M3 10h18" />
      </svg>
    );
  }
  if (name === "start") {
    return (
      <svg {...common}>
        <path d="M12 3v18M5 8l7-5 7 5" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  );
}

function Crumbs({ pathname, origin }: { pathname: string; origin: HotelOrigin | null }) {
  const crumbs = shellCrumbs(pathname, origin);
  return (
    <nav className="v12-crumbs" aria-label="Breadcrumb">
      {crumbs.map((crumb, index) => {
        const last = index === crumbs.length - 1;
        return (
          <span key={`${crumb.label}-${index}`} style={{ display: "contents" }}>
            {index > 0 ? (
              <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                <path
                  d="m9 18 6-6-6-6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : null}
            {last || !crumb.href ? (
              <strong aria-current="page">{crumb.label}</strong>
            ) : (
              <Link href={crumb.href}>{crumb.label}</Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function ShellHeader(props: {
  isStaff: boolean;
  creditLabel: string;
  planLabel: string | null;
  email: string | null;
  pathname: string;
  children: React.ReactNode;
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
  return <ShellBody {...props} origin={origin} />;
}

function ShellBody({
  isStaff,
  creditLabel,
  planLabel,
  email,
  pathname,
  origin,
  children,
}: {
  isStaff: boolean;
  creditLabel: string;
  planLabel: string | null;
  email: string | null;
  pathname: string;
  origin: HotelOrigin | null;
  children: React.ReactNode;
}) {
  const active = activeSidebarHref(pathname, origin);
  const heading = shellHeading(pathname);
  const [open, setOpen] = useState(false);
  const initials = workspaceInitials(email);

  return (
    <div className="v12-shell">
      <a className="v12-skip" href="#main">
        Skip to content
      </a>
      <button
        type="button"
        className={open ? "v12-scrim is-open" : "v12-scrim"}
        aria-label="Close navigation"
        tabIndex={open ? 0 : -1}
        onClick={() => setOpen(false)}
      />
      <aside className={open ? "v12-sidebar is-open" : "v12-sidebar"} aria-label="Main navigation">
        <Link href="/app" className="v12-brand">
          <span>theugc</span>
          <span className="v12-brand-dot" />
          <span>life</span>
        </Link>
        {SIDEBAR_NAV.map((section) => (
          <div key={section.label}>
            <div className="v12-nav-section">{section.label}</div>
            <nav aria-label={section.label}>
              {section.items.map((item) => {
                const current = item.href === active;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="v12-nav-link"
                    aria-current={current ? "page" : undefined}
                    onClick={() => setOpen(false)}
                  >
                    <Icon name={item.icon} />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </nav>
          </div>
        ))}
        {isStaff ? (
          <div>
            <div className="v12-nav-section">Staff</div>
            <Link href="/admin" className="v12-nav-link">
              <Icon name="account" />
              <span>Admin</span>
            </Link>
          </div>
        ) : null}
        <div className="v12-sidebar-foot">
          <div className="v12-profile">
            <span className="v12-avatar">{initials}</span>
            <span>
              <strong>Creator workspace</strong>
              <small>{email ?? "Signed in"}</small>
            </span>
          </div>
          <p className="v12-motto">
            Verified contacts.
            <br />
            Real creator signals.
            <br />
            Smarter outreach.
          </p>
          <SignOutButton />
        </div>
      </aside>
      <div className="v12-main">
        <header className="v12-topbar">
          <button
            type="button"
            className="v12-menu"
            aria-label="Open navigation"
            aria-expanded={open}
            onClick={() => setOpen(true)}
          >
            <svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true">
              <path
                d="M4 7h16M4 12h16M4 17h16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <strong className="v12-location">{heading.title}</strong>
          <span className="v12-dotsep" aria-hidden="true">
            /
          </span>
          <span className="v12-subtle">{heading.subtle}</span>
          <div className="v12-top-right">
            {planLabel ? <span className="v12-pill">{planLabel}</span> : null}
            <Link
              href="/app/billing"
              className="v12-pill v12-pill-lime"
              data-testid="credit-balance"
            >
              {creditLabel}
            </Link>
            <Link href="/app/profile" className="v12-icon-btn" aria-label="My profile">
              <Icon name="profile" />
            </Link>
          </div>
        </header>
        <main id="main" tabIndex={-1} className="v12-content">
          <Crumbs pathname={pathname} origin={origin} />
          {children}
        </main>
      </div>
      <nav className="v12-bottom" aria-label="Quick navigation">
        {MOBILE_NAV.map((item) => {
          const current = item.href === active;
          return (
            <Link key={item.href} href={item.href} aria-current={current ? "page" : undefined}>
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/**
 * Midnight shell. Sidebar, top bar, breadcrumbs, and the mobile bottom bar.
 * Dark only.
 */
export function AppShell({
  isStaff,
  creditLabel,
  planLabel,
  email,
  children,
}: {
  isStaff: boolean;
  creditLabel: string;
  planLabel: string | null;
  email: string | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname() || "/app";
  return (
    <Suspense
      fallback={
        <ShellBody
          isStaff={isStaff}
          creditLabel={creditLabel}
          planLabel={planLabel}
          email={email}
          pathname={pathname}
          origin={null}
        >
          {children}
        </ShellBody>
      }
    >
      <ShellHeader
        isStaff={isStaff}
        creditLabel={creditLabel}
        planLabel={planLabel}
        email={email}
        pathname={pathname}
      >
        {children}
      </ShellHeader>
    </Suspense>
  );
}
