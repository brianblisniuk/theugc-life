/**
 * Upload Forbes XL photographs and link them to staging hotels.
 *
 *   npx tsx scripts/photos/forbes-upload.ts --dry-run \
 *     --match /workspace/photos/forbes_match_dryrun.csv \
 *     --gallery /workspace/forbes/data/hotels.jsonl \
 *     --images /workspace/forbes/images-xl
 *
 * Requires SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and
 * SUPABASE_SERVICE_ROLE_KEY for a real run. The key is never printed.
 * --dry-run prints counts and does not call the network.
 *
 * Install the encoder on the machine that uploads: npm install sharp
 * WebP is q78 at 1280 and 480. A local ledger (--ledger) skips paths already uploaded.
 *
 * Links use source_environment production (D065). scrape-2026-10 is match evidence.
 */
import { readFile, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import {
  callRpc,
  hiddenHotelMedia,
  inFilter,
  insertRows,
  requireServiceEnv,
  type ServiceEnv,
  restGet,
  uploadWebp,
  upsertRows,
  type RestClient,
} from "./http";
import {
  chunk,
  forbesLinkPlan,
  forbesMediaRow,
  forbesObjectPaths,
  forbesStorageBase,
  parseMatchCsv,
  selectMatches,
  type GalleryPhoto,
  type HotelMediaInsert,
} from "./plan";

interface GalleryLine {
  slug?: string;
  image_folder?: string;
  gallery_images?: { url?: string; local?: string; local_xl?: string }[];
}

export interface EncodeResult {
  w1280: Buffer;
  w480: Buffer;
  width: number;
  height: number;
}

export interface ForbesRunOptions {
  matchCsv: string;
  galleryJsonl: string;
  imagesRoot: string;
  ledgerPath: string;
  dryRun: boolean;
  env?: ServiceEnv;
  fetchImpl?: typeof fetch;
  readFileImpl?: (file: string) => Promise<Buffer>;
  encode?: (bytes: Buffer) => Promise<EncodeResult>;
  log?: (line: string) => void;
}

export interface ForbesRunResult {
  hotels: number;
  photos: number;
  uploaded: number;
  skippedLedger: number;
  skippedHidden: number;
  missingFiles: number;
  links: number;
  dryRun: boolean;
}

function fileNameOf(image: { url?: string; local?: string; local_xl?: string }): string {
  const source = image.local_xl || image.local || image.url || "";
  return source.split(/[/\\]/).pop() ?? "";
}

export function galleryPhotos(jsonl: string, imagesRoot: string): Map<string, GalleryPhoto[]> {
  const bySlug = new Map<string, GalleryPhoto[]>();
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: GalleryLine;
    try {
      parsed = JSON.parse(trimmed) as GalleryLine;
    } catch {
      continue;
    }
    const slug = parsed.image_folder || parsed.slug || "";
    if (!slug) continue;
    const photos: GalleryPhoto[] = [];
    (parsed.gallery_images ?? []).forEach((image, position) => {
      const fileName = fileNameOf(image);
      const relative = image.local_xl || image.local || "";
      photos.push({
        slug,
        position,
        fileName,
        absolutePath: relative
          ? path.isAbsolute(relative)
            ? relative
            : path.join(imagesRoot, relative)
          : null,
      });
    });
    bySlug.set(slug, photos);
  }
  return bySlug;
}

async function defaultEncode(bytes: Buffer): Promise<EncodeResult> {
  let sharp: (typeof import("sharp"))["default"];
  try {
    sharp = (await import("sharp")).default;
  } catch {
    throw new Error("sharp is not installed. Run npm install sharp on the upload machine.");
  }
  const image = sharp(bytes, { failOn: "none" });
  const w1280 = await image.resize({ width: 1280, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
  const again = sharp(bytes, { failOn: "none" });
  const w480 = await again.resize({ width: 480, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
  const meta = await sharp(w1280).metadata();
  return { w1280, w480, width: meta.width ?? 1280, height: meta.height ?? 720 };
}

async function pool<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item !== undefined) await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
}

async function loadLedger(ledgerPath: string, read: (file: string) => Promise<Buffer>): Promise<Set<string>> {
  try {
    const text = (await read(ledgerPath)).toString("utf8");
    const done = new Set<string>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { path?: string };
        if (parsed.path) done.add(parsed.path);
      } catch {
        /* skip a torn line */
      }
    }
    return done;
  } catch {
    return new Set();
  }
}

