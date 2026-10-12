/**
 * Discover loading skeleton (DESIGN_SYSTEM.md §8). Layout only — this is not
 * the no-photo state, which is a designed empty image on a loaded row.
 */
function RowSkeleton() {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 py-3">
      <div className="h-16 border border-border bg-background" />
      <div className="space-y-2">
        <div className="h-4 w-2/3 bg-border" />
        <div className="h-3 w-1/2 bg-border" />
        <div className="h-3 w-1/3 bg-border" />
      </div>
    </div>
  );
}

export default function Loading() {
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_16rem]" aria-busy="true">
      <span role="status" aria-live="polite" className="sr-only">
        Loading hotels…
      </span>
      <div className="space-y-6">
        <div className="space-y-1">
          <div className="h-7 w-40 bg-border" />
          <div className="h-4 w-80 max-w-full bg-border" />
        </div>
        <div className="h-28 border border-border bg-background" />
        <ul className="divide-y divide-border border-y border-border">
          {Array.from({ length: 6 }).map((_, index) => (
            <li key={index}>
              <RowSkeleton />
            </li>
          ))}
        </ul>
      </div>
      <div className="h-28 border border-border bg-background" />
    </div>
  );
}
