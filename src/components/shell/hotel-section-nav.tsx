"use client";

import { useEffect, useState } from "react";

import { HOTEL_SECTIONS, isHotelSection } from "@/lib/shell/navigation";

/**
 * In-page sections of Hotel Detail. The active section follows the URL hash.
 * An unknown hash leaves Overview active and does not navigate away.
 */
export function HotelSectionNav() {
  const [hash, setHash] = useState("");

  useEffect(() => {
    const read = () => setHash(window.location.hash.replace(/^#/, ""));
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  const active = isHotelSection(hash) ? hash : "identity";

  return (
    <nav
      aria-label="Hotel sections"
      className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0"
    >
      {HOTEL_SECTIONS.map((section) => {
        const current = section.id === active;
        return (
          <a
            key={section.id}
            href={`#${section.id}`}
            aria-current={current ? "location" : undefined}
            className={
              "inline-flex min-h-11 shrink-0 items-center rounded-[var(--radius-app)] px-3 text-sm " +
              (current ? "bg-surface font-semibold text-text" : "text-muted hover:text-text")
            }
          >
            {section.label}
          </a>
        );
      })}
    </nav>
  );
}
