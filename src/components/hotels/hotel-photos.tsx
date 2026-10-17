"use client";

import { useId, useRef } from "react";

import { hideHotelPhotoAction } from "@/lib/hotels/media-actions";
import { creditLines, type RenderedHotelPhoto } from "@/lib/screens/hotel-photos";

/**
 * V12.2 photo grid. Cover plus two more, then a +N dialog.
 * An empty list is the initials state. Provider URLs are already filtered.
 */
export function HotelPhotos({
  name,
  initials,
  photos,
  hotelId,
  canHide = false,
}: {
  name: string;
  initials: string;
  photos: readonly RenderedHotelPhoto[];
  hotelId?: string;
  canHide?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const dialogId = useId();
  if (photos.length === 0) {
    return (
      <div className="s1-photo-grid" data-photo-state="none">
        <div className="s1-photo">
          <strong className="s1-hotelmark" style={{ margin: "0 auto" }}>
            {initials}
          </strong>
        </div>
      </div>
    );
  }

  const preview = photos.slice(0, 3);
  const extra = photos.length - preview.length;
  const lines = creditLines(photos);

  return (
    <div data-photo-state="ready" data-photo-count={photos.length}>
      <div className="s1-photo-grid">
        {preview.map((photo) => (
          <PhotoFrame key={photo.id} photo={photo} name={name} />
        ))}
      </div>
      {extra > 0 ? (
        <button
          type="button"
          className="s1-photo-open"
          aria-haspopup="dialog"
          aria-controls={dialogId}
          onClick={() => dialogRef.current?.showModal()}
        >
          +{extra}
          <span className="sr-only"> more photographs</span>
        </button>
      ) : null}
      {lines.length > 0 ? <p className="s1-caption">{lines.join(" · ")}</p> : null}
      {canHide && hotelId ? (
        <ul className="s1-photo-hides">
          {photos.map((photo) => (
            <li key={photo.id}>
              <HidePhotoForm hotelId={hotelId} photo={photo} />
            </li>
          ))}
        </ul>
      ) : null}
      <dialog
        ref={dialogRef}
        id={dialogId}
        className="v12-modal s1-photo-dialog"
        aria-labelledby={titleId}
      >
        <div className="v12-modal-body">
          <h2 id={titleId}>Photographs of {name}</h2>
          <div className="s1-photo-all">
            {photos.map((photo) => (
              <PhotoFrame key={`all-${photo.id}`} photo={photo} name={name} large />
            ))}
          </div>
          {lines.length > 0 ? <p className="s1-caption">{lines.join(" · ")}</p> : null}
          <div className="v12-modal-actions">
            <button
              type="button"
              className="v12-btn v12-btn-ghost"
              onClick={() => dialogRef.current?.close()}
            >
              Close
            </button>
          </div>
        </div>
      </dialog>
    </div>
  );
}

function PhotoFrame({
  photo,
  name,
  large = false,
}: {
  photo: RenderedHotelPhoto;
  name: string;
  large?: boolean;
}) {
  return (
    <div className="s1-photo">
      {/* eslint-disable-next-line @next/next/no-img-element -- allowlisted storage and Hotelbeds URLs; sizes are explicit */}
      <img
        src={large ? photo.largeUrl : photo.url}
        srcSet={large ? undefined : photo.srcSet}
        sizes={large ? "90vw" : "(max-width: 760px) 100vw, 40vw"}
        width={photo.width}
        height={photo.height}
        alt={photo.alt || name}
        loading="lazy"
        decoding="async"
      />
    </div>
  );
}

function HidePhotoForm({ hotelId, photo }: { hotelId: string; photo: RenderedHotelPhoto }) {
  async function onSubmit(formData: FormData) {
    await hideHotelPhotoAction(formData);
  }
  return (
    <form action={onSubmit}>
      <input type="hidden" name="mediaId" value={photo.id} />
      <input type="hidden" name="hotelId" value={hotelId} />
      <button type="submit" className="v12-btn v12-btn-small">
        Hide photograph
        <span className="sr-only"> {photo.alt}</span>
      </button>
    </form>
  );
}
