"use client";

import { RouteError } from "@/components/route-error";
import { SURFACE_ERROR } from "@/lib/surfaces/lists";

export default function DiscoverError({
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
      title={SURFACE_ERROR.discover.title}
      description={SURFACE_ERROR.discover.body}
    />
  );
}
