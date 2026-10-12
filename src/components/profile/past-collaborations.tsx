/**
 * Private history. Each row links to the hotel, where a new pipeline cycle is
 * opened. The link does not copy the collaboration onto that cycle.
 */
import Link from "next/link";

import { ShareMarkButton } from "@/components/profile/share-mark-button";
import type { PastCollaborationsLoad } from "@/lib/profile/contract";

export function PastCollaborations({
  load,
  heading,
  linkToHotel,
  hideWhenEmpty = false,
  sharedIds,
}: {
  load: PastCollaborationsLoad;
  heading: string;
  linkToHotel: boolean;
  hideWhenEmpty?: boolean;
  sharedIds?: ReadonlySet<string>;
}) {
  if (load.status === "error" || load.status === "not_found") {
    return (
      <section id="past-collaborations" className="space-y-2">
        <h2 className="text-lg font-semibold text-text">{heading}</h2>
        <p className="max-w-prose text-sm text-muted">
          Past collaborations couldn’t be loaded. This is not an empty list.
        </p>
      </section>
    );
  }

  if (load.items.length === 0) {
    if (hideWhenEmpty) return null;
    return (
      <section id="past-collaborations" className="space-y-2">
        <h2 className="text-lg font-semibold text-text">{heading}</h2>
        <p className="max-w-prose text-sm text-muted">
          No completed or cancelled collaboration recorded yet.
        </p>
      </section>
    );
  }

  return (
    <section id="past-collaborations" className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-text">{heading}</h2>
        <p className="max-w-prose text-sm text-muted">
          Completed and cancelled collaborations you recorded. Opening a hotel does not copy this
          history onto a new pipeline cycle.
        </p>
      </div>
      <ul className="space-y-3">
        {load.items.map((item) => (
          <li
            key={item.id}
            className="flex flex-wrap items-start justify-between gap-3 rounded-[var(--radius-app)] border border-border bg-surface p-4"
          >
            <div className="space-y-1">
              <h3 className="text-base font-semibold text-text">{item.hotelName}</h3>
              <p className="text-sm text-muted">
                <span className="rounded-[var(--radius-app)] border border-border px-2 py-0.5 font-medium text-text">
                  {item.statusLabel}
                </span>
                {item.typeLabel ? <span className="ml-2">{item.typeLabel}</span> : null}
              </p>
              {item.when ? <p className="text-xs text-muted">{item.when}</p> : null}
              <p className="text-xs text-muted">
                {item.againLabel}
                {item.termsLabel ? ` · ${item.termsLabel}` : ""}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {sharedIds ? (
                <ShareMarkButton
                  id={item.id}
                  shared={sharedIds.has(item.id)}
                  kind="collaboration"
                />
              ) : null}
              {linkToHotel ? (
                <Link
                  href={item.href}
                  className="inline-flex rounded-[var(--radius-app)] border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-background"
                >
                  Open hotel
                </Link>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
