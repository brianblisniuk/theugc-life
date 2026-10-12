"use client";

import { RouteError } from "@/components/route-error";
import { SURFACE_ERROR } from "@/lib/surfaces/lists";

export default function TripsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteError
      error={error}
      reset={reset}
      title={SURFACE_ERROR.trips.title}
      description={SURFACE_ERROR.trips.body}
    />
  );
}
