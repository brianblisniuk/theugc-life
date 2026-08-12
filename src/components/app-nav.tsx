"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Primary authenticated navigation (PRD §6, DESIGN_SYSTEM.md §4).
 * EXACTLY the approved items — do not add primary nav without product approval.
 */
const NAV = [
  { href: "/app", label: "Home" },
  { href: "/app/discover", label: "Discover" },
  { href: "/app/pipeline", label: "Pipeline" },
  { href: "/app/trips", label: "Trips" },
  { href: "/app/profile", label: "Profile" },
] as const;

export function AppNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className="flex flex-wrap gap-1">
      {NAV.map((item) => {
        const active = item.href === "/app" ? pathname === "/app" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={
              "rounded-[var(--radius-app)] px-3 py-1.5 text-sm " +
              (active ? "bg-surface font-semibold text-text" : "text-muted hover:text-text")
            }
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