export async function runForbesUpload(options: ForbesRunOptions): Promise<ForbesRunResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const read = options.readFileImpl ?? ((file: string) => readFile(file));
  const match = parseMatchCsv((await read(options.matchCsv)).toString("utf8"));
  const chosen = selectMatches(match.rows).chosen;
  const gallery = galleryPhotos((await read(options.galleryJsonl)).toString("utf8"), options.imagesRoot);
  const ledger = options.dryRun ? new Set<string>() : await loadLedger(options.ledgerPath, read);
  const jobs: { photo: GalleryPhoto; hotelId: string; base: string }[] = [];
  let missingFiles = 0;
  for (const row of chosen) {
    for (const photo of gallery.get(row.forbesSlug) ?? []) {
      if (!forbesStorageBase(photo.slug, photo.position, photo.fileName)) continue;
      if (!photo.absolutePath) {
        missingFiles += 1;
        continue;
      }
      jobs.push({
        photo,
        hotelId: row.hotelId,
        base: forbesStorageBase(photo.slug, photo.position, photo.fileName)!,
      });
    }
  }
  const result: ForbesRunResult = {
    hotels: chosen.length,
    photos: jobs.length,
    uploaded: 0,
    skippedLedger: 0,
    skippedHidden: 0,
    missingFiles,
    links: chosen.length,
    dryRun: options.dryRun,
  };
  log(
    `forbes ${options.dryRun ? "dry-run" : "upload"} hotels=${result.hotels} photos=${result.photos} links=${result.links} missing=${missingFiles}`,
  );
  if (options.dryRun) return result;

  const { url, key } = requireServiceEnv(options.env);
  const client: RestClient = { url, key, fetchImpl: options.fetchImpl ?? fetch };
  const encode = options.encode ?? defaultEncode;
  const rows: HotelMediaInsert[] = [];
  const hidden = await hiddenHotelMedia(
    client,
    "forbes",
    jobs.map((job) => job.hotelId),
  );
  await mkdir(path.dirname(options.ledgerPath), { recursive: true });
  await pool(jobs, 8, async (job) => {
    if (hidden.paths.has(job.base)) {
      result.skippedHidden += 1;
      return;
    }
    const objects = forbesObjectPaths(job.base);
    if (ledger.has(objects.w1280) && ledger.has(objects.w480)) {
      result.skippedLedger += 1;
      rows.push(
        forbesMediaRow({
          hotelId: job.hotelId,
          slug: job.photo.slug,
          position: job.photo.position,
          fileName: job.photo.fileName,
          width: null,
          height: null,
        })!,
      );
      return;
    }
    if (!job.photo.absolutePath) return;
    let bytes: Buffer;
    try {
      bytes = await read(job.photo.absolutePath);
    } catch {
      result.missingFiles += 1;
      return;
    }
    const encoded = await encode(bytes);
    await uploadWebp(client, objects.w1280, encoded.w1280);
    await uploadWebp(client, objects.w480, encoded.w480);
    await appendFile(options.ledgerPath, `${JSON.stringify({ path: objects.w1280 })}\n${JSON.stringify({ path: objects.w480 })}\n`);
    result.uploaded += 1;
    const row = forbesMediaRow({
      hotelId: job.hotelId,
      slug: job.photo.slug,
      position: job.photo.position,
      fileName: job.photo.fileName,
      width: encoded.width,
      height: encoded.height,
    });
    if (row) rows.push(row);
  });

  for (const batch of chunk(rows, 500)) {
    await upsertRows(client, "hotel_media", "hotel_id,source,source_media_key", batch, "ignore-duplicates");
  }
  const hotelIds = [...new Set(rows.map((row) => row.hotel_id))];
  for (const batch of chunk(hotelIds, 500)) {
    await callRpc(client, "promote_hotel_covers", { p_hotel_ids: batch });
  }
  await writeForbesLinks(client, chosen);
  log(
    `forbes uploaded=${result.uploaded} skipped=${result.skippedLedger} hidden=${result.skippedHidden} missing=${result.missingFiles}`,
  );
  return result;
}

