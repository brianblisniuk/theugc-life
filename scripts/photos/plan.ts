/**
 * Pure planning for the Forbes and Hotelbeds loaders (D189).
 *
 * No network and no secrets. The CLIs call these and then talk to Supabase.
 * hotel_source_identities accepts only source_environment = 'production' (D065).
 * The scrape vintage scrape-2026-10 is stored in match_evidence, not as the
 * environment. link_status is 'active'; 'linked' is not a value in that check.
 */

export const FORBES_CREDIT = "Forbes Travel Guide";
export const HOTELBEDS_CREDIT = "Hotelbeds";
export const PHOTO_RIGHTS_BASIS = "owner_decision_D189";
export const SCRAPE_VINTAGE = "scrape-2026-10";
export const HOTELBEDS_LIMIT = 12;
export const HAB_CAP = 4;

const TYPE_ORDER = ["GEN", "PIS", "HAB", "RES", "BAR", "PLA", "TER", "COM", "DEP", "CON"] as const;

export interface HotelbedsImage {
  type: string;
  path: string;
  order: number;
  visualOrder: number;
}

export interface MatchRow {
  className: "auto" | "review" | "reject" | "none";
  hotelId: string;
  forbesPropertyId: string;
  forbesSlug: string;
  forbesName: string;
  stagingName: string;
  distKm: number;
  nameSim: number;
  approved: boolean;
}

export interface GalleryPhoto {
  slug: string;
  position: number;
  fileName: string;
  absolutePath: string | null;
}

export interface HotelMediaInsert {
  hotel_id: string;
  source: "forbes" | "hotelbeds";
  source_media_key: string;
  storage_bucket: string | null;
  storage_path: string | null;
  remote_path: string | null;
  category: string | null;
  role: "gallery";
  position: number;
  width: number | null;
  height: number | null;
  alt_text: string;
  credit: string;
  rights_basis: string;
  status: "active";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let cell = "";
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    if (char !== "\r") cell += char;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  const header = rows[0]?.map((value) => value.trim()) ?? [];
  return rows.slice(1).filter((values) => values.some((value) => value.trim() !== "")).map((values) => {
    const record: Record<string, string> = {};
    header.forEach((key, index) => {
      if (key) record[key] = (values[index] ?? "").trim();
    });
    return record;
  });
}

function field(row: Record<string, string>, names: readonly string[]): string {
  for (const name of names) {
    const value = row[name];
    if (value) return value;
  }
  return "";
}

export function parseMatchCsv(text: string): { rows: MatchRow[]; rejected: number } {
  const parsed = parseCsv(text);
  const rows: MatchRow[] = [];
  let rejected = 0;
  for (const raw of parsed) {
    const className = field(raw, ["class", "className"]).toLowerCase();
    if (className !== "auto" && className !== "review" && className !== "reject" && className !== "none") {
      rejected += 1;
      continue;
    }
    const approvedRaw = field(raw, ["approved"]).toLowerCase();
    const approved = approvedRaw === "true" || approvedRaw === "yes" || approvedRaw === "1";
    const hotelId = field(raw, ["hotel_id", "hotelId"]);
    const forbesPropertyId = field(raw, ["forbes_property_id", "property_id", "forbes_id"]);
    const forbesSlug = field(raw, ["forbes_slug", "slug", "image_folder"]);
    if (!UUID_RE.test(hotelId) || !forbesPropertyId || !forbesSlug || forbesSlug.includes("..")) {
      rejected += 1;
      continue;
    }
    const dist = Number(field(raw, ["dist_km", "distKm"]));
    const sim = Number(field(raw, ["name_sim", "nameSim"]));
    rows.push({
      className,
      hotelId,
      forbesPropertyId,
      forbesSlug,
      forbesName: field(raw, ["forbes_name", "forbesName", "name"]),
      stagingName: field(raw, ["staging_name", "stagingName"]),
      distKm: Number.isFinite(dist) ? dist : Number.POSITIVE_INFINITY,
      nameSim: Number.isFinite(sim) ? sim : 0,
      approved,
    });
  }
  return { rows, rejected };
}

