"use client";

/**
 * Global error boundary (wraps the root layout). Must render its own <html>/
 * <body>. Kept minimal and secret-free.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  void error;
  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="max-w-sm text-sm opacity-70">
          An unexpected error occurred. Please try again.
        </p>
        <button onClick={reset} className="rounded-md border px-4 py-2 text-sm font-semibold">
          Try again
        </button>
      </body>
    </html>
  );
}
