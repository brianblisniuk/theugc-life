import Link from "next/link";

export default function TripNotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <h1 className="text-xl font-semibold text-text">Trip not found</h1>
      <p className="max-w-sm text-sm text-muted">This trip doesn’t exist.</p>
      <Link
        href="/app/trips"
        className="rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
      >
        Back to Trips
      </Link>
    </div>
  );
}
