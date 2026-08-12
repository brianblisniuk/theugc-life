"use client";

import { useEffect } from "react";

/**
 * Route-level error boundary. Renders a recoverable error state without leaking
 * internal details (DESIGN_SYSTEM.md §8, PRD §25.7). The error is logged by the
 * platform via console; we never render secrets/PII to the user.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Platform captures console.error; avoid rendering error internals.
    // eslint-disable-next-line no-console
    console.error("route_error", { digest: error.digest });
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-xl font-semibold text-text">Something went wrong</h1>
      <p className="max-w-sm text-sm text-muted">
        An unexpected error occurred. You can try again.
      </p>
      <button
        onClick={reset}
        className="rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
      >
        Try again
      </button>
    </div>
  );
}
