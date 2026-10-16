import { presentHotelPhotos, type HotelPhotoInput } from "@/lib/screens/hotel-photos";

/**
 * Eligible photographs, or the designed no-photo state.
 * Provider image URLs are dropped before this renders.
 */
export function HotelPhotos({
  name,
  initials,
  photos,
}: {
  name: string;
  initials: string;
  photos: readonly HotelPhotoInput[];
}) {
  const eligible = presentHotelPhotos(photos);
  if (eligible.length === 0) {
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
  return (
    <div className="s1-photo-grid">
      {eligible.slice(0, 3).map((photo) => (
        <div className="s1-photo" key={photo.url}>
          {/* eslint-disable-next-line @next/next/no-img-element -- allowlisted https covers only; next/image remotePatterns stay empty until a media record exists */}
          <img src={photo.url} alt={photo.alt || name} />
        </div>
      ))}
    </div>
  );
}
