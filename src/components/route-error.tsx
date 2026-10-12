"use client";

import { useEffect } from "react";

import { RecoverableError } from "@/components/recoverable-error";

/** Logs the digest only, then renders the surface's recoverable copy. */
export function RouteError({
  error,
  reset,
  title,
  description,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  title: string;
  description: string;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("route_error", { digest: error.digest });
  }, [error]);

  return <RecoverableError title={title} description={description} onRetry={reset} />;
}
