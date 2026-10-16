"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { RetryButton } from "@/components/ui/retry-button";

import { googleMapsApiKey } from "@/lib/maps/google";
import { mountHotelMap } from "@/lib/maps/mount";
import type { PublicMapPin } from "@/lib/maps/pins";
import {
  MAP_PAGE_NOTE,
  MAP_UNAVAILABLE_BODY,
  MAP_UNAVAILABLE_TITLE,
  MAP_WAITING_NOTE,
} from "@/lib/screens/copy";
import { mapPresence, type MapPresence } from "@/lib/screens/map-presence";

import { useDiscoverSync } from "./discover-sync";

export interface MapPreviewMeta {
  name: string;
  line: string;
  href: string;
}

/**
 * Sticky map for the current page only. The caller passes that page's pins.
 * A missing key or a failed script is an error. The list is not replaced.
 * Marker selection opens a preview. It does not put a price or an email on the pin.
 */
export function DiscoverMap({
  pins,
  meta,
  listFailed,
}: {
  pins: readonly PublicMapPin[];
  meta: Readonly<Record<string, MapPreviewMeta>>;
  listFailed: boolean;
}) {
  const apiKey = googleMapsApiKey();
  const [scriptFailed, setScriptFailed] = useState(false);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const { active, setActive } = useDiscoverSync();
  const presence: MapPresence = mapPresence({
    listFailed,
    pinCount: pins.length,
    apiKeyPresent: Boolean(apiKey),
    scriptFailed,
  });

  useEffect(() => {
    if (presence !== "ready" || !apiKey || !container) return;
    let cancelled = false;
    let destroy = () => {};
    mountHotelMap({
      apiKey,
      pins,
      container,
      onSelect: (hotelId) => {
        setSelected(hotelId);
        setActive(hotelId);
      },
    })
      .then((result) => {
        if (cancelled) {
          if (result.status === "shown") result.destroy();
          return;
        }
        if (result.status !== "shown") setScriptFailed(true);
        else destroy = result.destroy;
      })
      .catch(() => {
        if (!cancelled) setScriptFailed(true);
      });
    return () => {
      cancelled = true;
      destroy();
    };
  }, [apiKey, container, pins, presence, setActive]);

  const previewId = selected ?? active;
  const preview = previewId ? meta[previewId] : undefined;

  return (
    <div className="ux-map" data-map-presence={presence}>
      {presence === "unavailable" ? (
        <div className="ux-map-note ux-stack-sm" role="alert">
          <h2 className="ux-name">{MAP_UNAVAILABLE_TITLE}</h2>
          <p className="ux-meta">{MAP_UNAVAILABLE_BODY}</p>
          <RetryButton className="ux-btn" />
        </div>
      ) : presence === "waiting" ? (
        <p className="ux-map-note ux-meta">{MAP_WAITING_NOTE}</p>
      ) : (
        <>
          {presence === "ready" ? <div ref={setContainer} className="ux-map-canvas" /> : null}
          <p className="ux-map-note">{MAP_PAGE_NOTE}</p>
          {pins.length > 0 ? (
            <div>
              {pins.map((pin) => {
                const open = selected === pin.id;
                return (
                  <button
                    key={pin.id}
                    type="button"
                    className={active === pin.id || open ? "ux-pin is-synced" : "ux-pin"}
                    aria-expanded={open}
                    aria-label={`${pin.name}. Show preview.`}
                    onMouseEnter={() => setActive(pin.id)}
                    onFocus={() => setActive(pin.id)}
                    onClick={() => setSelected(open ? null : pin.id)}
                  >
                    <i
                      aria-hidden="true"
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: 999,
                        background: "var(--pin)",
                        boxShadow: "0 0 0 2px var(--pin-ring)",
                        display: "inline-block",
                      }}
                    />
                    {pin.name}
                  </button>
                );
              })}
            </div>
          ) : null}
          {preview ? (
            <div className="ux-preview ux-stack-sm">
              <p className="ux-name">{preview.name}</p>
              <p className="ux-meta">{preview.line}</p>
              <Link className="ux-btn" href={preview.href}>
                View hotel
              </Link>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Hotel detail map. Same failure copy. One pin, no list replacement. */
export function HotelMap({
  pins,
  variant = "rail",
}: {
  pins: readonly PublicMapPin[];
  variant?: "rail" | "section";
}) {
  const apiKey = googleMapsApiKey();
  const [scriptFailed, setScriptFailed] = useState(false);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const presence = mapPresence({
    listFailed: false,
    pinCount: pins.length,
    apiKeyPresent: Boolean(apiKey),
    scriptFailed,
  });

  useEffect(() => {
    if (presence !== "ready" || !apiKey || !container) return;
    let cancelled = false;
    let destroy = () => {};
    mountHotelMap({ apiKey, pins, container })
      .then((result) => {
        if (cancelled) {
          if (result.status === "shown") result.destroy();
          return;
        }
        if (result.status !== "shown") setScriptFailed(true);
        else destroy = result.destroy;
      })
      .catch(() => {
        if (!cancelled) setScriptFailed(true);
      });
    return () => {
      cancelled = true;
      destroy();
    };
  }, [apiKey, container, pins, presence]);

  const className = variant === "section" ? "ux-map" : "ux-map";
  const style = variant === "section" ? { minHeight: 320, height: 320 } : undefined;

  if (presence === "empty") return null;

  if (presence !== "ready") {
    return (
      <div className="ux-notice" role="alert">
        <h2 className="ux-name">{MAP_UNAVAILABLE_TITLE}</h2>
        <p className="ux-meta">{MAP_UNAVAILABLE_BODY}</p>
        <RetryButton className="ux-btn" />
      </div>
    );
  }

  return (
    <div className={className} style={style}>
      <div ref={setContainer} className="ux-map-canvas" />
      <p className="ux-map-note">
        {variant === "section"
          ? "One published hotel. The sections above are the text alternative."
          : MAP_PAGE_NOTE}
      </p>
    </div>
  );
}
