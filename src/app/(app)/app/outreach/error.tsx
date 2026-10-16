"use client";

import { RouteError } from "@/components/route-error";

export default function OutreachError({
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
      title="We couldn’t load outreach"
      description="Something went wrong on our side. Try again. This is not an empty list."
    />
  );
}
