/**
 * Hotel photography (D189, amending D064).
 *
 * Eligible covers come from `hotel_media`. Forbes is served from this
 * project's Supabase storage. Hotelbeds is served from photos.hotelbeds.com.
 * Any other host, including the Forbes CDN, is dropped. A hotel with no
 * eligible row keeps the no-photo state.
 */

export const HOTELBEDS_PHOTO_HOST = "photos.hotelbeds.com";
export const HOTEL_MEDIA_BUCKET = "hotel-media";
export const FORBES_CREDIT = "Forbes Travel Guide";
export const HOTELBEDS_CREDIT = "Hotelbeds";
export const PHOTO_RIGHTS_BASIS = "owner_decision_D189";

export type PhotoSource = "forbes" | "hotelbeds";
export type PhotoRole = "cover" | "gallery";
export type MediaVariant = "thumb" | "gallery" | "large";

export interface HotelPhotoInput {
  url: string;
  alt: string;
}

export interface EligibleHotelPhoto {
  url: string;
  alt: string;
}

/** A hotel_media row the screen is allowed to turn into a URL. */
export interface HotelMediaRecord {
  id: string;
  source: PhotoSource;
  storagePath: string | null;
  remotePath: string | null;
  role: PhotoRole;
  position: number;
  width: number | null;
  height: number | null;
  altText: string | null;
  credit: string;
}

export interface RenderedHotelPhoto {
  id: string;
  url: string;
  srcSet: string;
  largeUrl: string;
  alt: string;
  /** Catalog alt. Null when the row had none. Absent only on hand-built fixtures. */
  sourceAlt?: string | null;
  credit: string;
  creditLine: string;
  width: number;
  height: number;
}

/** A missing catalog alt is the hotel name plus the photograph's place in the gallery. */
export function announcedPhotoAlt(
  photo: { alt: string; sourceAlt?: string | null },
  hotelName: string,
  index: number,
): string {
  const stored = (photo.sourceAlt === undefined ? photo.alt : (photo.sourceAlt ?? "")).trim();
  if (stored && (photo.sourceAlt !== undefined || stored !== "Hotel photograph")) return stored;
  const name = hotelName.trim() || "Hotel";
  const place = Number.isInteger(index) && index > 0 ? index : 1;
  return `${name} photograph ${place}`;
}

/** Each Hide control names its place and credit so identical labels are not repeated. */
export function hidePhotographName(index: number, credit: string): string {
  const place = Number.isInteger(index) && index > 0 ? index : 1;
  const who = credit.trim();
  return who ? `Hide photograph ${place}, ${who}` : `Hide photograph ${place}`;
}

/** Shown when the gallery page is shorter than the hotel's active photographs. */
export function hotelPhotoCountNote(shown: number, more: boolean): string | null {
  if (!more || !Number.isInteger(shown) || shown < 1) return null;
  const noun = shown === 1 ? "photograph" : "photographs";
  return `Showing ${shown} ${noun}. More photographs are on file.`;
}

const UNSAFE_PATH = /(\.\.|\\|^\s|\s$|\/\/|[\u0000-\u001f])/;

function supabaseHost(supabaseUrl: string | null | undefined): string | null {
  if (!supabaseUrl) return null;
  try {
    const url = new URL(supabaseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.host;
  } catch {
    return null;
  }
}

/**
 * Hosts allowed to render. The storage host is the host of
 * NEXT_PUBLIC_SUPABASE_URL. photos.hotelbeds.com is the other one.
 */
export function eligiblePhotoHosts(supabaseUrl?: string | null): readonly string[] {
  const configured = supabaseUrl === undefined ? process.env.NEXT_PUBLIC_SUPABASE_URL : supabaseUrl;
  const storage = supabaseHost(configured);
  const hosts = [HOTELBEDS_PHOTO_HOST];
  if (storage) hosts.unshift(storage);
  return hosts;
}

export function photoCreditLine(credit: string): string {
  if (credit === FORBES_CREDIT) return "Photo: Forbes Travel Guide";
  if (credit === HOTELBEDS_CREDIT) return "Hotelbeds";
  const trimmed = credit.trim();
  if (!trimmed) return "";
  return trimmed.toLowerCase().startsWith("photo:") ? trimmed : `Photo: ${trimmed}`;
}

function safeRelativePath(path: string | null | undefined): string | null {
  if (!path) return null;
  const trimmed = path.trim().replace(/^\/+/, "");
  if (!trimmed || UNSAFE_PATH.test(trimmed) || trimmed.includes("://")) return null;
  return trimmed;
}

export function mediaUrl(
  row: Pick<HotelMediaRecord, "source" | "storagePath" | "remotePath">,
  variant: MediaVariant,
  supabaseUrl?: string | null,
): string | null {
  if (row.source === "forbes") {
    const basePath = safeRelativePath(row.storagePath);
    const configured =
      supabaseUrl === undefined ? process.env.NEXT_PUBLIC_SUPABASE_URL : supabaseUrl;
    if (!basePath || !configured) return null;
    let origin: string;
    try {
      const url = new URL(configured);
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      origin = url.origin;
    } catch {
      return null;
    }
    const file = variant === "thumb" ? "w480.webp" : "w1280.webp";
    return `${origin}/storage/v1/object/public/${HOTEL_MEDIA_BUCKET}/${basePath}/${file}`;
  }
  const remote = safeRelativePath(row.remotePath);
  if (!remote) return null;
  const prefix = variant === "thumb" ? "" : variant === "large" ? "xl/" : "bigger/";
  return `https://${HOTELBEDS_PHOTO_HOST}/giata/${prefix}${remote}`;
}

export function presentHotelPhotos(
  photos: readonly HotelPhotoInput[],
  supabaseUrl?: string | null,
): EligibleHotelPhoto[] {
  const hosts = eligiblePhotoHosts(supabaseUrl);
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
    if (!hosts.includes(parsed.host)) continue;
    eligible.push({ url: parsed.toString(), alt });
  }
  return eligible;
}

