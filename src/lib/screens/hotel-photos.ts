/**
 * Hotel photography (D064).
 *
 * There is no `hotel_media` table and no rights decision for Hotelbeds or
 * Forbes image URLs. Those URLs are not eligible covers. The no-photo state
 * is the product state, not a missing asset to replace with a stock image.
 */
export interface HotelPhotoInput {
  url: string;
  alt: string;
}

export interface EligibleHotelPhoto {
  url: string;
  alt: string;
}

/**
 * Hosts allowed to render as a hotel photograph.
 * Empty until a provenance-backed media record exists. Provider CDNs stay out.
 */
export const ELIGIBLE_PHOTO_HOSTS: readonly string[] = [];

export function presentHotelPhotos(photos: readonly HotelPhotoInput[]): EligibleHotelPhoto[] {
  const eligible: EligibleHotelPhoto[] = [];
  for (const photo of photos) {
    const alt = photo.alt.trim();
    if (!alt) continue;
    let parsed: URL;
    try {
      parsed = new URL(photo.url);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:") continue;
    if (!ELIGIBLE_PHOTO_HOSTS.includes(parsed.host)) continue;
    eligible.push({ url: parsed.toString(), alt });
  }
  return eligible;
}

/** The page asks for eligible covers. Today that list is empty. */
export function eligibleHotelPhotos(): readonly EligibleHotelPhoto[] {
  return presentHotelPhotos([]);
}
