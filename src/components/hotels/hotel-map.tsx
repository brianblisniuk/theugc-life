"use client";

/**
 * Published-hotel map (D079).
 *
 * Renders nothing when the public key is missing, when there is no pin, or
 * when the script fails. There is no error state: the list remains the way
 * to browse the same hotels.
 */
import { useEffect, useState } from "react";

import { googleMapsApiKey, shouldMountMap } from "@/lib/maps/google";
import { mountHotelMap } from "@/lib/maps/mount";
import type { PublicMapPin } from "@/lib/maps/pins";

export function HotelMap({
  pins,
  variant = "rail",
}: {
  pins: readonly PublicMapPin[];
  /** Discover keeps the map in the side rail. Hotel Detail uses a section. */
  variant?: "rail" | "section";
}) {
  const apiKey = googleMapsApiKey();
  const show = shouldMountMap(apiKey, pins.length);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!show || !apiKey || !container) return;
    let cancelled = false;
    let destroy = () => {};
    mountHotelMap({ apiKey, pins, container })
      .then((result) => {
        if (cancelled) {
          if (result.status === "shown") result.destroy();
          return;
        }
        if (result.status !== "shown") setFailed(true);
        else destroy = result.destroy;
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      destroy();
    };
  }, [apiKey, container, pins, show]);

  if (!show || failed) return null;

  const className =
    variant === "rail"
      ? "border border-border bg-background lg:sticky lg:top-4"
      : "border border-border bg-background";

  return (
    <aside aria-label="Map" className={className}>
      <h2 className="sr-only">Map</h2>
      <div ref={setContainer} className="h-80 w-full" />
    </aside>
  );
}