/** auto, and review only when approved. One Forbes property, and one hotel, win. */
export function selectMatches(rows: readonly MatchRow[]): { chosen: MatchRow[]; skipped: number } {
  const eligible = rows.filter(
    (row) => row.className === "auto" || (row.className === "review" && row.approved),
  );
  const skippedBase = rows.length - eligible.length;
  const byProperty = new Map<string, MatchRow>();
  let skipped = skippedBase;
  for (const row of eligible) {
    const prior = byProperty.get(row.forbesPropertyId);
    if (!prior || betterMatch(row, prior)) byProperty.set(row.forbesPropertyId, row);
    else skipped += 1;
  }
  const byHotel = new Map<string, MatchRow>();
  for (const row of byProperty.values()) {
    const prior = byHotel.get(row.hotelId);
    if (!prior || betterMatch(row, prior)) {
      if (prior) skipped += 1;
      byHotel.set(row.hotelId, row);
    } else {
      skipped += 1;
    }
  }
  return { chosen: [...byHotel.values()], skipped };
}

function betterMatch(next: MatchRow, prior: MatchRow): boolean {
  if (next.className !== prior.className) return next.className === "auto";
  if (next.distKm !== prior.distKm) return next.distKm < prior.distKm;
  return next.nameSim > prior.nameSim;
}

