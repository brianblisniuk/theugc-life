/**
 * Insert up to 12 Hotelbeds image paths per staging hotel. No bytes are copied.
 *
 *   npx tsx scripts/photos/hotelbeds-load.ts --dry-run \
 *     --images /workspace/photos/hb_images_staging.json
 *
 * The JSON is { hotelbeds_code: [ image objects or [type, path, order, visualOrder] ] }.
 * Cover preference is GEN, then facade. SUPABASE_SERVICE_ROLE_KEY is required
 * for a real run and is never printed. --dry-run does not call the network.
 *
 * These paths come from the Hotelbeds evaluation environment. D189 records that
 * caveat. A live contract may impose other terms.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  callRpc,
  hiddenHotelMedia,
  inFilter,
  requireServiceEnv,
  restGet,
  upsertRows,
  type RestClient,
  type ServiceEnv,
} from "./http";
import { chunk, hotelbedsMediaRows, selectHotelbedsImages, type HotelMediaInsert } from "./plan";

export interface HotelbedsRunOptions {
  imagesJson: string;
  dryRun: boolean;
  env?: ServiceEnv;
  fetchImpl?: typeof fetch;
  readFileImpl?: (file: string) => Promise<Buffer>;
  log?: (line: string) => void;
}

export interface HotelbedsRunResult {
  codes: number;
  matchedHotels: number;
  photos: number;
  skippedHidden: number;
  unmatched: number;
  dryRun: boolean;
}

export function parseHotelbedsDocument(text: string): Map<string, unknown[]> {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Hotelbeds JSON must be an object of code to image list");
  }
  const out = new Map<string, unknown[]>();
  for (const [code, images] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[0-9A-Za-z_-]{1,32}$/.test(code)) continue;
    if (!Array.isArray(images)) continue;
    out.set(code, images);
  }
  return out;
}

export async function runHotelbedsLoad(options: HotelbedsRunOptions): Promise<HotelbedsRunResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const read = options.readFileImpl ?? ((file: string) => readFile(file));
  const document = parseHotelbedsDocument((await read(options.imagesJson)).toString("utf8"));
  let photos = 0;
  for (const images of document.values()) photos += selectHotelbedsImages(images).length;
  const result: HotelbedsRunResult = {
    codes: document.size,
    matchedHotels: 0,
    photos,
    skippedHidden: 0,
    unmatched: document.size,
    dryRun: options.dryRun,
  };
  log(`hotelbeds ${options.dryRun ? "dry-run" : "load"} codes=${result.codes} photos=${result.photos}`);
  if (options.dryRun) return result;

  const { url, key } = requireServiceEnv(options.env);
  const client: RestClient = { url, key, fetchImpl: options.fetchImpl ?? fetch };
  const codeToHotel = new Map<string, string>();
  for (const batch of chunk([...document.keys()], 100)) {
    const rows = (await restGet(
      client,
      `/rest/v1/hotels?select=id,hotelbeds_code&hotelbeds_code=${inFilter(batch)}`,
    )) as { id?: string; hotelbeds_code?: string }[];
    for (const row of rows) {
      if (row.id && row.hotelbeds_code) codeToHotel.set(row.hotelbeds_code, row.id);
    }
  }
  const inserts: HotelMediaInsert[] = [];
  for (const [code, images] of document) {
    const hotelId = codeToHotel.get(code);
    if (!hotelId) continue;
    inserts.push(...hotelbedsMediaRows(hotelId, images));
  }
  const hidden = await hiddenHotelMedia(
    client,
    "hotelbeds",
    [...new Set(inserts.map((row) => row.hotel_id))],
  );
  const visible = inserts.filter(
    (row) => !hidden.keys.has(`${row.hotel_id}\n${row.source_media_key}`),
  );
  result.matchedHotels = new Set(visible.map((row) => row.hotel_id)).size;
  result.unmatched = document.size - codeToHotel.size;
  result.skippedHidden = inserts.length - visible.length;
  result.photos = visible.length;
  for (const batch of chunk(visible, 500)) {
    await upsertRows(client, "hotel_media", "hotel_id,source,source_media_key", batch, "ignore-duplicates");
  }
  const hotelIds = [...new Set(visible.map((row) => row.hotel_id))];
  for (const batch of chunk(hotelIds, 500)) {
    await callRpc(client, "promote_hotel_covers", { p_hotel_ids: batch });
  }
  log(`hotelbeds hotels=${result.matchedHotels} photos=${result.photos} unmatched=${result.unmatched}`);
  return result;
}

function arg(name: string, argv: readonly string[]): string | null {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : null;
  return value && !value.startsWith("--") ? value : null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const imagesJson = arg("--images", argv);
  if (!imagesJson) {
    throw new Error("Usage: tsx scripts/photos/hotelbeds-load.ts --images <json> [--dry-run]");
  }
  await runHotelbedsLoad({ imagesJson, dryRun: argv.includes("--dry-run") });
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("hotelbeds-load.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "hotelbeds load failed");
    process.exit(1);
  });
}
