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
}: {
  map: React.ReactNode;
  children: React.ReactNode;
}) {
  const [mapOn, setMapOn] = useState(false);
  const [active, setActive] = useState<string | null>(null);

  return (
    <SyncContext.Provider value={{ active, setActive, mapOn, setMapOn }}>
      <div className={mapOn ? "ux-discover is-map" : "ux-discover"} data-discover>
        <div className="ux-list">{children}</div>
        <div className="ux-map-col">{map}</div>
      </div>
    </SyncContext.Provider>
  );
}

export function SyncRow({ id, children }: { id: string; children: React.ReactNode }) {
  const { active, setActive } = useDiscoverSync();
  return (
    <li
      className={active === id ? "ux-row is-synced" : "ux-row"}
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
