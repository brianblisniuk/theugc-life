/** Shared list skeleton (DESIGN_SYSTEM.md §8). The label is the only page-specific text. */
export function ListLoading({ label }: { label: string }) {
  return (
    <div className="space-y-6" aria-busy="true">
      <span role="status" aria-live="polite" className="sr-only">
        {label}
      </span>
      <div className="space-y-1">
        <div className="h-7 w-40 rounded-[var(--radius-app)] bg-border" />
        <div className="h-4 w-80 max-w-full rounded-[var(--radius-app)] bg-border" />
      </div>
      <ul className="space-y-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <li
            key={index}
            className="space-y-2 rounded-[var(--radius-app)] border border-border bg-surface p-4"
          >
            <div className="h-4 w-1/3 rounded-[var(--radius-app)] bg-border" />
            <div className="h-3 w-1/2 rounded-[var(--radius-app)] bg-border" />
          </li>
        ))}
      </ul>
    </div>
  );
}
