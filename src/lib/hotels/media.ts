/**
 * Catalog reads for hotel_media (D189).
 *
 * The cookie client is the only client. RLS hides hidden rows from everyone,
 * including staff. A failed read is an error, not an empty gallery.
 */
import "server-only";

import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/hotels/ids";
import {
  compareHotelMedia,
  coverFromMedia,
  renderedHotelPhotos,
  type HotelMediaRecord,
  type PhotoRole,
  type PhotoSource,
  type RenderedHotelPhoto,
} from "@/lib/screens/hotel-photos";

const MEDIA_LIMIT = 36;
const COVER_ID_LIMIT = 50;

export interface HotelMediaLoad {
  status: "ok" | "error";
  photos: RenderedHotelPhoto[];
}

export interface HotelCoverLoad {
  status: "ok" | "error";
  byHotel: Map<string, RenderedHotelPhoto>;
}

interface MediaRow {
  id?: unknown;
  hotel_id?: unknown;
  source?: unknown;
  storage_path?: unknown;
  remote_path?: unknown;
  role?: unknown;
  position?: unknown;
  width?: unknown;
  height?: unknown;
  alt_text?: unknown;
  credit?: unknown;
}

function asSource(value: unknown): PhotoSource | null {
  return value === "forbes" || value === "hotelbeds" ? value : null;
}

function asRole(value: unknown): PhotoRole | null {
  return value === "cover" || value === "gallery" ? value : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

export function mapMediaRow(row: MediaRow): HotelMediaRecord | null {
  const id = asText(row.id);
  const source = asSource(row.source);
  const role = asRole(row.role);
  const position = asInt(row.position);
  const credit = asText(row.credit);
  if (!id || !source || !role || position === null || position < 0 || !credit) return null;
  return {
    id,
    source,
    storagePath: asText(row.storage_path),
    remotePath: asText(row.remote_path),
    role,
    position,
    width: asInt(row.width),
    height: asInt(row.height),
    altText: asText(row.alt_text),
    credit,
  };
}

export async function fetchHotelMedia(hotelId: string): Promise<HotelMediaLoad> {
  if (!isUuid(hotelId)) return { status: "ok", photos: [] };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("hotel_media")
    .select(
      "id, hotel_id, source, storage_path, remote_path, role, position, width, height, alt_text, credit",
    )
    .eq("hotel_id", hotelId)
    .eq("status", "active")
    .order("position", { ascending: true })
    .limit(MEDIA_LIMIT);
  if (error) return { status: "error", photos: [] };
  const records = ((data ?? []) as MediaRow[])
    .map(mapMediaRow)
    .filter((row): row is HotelMediaRecord => row !== null)
    .sort(compareHotelMedia);
  return { status: "ok", photos: renderedHotelPhotos(records) };
}

export async function fetchHotelCovers(hotelIds: readonly string[]): Promise<HotelCoverLoad> {
  const ids = [...new Set(hotelIds.filter((id) => isUuid(id)))].slice(0, COVER_ID_LIMIT);
  if (ids.length === 0) return { status: "ok", byHotel: new Map() };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("hotel_cover")
    .select("hotel_id, source, storage_path, remote_path, alt_text, credit")
    .in("hotel_id", ids);
  if (error) return { status: "error", byHotel: new Map() };
  const byHotel = new Map<string, RenderedHotelPhoto>();
  for (const raw of (data ?? []) as MediaRow[]) {
    const hotelId = asText(raw.hotel_id);
    const record = mapMediaRow({ ...raw, id: hotelId, role: "cover", position: 0 });
    if (!hotelId || !record) continue;
    const cover = coverFromMedia(record);
    if (cover) byHotel.set(hotelId, { ...cover, id: hotelId });
  }
  return { status: "ok", byHotel };
}
