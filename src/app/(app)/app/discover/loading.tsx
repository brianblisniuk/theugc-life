/**
 * Discover loading skeleton (DESIGN_SYSTEM.md §8). Mirrors the real layout so
 * the page does not shift when results arrive, and never shows a blank screen.
 */
function CardSkeleton() {
  return (
    <div className="space-y-3 rounded-[var(--radius-app)] border border-border bg-surface p-4">
      <div className="h-4 w-2/3 rounded-[var(--radius-app)] bg-border" />
      <div className="h-3 w-1/2 rounded-[var(--radius-app)] bg-border" />
      <div className="h-3 w-1/3 rounded-[var(--radius-app)] bg-border" />
      <div className="h-6 w-24 rounded-[var(--radius-app)] bg-border" />
    </div>
  );
}

export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading hotels…</span>
      <div className="space-y-1">
        <div className="h-7 w-40 rounded-[var(--radius-app)] bg-border" />
        <div className="h-4 w-80 max-w-full rounded-[var(--radius-app)] bg-border" />
      </div>
      <div className="h-28 rounded-[var(--radius-app)] border border-border bg-surface" />
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <li key={i}>
            <CardSkeleton />
          </li>
        ))}
      </ul>
    </div>
  );
}
