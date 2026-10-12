"use client";

import { RouteError } from "@/components/route-error";
import { SURFACE_ERROR } from "@/lib/surfaces/lists";

export default function HotelError({
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
      title={SURFACE_ERROR.hotel.title}
      description={SURFACE_ERROR.hotel.body}
    />
  );
}