async function writeForbesLinks(client: RestClient, chosen: ReturnType<typeof selectMatches>["chosen"]): Promise<void> {
  const runId = crypto.randomUUID();
  await insertRows(client, "source_runs", [
    {
      id: runId,
      source: "forbes",
      source_environment: "production",
      run_mode: "full",
      run_status: "completed",
      completed_at: new Date().toISOString(),
      notes:
        "Forbes scrape-2026-10. Environment is production because D065 forbids any other link environment.",
      provider_geography: { scrape_vintage: "scrape-2026-10" },
    },
  ]);
  const identities = chosen.map((row) => ({
    source: "forbes",
    source_environment: "production",
    source_property_id: row.forbesPropertyId,
    source_url: null,
    first_seen_run_id: runId,
    last_seen_run_id: runId,
    resolution_state: "unresolved",
  }));
  for (const batch of chunk(identities, 500)) {
    await upsertRows(
      client,
      "source_property_identities",
      "source,source_environment,source_property_id",
      batch,
      "ignore-duplicates",
    );
  }
  const propertyIds = chosen.map((row) => row.forbesPropertyId);
  const found: { id: string; source_property_id: string }[] = [];
  for (const batch of chunk(propertyIds, 100)) {
    const payload = (await restGet(
      client,
      `/rest/v1/source_property_identities?select=id,source_property_id&source=eq.forbes&source_environment=eq.production&source_property_id=${inFilter(batch)}`,
    )) as { id: string; source_property_id: string }[];
    found.push(...payload);
  }
  const idByProperty = new Map(found.map((row) => [row.source_property_id, row.id]));
  const links = chosen.flatMap((row) => {
    const identityId = idByProperty.get(row.forbesPropertyId);
    if (!identityId) return [];
    const plan = forbesLinkPlan(row);
    return [
      {
        hotel_id: plan.hotel_id,
        source_property_identity_id: identityId,
        source: plan.source,
        source_environment: plan.source_environment,
        source_property_id: plan.source_property_id,
        link_status: plan.link_status,
        match_method: plan.match_method,
        match_evidence: plan.match_evidence,
      },
    ];
  });
  for (const batch of chunk(links, 500)) {
    await upsertRows(
      client,
      "hotel_source_identities",
      "source_property_identity_id,hotel_id",
      batch,
      "merge-duplicates",
    );
  }
}

function arg(name: string, argv: readonly string[]): string | null {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : null;
  return value && !value.startsWith("--") ? value : null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const matchCsv = arg("--match", argv);
  const galleryJsonl = arg("--gallery", argv);
  const imagesRoot = arg("--images", argv) ?? "";
  if (!matchCsv || !galleryJsonl) {
    throw new Error("Usage: tsx scripts/photos/forbes-upload.ts --match <csv> --gallery <jsonl> [--images <dir>] [--ledger <jsonl>] [--dry-run]");
  }
  await runForbesUpload({
    matchCsv,
    galleryJsonl,
    imagesRoot,
    ledgerPath: arg("--ledger", argv) ?? path.join(process.cwd(), "uploaded.jsonl"),
    dryRun: argv.includes("--dry-run"),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("forbes-upload.ts")) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "forbes upload failed";
    console.error(message);
    process.exit(1);
  });
}
