"use client";

import { useEffect, useId, useState } from "react";

import { THRESHOLD_RULES } from "@/lib/metrics/contract";

/** Click and keyboard open the H01 threshold text. Escape closes it. */
export function Methodology() {
  const [open, setOpen] = useState(false);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="ux-anchor">
      <button
        type="button"
        className="ux-btn"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        How this works
      </button>
      {open ? (
        <div className="ux-popover" id={id} role="dialog" aria-label="How this works">
          <h2 className="ux-name">How this works</h2>
          <p>{THRESHOLD_RULES.creator_activity}</p>
          <p>{THRESHOLD_RULES.response_rate}</p>
          <p>{THRESHOLD_RULES.response_time}</p>
          <p className="ux-meta">
            Confidence and freshness sit beside a metric. They are not a score. Insufficient data is
            never 0% and never Low.
          </p>
        </div>
      ) : null}
    </div>
  );
}