export function fileStem(fileName: string): string | null {
  const base = fileName.split(/[/\\]/).pop() ?? "";
  const stem = base.replace(/\.[a-z0-9]+$/i, "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,120}$/.test(stem)) return null;
  return stem;
}

export function forbesAlt(slug: string, fileName: string): string {
  const stem = fileStem(fileName);
  if (!stem) return "Hotel photograph";
  // The file stem starts with the hotel slug, slashes written as hyphens.
  const prefix = slug
    .trim()
    .replace(/\/+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  let rest = stem;
  if (prefix && rest.startsWith(`${prefix}-`)) rest = rest.slice(prefix.length + 1);
  const words = rest.replace(/-+/g, " ").replace(/\s+/g, " ").trim();
  if (!words) return "Hotel photograph";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function forbesStorageBase(slug: string, position: number, fileName: string): string | null {
  if (!/^[a-z0-9][a-z0-9/_-]{0,180}$/i.test(slug)) return null;
  if (slug.includes("..") || slug.startsWith("/") || slug.endsWith("/")) return null;
  const stem = fileStem(fileName);
  if (!stem || position < 0 || position > 99) return null;
  const index = String(position).padStart(2, "0");
  return `forbes/${slug}/${index}-${stem}`;
}

export function forbesObjectPaths(base: string): { w1280: string; w480: string } {
  return { w1280: `${base}/w1280.webp`, w480: `${base}/w480.webp` };
}

export interface NormalizedHotelbeds {
  type: string;
  path: string;
  order: number;
  visualOrder: number;
}

export function normalizeHotelbedsImage(value: unknown): NormalizedHotelbeds | null {
  if (Array.isArray(value)) {
    const [type, path, order, visualOrder] = value;
    if (typeof type !== "string" || typeof path !== "string") return null;
    return {
      type: type.trim(),
      path: path.trim(),
      order: typeof order === "number" ? order : Number(order) || 0,
      visualOrder: typeof visualOrder === "number" ? visualOrder : Number(visualOrder) || 0,
    };
  }
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const type = row.imageTypeCode ?? row.type ?? row.category;
  const path = row.path ?? row.remotePath;
  if (typeof type !== "string" || typeof path !== "string") return null;
  const order = typeof row.order === "number" ? row.order : Number(row.order) || 0;
  const visual = row.visualOrder ?? row.visual_order;
  const visualOrder = typeof visual === "number" ? visual : Number(visual) || 0;
  return { type: type.trim(), path: path.trim(), order, visualOrder };
}

function typeRank(type: string): number {
  const index = TYPE_ORDER.indexOf(type as (typeof TYPE_ORDER)[number]);
  return index === -1 ? TYPE_ORDER.length + 1 : index;
}

/** Cover is the lowest-visualOrder GEN, else facade, else the first image. At most 12, at most 4 HAB. */
export function selectHotelbedsImages(images: readonly unknown[]): NormalizedHotelbeds[] {
  const cleaned: NormalizedHotelbeds[] = [];
  for (const value of images) {
    const image = normalizeHotelbedsImage(value);
    if (!image || !image.path || image.path.includes("..") || image.path.includes("://")) continue;
    cleaned.push(image);
  }
  cleaned.sort(
    (a, b) => a.visualOrder - b.visualOrder || a.order - b.order || a.path.localeCompare(b.path),
  );
  const cover =
    cleaned.find((image) => image.type === "GEN") ??
    cleaned.find((image) => image.type.toLowerCase() === "facade") ??
    cleaned[0];
  if (!cover) return [];
  const rest = cleaned.filter((image) => image.path !== cover.path);
  rest.sort(
    (a, b) =>
      typeRank(a.type) - typeRank(b.type) ||
      a.visualOrder - b.visualOrder ||
      a.order - b.order ||
      a.path.localeCompare(b.path),
  );
  const chosen = [cover];
  let hab = cover.type === "HAB" ? 1 : 0;
  for (const image of rest) {
    if (chosen.length >= HOTELBEDS_LIMIT) break;
    if (image.type === "HAB") {
      if (hab >= HAB_CAP) continue;
      hab += 1;
    }
    chosen.push(image);
  }
  return chosen;
}

export function hotelbedsMediaRows(hotelId: string, images: readonly unknown[]): HotelMediaInsert[] {
  return selectHotelbedsImages(images).map((image, position) => ({
    hotel_id: hotelId,
    source: "hotelbeds",
    source_media_key: image.path,
    storage_bucket: null,
    storage_path: null,
    remote_path: image.path,
    category: image.type,
    role: "gallery",
    position,
    width: 800,
    height: 533,
    alt_text: `${image.type} photograph`,
    credit: HOTELBEDS_CREDIT,
    rights_basis: PHOTO_RIGHTS_BASIS,
    status: "active",
  }));
}

export function forbesMediaRow(input: {
  hotelId: string;
  slug: string;
  position: number;
  fileName: string;
  width: number | null;
  height: number | null;
}): HotelMediaInsert | null {
  const base = forbesStorageBase(input.slug, input.position, input.fileName);
  const stem = fileStem(input.fileName);
  if (!base || !stem) return null;
  return {
    hotel_id: input.hotelId,
    source: "forbes",
    source_media_key: `${input.slug}/${stem}`,
    storage_bucket: "hotel-media",
    storage_path: base,
    remote_path: null,
    category: forbesAlt(input.slug, input.fileName).toLowerCase(),
    role: "gallery",
    position: input.position,
    width: input.width,
    height: input.height,
    alt_text: forbesAlt(input.slug, input.fileName),
    credit: FORBES_CREDIT,
    rights_basis: PHOTO_RIGHTS_BASIS,
    status: "active",
  };
}

export interface ForbesLinkPlan {
  source: "forbes";
  source_environment: "production";
  source_property_id: string;
  link_status: "active";
  match_method: "name_geo_auto" | "manual_review";
  match_evidence: {
    dist_km: number;
    name_sim: number;
    forbes_name: string;
    staging_name: string;
    scrape_vintage: typeof SCRAPE_VINTAGE;
    class: MatchRow["className"];
  };
  hotel_id: string;
}

export function forbesLinkPlan(row: MatchRow): ForbesLinkPlan {
  return {
    source: "forbes",
    source_environment: "production",
    source_property_id: row.forbesPropertyId,
    link_status: "active",
    match_method: row.className === "review" ? "manual_review" : "name_geo_auto",
    match_evidence: {
      dist_km: row.distKm,
      name_sim: row.nameSim,
      forbes_name: row.forbesName,
      staging_name: row.stagingName,
      scrape_vintage: SCRAPE_VINTAGE,
      class: row.className,
    },
    hotel_id: row.hotelId,
  };
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
