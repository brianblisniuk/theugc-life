"use client";

import { useEffect, useRef, type ReactNode } from "react";

const OPEN = "theugc-add-to-trip";

/** Opens the real add-to-trip form. The button does not scroll to an anchor. */
export function AddToTripTrigger({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => window.dispatchEvent(new Event(OPEN))}
    >
      {children}
    </button>
  );
}

export function AddToTripDialog({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const open = () => {
      const dialog = ref.current;
      if (dialog && !dialog.open) dialog.showModal();
    };
    window.addEventListener(OPEN, open);
    return () => window.removeEventListener(OPEN, open);
  }, []);
  return (
    <dialog ref={ref} className="v12-dialog" aria-labelledby="add-to-trip-title">
      <div className="v12-between">
        <h2 id="add-to-trip-title">Add to My Trip</h2>
        <form method="dialog">
          <button type="submit" className="v12-btn v12-btn-small">
            Close
          </button>
        </form>
      </div>
      {children}
    </dialog>
  );
}
