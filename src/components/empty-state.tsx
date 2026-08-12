/**
 * EmptyState primitive (DESIGN_SYSTEM.md §4, §8). Teaches the next useful
 * action rather than showing a blank surface. Sprint 0 shells reuse this to
 * mark not-yet-built product areas without inventing product UI.
 */
export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-[var(--radius-app)] border border-border bg-surface p-8 text-center">
      <h2 className="text-base font-semibold text-text">{title}</h2>
      {description ? (
        <p className="mx-auto mt-2 max-w-md text-sm text-muted">{description}</p>
      ) : null}
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}
