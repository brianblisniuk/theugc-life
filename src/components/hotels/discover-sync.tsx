"use client";

import { createContext, useContext, useState } from "react";

const SyncContext = createContext<{
  active: string | null;
  setActive: (id: string | null) => void;
  mapOn: boolean;
  setMapOn: (value: boolean) => void;
}>({
  active: null,
  setActive: () => {},
  mapOn: false,
  setMapOn: () => {},
});

export function useDiscoverSync() {
  return useContext(SyncContext);
}

export function MapToggle() {
  const { mapOn, setMapOn } = useDiscoverSync();
  return (
    <button
      type="button"
      className="ux-btn ux-view-toggle"
      aria-pressed={mapOn}
      onClick={() => setMapOn(!mapOn)}
    >
      {mapOn ? "List" : "Map"}
    </button>
  );
}

export function DiscoverFrame({
  map,
  children,
  layout = "split",
}: {
  map: React.ReactNode;
  children: React.ReactNode;
  layout?: "split" | "studio";
}) {
  const [mapOn, setMapOn] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const studio = layout === "studio";

  return (
    <SyncContext.Provider value={{ active, setActive, mapOn, setMapOn }}>
      <div
        className={studio ? "ux-discover s1-discover" : mapOn ? "ux-discover is-map" : "ux-discover"}
        data-discover
        data-layout={layout}
      >
        <div className="ux-list">{children}</div>
        {map ? <div className="ux-map-col">{map}</div> : null}
      </div>
    </SyncContext.Provider>
  );
}

export function SyncRow({ id, children }: { id: string; children: React.ReactNode }) {
  const { active, setActive } = useDiscoverSync();
  return (
    <li
      className={active === id ? "s1-row is-synced" : "s1-row"}
      data-hotel={id}
      onMouseEnter={() => setActive(id)}
      onMouseLeave={() => {
        if (active === id) setActive(null);
      }}
      onFocus={() => setActive(id)}
    >
      {children}
    </li>
  );
}
