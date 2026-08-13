/**
 * Hotel detail loading skeleton (DESIGN_SYSTEM.md §8). Mirrors the real section
 * order so the layout is stable once data arrives.
 */
function Block({ className = "" }: { className?: string }) {
  return <div className={`rounded-[var(--radius-app)] bg-border ${className}`} />;
}

export default function Loading() {
  return (
    <div className="space-y-8" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading hotel…</span>

      <div className="space-y-3">
        <Block className="h-4 w-32" />
        <Block className="h-7 w-72 max-w-full" />
        <Block className="h-4 w-48" />
        <Block className="h-5 w-56" />
      </div>

      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="space-y-3">
          <Block className="h-5 w-44" />
          <div className="h-28 rounded-[var(--radius-app)] border border-border bg-surface" />
        </div>
      ))}
    </div>
  );
}
