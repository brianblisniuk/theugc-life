"use client";

/**
 * Recoverable route error (DESIGN_SYSTEM.md §8). The page passes its own title
 * so a failed hotel is not described as a failed trip. The message never
 * includes the thrown error.
 */
export function RecoverableError({
  title,
  description,
  onRetry,
}: {
  title: string;
  description: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-xl font-semibold text-text">{title}</h1>
      <p className="max-w-sm text-sm text-muted">{description}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
      >
        Try again
      </button>
    </div>
  );
}
