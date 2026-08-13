/**
 * Pipeline loading skeleton (DESIGN_SYSTEM.md §8). Mirrors the real layout so
 * the page does not shift when rows arrive.
 */
export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true">
      <span role="status" aria-live="polite" className="sr-only">
        Loading your pipeline…
      </span>

      <div className="space-y-1">
        <div className="h-7 w-40 rounded-[var(--radius-app)] bg-border" />
        <div className="h-4 w-80 max-w-full rounded-[var(--radius-app)] bg-border" />
      </div>

      <div className="h-20 rounded-[var(--radius-app)] border border-border bg-surface" />

      <ul className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <li
            key={i}
            className="space-y-2 rounded-[var(--radius-app)] border border-border bg-surface p-4"
          >
            <div className="h-4 w-1/3 rounded-[var(--radius-app)] bg-border" />
            <div className="h-3 w-1/4 rounded-[var(--radius-app)] bg-border" />
            <div className="h-3 w-1/2 rounded-[var(--radius-app)] bg-border" />
          </li>
        ))}
      </ul>
    </div>
  );
}
