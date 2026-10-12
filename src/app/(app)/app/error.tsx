"use client";

import { RouteError } from "@/components/route-error";
import { SURFACE_ERROR } from "@/lib/surfaces/lists";

export default function HomeError({
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
      title={SURFACE_ERROR.home.title}
      description={SURFACE_ERROR.home.body}
    />
  );
}