function srcSetFor(
  row: Pick<HotelMediaRecord, "source" | "storagePath" | "remotePath">,
  supabaseUrl: string | null | undefined,
): { src: string; srcSet: string; largeUrl: string } | null {
  const thumb = mediaUrl(row, "thumb", supabaseUrl);
  const gallery = mediaUrl(row, "gallery", supabaseUrl);
  const large = mediaUrl(row, "large", supabaseUrl);
  if (!thumb || !gallery || !large) return null;
  if (row.source === "forbes") {
    return { src: gallery, srcSet: `${thumb} 480w, ${gallery} 1280w`, largeUrl: large };
  }
  return { src: gallery, srcSet: `${thumb} 320w, ${gallery} 800w`, largeUrl: large };
}

/** Forbes before Hotelbeds, then the cover, then position. */
export function compareHotelMedia(a: HotelMediaRecord, b: HotelMediaRecord): number {
  if (a.source !== b.source) return a.source === "forbes" ? -1 : 1;
  if (a.role !== b.role) return a.role === "cover" ? -1 : 1;
  if (a.position !== b.position) return a.position - b.position;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Rows the screen may paint. Unknown hosts and insecure URLs are omitted.
 * Pass no rows for the empty catalog state.
 */
/** No rows is the empty catalog state. Pass media rows to render eligible covers. */
export function eligibleHotelPhotos(
  rows: readonly HotelMediaRecord[] = [],
  supabaseUrl?: string | null,
): RenderedHotelPhoto[] {
  return renderedHotelPhotos(rows, supabaseUrl);
}

export function renderedHotelPhotos(
  rows: readonly HotelMediaRecord[],
  supabaseUrl?: string | null,
): RenderedHotelPhoto[] {
  const ordered = [...rows].sort(compareHotelMedia);
  const rendered: RenderedHotelPhoto[] = [];
  for (const row of ordered) {
    const built = srcSetFor(row, supabaseUrl);
    if (!built) continue;
    const sourceAlt = (row.altText ?? "").trim() || null;
    const alt = sourceAlt || "Hotel photograph";
    const presented = presentHotelPhotos([{ url: built.src, alt }], supabaseUrl);
    const large = presentHotelPhotos([{ url: built.largeUrl, alt }], supabaseUrl);
    if (presented.length === 0 || large.length === 0) continue;
    const width = row.width && row.width > 0 ? row.width : row.source === "forbes" ? 1280 : 800;
    const height = row.height && row.height > 0 ? row.height : row.source === "forbes" ? 720 : 533;
    rendered.push({
      id: row.id,
      url: presented[0]!.url,
      srcSet: built.srcSet,
      largeUrl: large[0]!.url,
      alt,
      sourceAlt,
      credit: row.credit,
      creditLine: photoCreditLine(row.credit),
      width,
      height,
    });
  }
  return rendered;
}

export function coverFromMedia(
  row: HotelMediaRecord | null | undefined,
  supabaseUrl?: string | null,
): RenderedHotelPhoto | null {
  if (!row) return null;
  return renderedHotelPhotos([row], supabaseUrl)[0] ?? null;
}

/** Visible credit lines, Forbes first, each source once. */
export function creditLines(
  photos: readonly Pick<RenderedHotelPhoto, "credit" | "creditLine">[],
): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  const ordered = [...photos].sort((a, b) => {
    if (a.credit === b.credit) return 0;
    if (a.credit === FORBES_CREDIT) return -1;
    if (b.credit === FORBES_CREDIT) return 1;
    return a.credit < b.credit ? -1 : 1;
  });
  for (const photo of ordered) {
    if (!photo.creditLine || seen.has(photo.creditLine)) continue;
    seen.add(photo.creditLine);
    lines.push(photo.creditLine);
  }
  return lines;
}
