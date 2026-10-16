"use client";

import { useId, useRef } from "react";

export function Modal({
  title,
  trigger,
  children,
}: {
  title: string;
  trigger: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  return (
    <>
      <button type="button" className="v12-btn" onClick={() => ref.current?.showModal()}>
        {trigger}
      </button>
      <dialog ref={ref} className="v12-modal" aria-labelledby={titleId}>
        <div className="v12-modal-body">
          <h2 id={titleId}>{title}</h2>
          {children}
          <div className="v12-modal-actions">
            <button
              type="button"
              className="v12-btn v12-btn-ghost"
              onClick={() => ref.current?.close()}
            >
              Close
            </button>
            <button
              type="button"
              className="v12-btn v12-btn-primary"
              onClick={() => ref.current?.close()}
            >
              Confirm
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
