/**
 * Locked premium contact state (PERMISSIONS.md §7, PRD §5.2/§5.3).
 *
 * This renders when the database has told us the caller has no premium access.
 * The contact query is never issued in that case, so this component receives no
 * contact values at all — nothing is blurred or hidden client-side, because
 * nothing was fetched. It communicates the shape of the value without leaking
 * any part of it.
 *
 * It deliberately does not claim how many contacts exist: `hotel_contacts` is
 * RLS-gated, so an unentitled caller genuinely cannot know that.
 */
import Link from "next/link";

export function LockedField({ label }: { label: string }) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="text-muted">{label}</span>
      <span aria-hidden="true" className="h-3 w-32 rounded-[var(--radius-app)] bg-border" />
    </div>
  );
}

export function LockedContactSection({ destinationName }: { destinationName: string | null }) {
  const passLabel = destinationName ? `${destinationName} Destination Pass` : "a Destination Pass";

  return (
    <div className="space-y-4 rounded-[var(--radius-app)] border border-border bg-surface p-6">
      <div className="space-y-1">
        <h3 className="text-base font-semibold text-text">Verified hotel contact</h3>
        <p className="max-w-prose text-sm text-muted">
          Contact details for this hotel are researched and verified by our editorial team. Unlock
          them with {passLabel} or Creator Pro.
        </p>
      </div>

      <div className="space-y-2">
        <LockedField label="Name" />
        <LockedField label="Email" />
        <LockedField label="Phone" />
        <p className="sr-only">
          Contact details are locked. Upgrade to a Destination Pass or Creator Pro to view them.
        </p>
      </div>

      <Link
        href="/app/billing"
        className="inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
      >
        View access options
      </Link>
    </div>
  );
}
