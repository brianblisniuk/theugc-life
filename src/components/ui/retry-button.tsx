"use client";

import { useRouter } from "next/navigation";

/**
 * Reloads the current route from the server. An empty href reloads the
 * document and leaves client state in place.
 */
export function RetryButton({
  label = "Retry",
  className = "v12-btn",
}: {
  label?: string;
  className?: string;
}) {
  const router = useRouter();
  return (
    <button type="button" className={className} onClick={() => router.refresh()}>
      {label}
    </button>
  );
}
