/**
 * In-shell 404 for an unknown hotel id. Uses the app-shell sizing convention
 * (see src/app/error.tsx) rather than the full-viewport marketing 404, because
 * the authenticated chrome is already supplied by the layout.
 */
import Link from "next/link";

export default function HotelNotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-xl font-semibold text-text">Hotel not found</h1>
      <p className="max-w-sm text-sm text-muted">
        This hotel doesn’t exist or may have been removed from the catalog.
      </p>
      <Link
        href="/app/discover"
        className="rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
      >
        Back to Discover
      </Link>
    </div>
  );
}
