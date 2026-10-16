"use client";

import { useState } from "react";

export function Tabs({
  label,
  tabs,
}: {
  label: string;
  tabs: readonly { id: string; label: string; panel: React.ReactNode }[];
}) {
  const [active, setActive] = useState(tabs[0]?.id ?? "");
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];
  return (
    <div>
      <div className="v12-tabs" role="tablist" aria-label={label}>
        {tabs.map((tab) => {
          const selected = tab.id === current?.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              className="v12-tab"
              id={`tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`panel-${tab.id}`}
              onClick={() => setActive(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {current ? (
        <div
          className="v12-tab-panel"
          role="tabpanel"
          id={`panel-${current.id}`}
          aria-labelledby={`tab-${current.id}`}
        >
          {current.panel}
        </div>
      ) : null}
    </div>
  );
}
