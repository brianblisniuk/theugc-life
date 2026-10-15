"use client";

import { useEffect, useState } from "react";

import { HOTEL_TABS, hotelTabForHash } from "@/lib/shell/navigation";

/** Four sections. The active tab follows the hash, including anchors inside My work. */
export function HotelSectionNav() {
  const [hash, setHash] = useState("");

  useEffect(() => {
    const read = () => setHash(window.location.hash.replace(/^#/, ""));
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  const active = hotelTabForHash(hash);

  return (
    <nav className="ux-subnav" aria-label="Hotel sections">
      {HOTEL_TABS.map((section) => {
        const current = section.id === active;
        return (
          <a key={section.id} href={`#${section.id}`} aria-current={current ? "true" : undefined}>
            {section.label}
          </a>
        );
      })}
    </nav>
  );
}
