/**
 * Load canonical hotels, plan the Hotelbeds import, write the review CSV,
 * and — only when asked — upsert rows keyed on the Hotelbeds code.
 *
 * `--apply` is refused for a remote database. This module does not call the
 * Hotelbeds API and does not read API credentials.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Client } from "pg";

import { generateSlug } from "../../src/lib/canonical/slug";
import { classifyDatabaseUrl, type HostClass } from "../../src/lib/import/preflight";
import { foldForMatch } from "../../src/lib/import/normalize";

import { renderMatchesCsv } from "./csv";
import { readHotelbedsPages } from "./parse";
import {
  buildPatch,
  planHotelbedsImport,
  reviewMatches,
  type CanonicalHotel,
  type DestinationHit,
  type EligibleHotel,
  type HotelPatch,
  type HotelbedsPlan,
  type PlannedHotel,
} from "./plan";

const LOCAL_APPLY_HOSTS = new Set<HostClass>([
  "loopback",
  "localhost",
  "local-supabase",
  "container-bridge",
]);

export class HotelbedsApplyRefused extends Error {}

/**
 * `--apply` may write a local database only. A remote host is production as
 * far as this import is concerned, and this block does not change production.
 */
export function assertHotelbedsApplyIsLocal(connectionString: string | undefined): void {
  const classification = classifyDatabaseUrl(connectionString);
  if (!LOCAL_APPLY_HOSTS.has(classification.hostClass)) {
    throw new HotelbedsApplyRefused(
      `Hotelbeds --apply refuses this database (${classification.redactedTarget}). No production changes.`,
    );
  }
}

export interface HotelbedsReport {
  apply: boolean;
  records: number;
  inserts: number;
  upserts: number;
  reviews: number;
  skips: number;
  matches: number;
  matchesOut: string;
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

async function loadExisting(client: Client): Promise<CanonicalHotel[]> {
  const result = await client.query<{
    id: string;
    name: string;
    latitude: string | number | null;
    longitude: string | number | null;
    website_url: string | null;
    star_rating_source: string | null;
    hotelbeds_code: string | null;
  }>(
    `select id::text, name, latitude, longitude, website_url, star_rating_source, hotelbeds_code
       from public.hotels`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    latitude: asNumber(row.latitude),
    longitude: asNumber(row.longitude),
    websiteUrl: row.website_url,
    starRatingSource: row.star_rating_source,
    hotelbedsCode: row.hotelbeds_code,
  }));
}

async function loadDestinations(client: Client): Promise<Map<string, DestinationHit[]>> {
  const result = await client.query<{
    normalized_alias: string;
    destination_id: string;
    slug: string;
    country_code: string | null;
  }>(
    `select a.normalized_alias, d.id::text as destination_id, d.slug, d.country_code
       from public.destination_aliases a
       join public.destinations d on d.id = a.destination_id
      where a.is_active and a.source = 'hotelbeds'`,
  );
  const destinations = new Map<string, DestinationHit[]>();
  for (const row of result.rows) {
    const key = foldForMatch(row.normalized_alias);
    if (key === "") continue;
    const hit: DestinationHit = {
      id: row.destination_id,
      slug: row.slug,
      countryCode: row.country_code,
    };
    const list = destinations.get(key) ?? [];
    list.push(hit);
    destinations.set(key, list);
  }
  return destinations;
}

async function lockByCode(client: Client, code: string): Promise<CanonicalHotel | null> {
  const result = await client.query<{
    id: string;
    name: string;
    latitude: string | number | null;
    longitude: string | number | null;
    website_url: string | null;
    star_rating_source: string | null;
    hotelbeds_code: string | null;
  }>(
    `select id::text, name, latitude, longitude, website_url, star_rating_source, hotelbeds_code
       from public.hotels
      where hotelbeds_code = $1
      for update`,
    [code],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    latitude: asNumber(row.latitude),
    longitude: asNumber(row.longitude),
    websiteUrl: row.website_url,
    starRatingSource: row.star_rating_source,
    hotelbedsCode: row.hotelbeds_code,
  };
}

async function applyPatch(client: Client, patch: HotelPatch): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [patch.hotelId, patch.hotelbedsCode];
  const add = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.name !== null) add("name", patch.name);
  if (patch.starRating !== null) add("star_rating", patch.starRating);
  if (patch.setProvenance) {
    add("star_rating_source", "hotelbeds");
    add("star_rating_confidence", "provisional");
  }
  if (patch.latitude !== null && patch.longitude !== null) {
    add("latitude", patch.latitude);
    add("longitude", patch.longitude);
  }
  if (patch.websiteUrl !== null) add("website_url", patch.websiteUrl);
  if (patch.needsCategoryReview !== null) add("needs_category_review", patch.needsCategoryReview);
  if (patch.hotelType !== null) add("hotel_type", patch.hotelType);
  if (sets.length === 0) return;
  await client.query(
    `update public.hotels
        set ${sets.join(", ")}
      where id = $1::uuid
        and hotelbeds_code = $2`,
    params,
  );
}

async function insertHotel(
  client: Client,
  eligible: EligibleHotel,
  destination: DestinationHit,
): Promise<void> {
  const slug = await generateSlug(
    client,
    eligible.name,
    destination.slug,
    `hotelbeds:${eligible.code}`,
  );
  try {
    await client.query(
      `insert into public.hotels
         (name, slug, destination_id, country_code, latitude, longitude, website_url,
          hotel_type, star_rating, star_rating_source, star_rating_confidence,
          needs_category_review, hotelbeds_code, active_status)
       values ($1, $2, $3::uuid, $4, $5, $6, $7, 'hotel', $8, 'hotelbeds', 'provisional',
               $9, $10, 'unknown')`,
      [
        eligible.name,
        slug,
        destination.id,
        destination.countryCode,
        eligible.latitude,
        eligible.longitude,
        eligible.websiteUrl,
        eligible.starRating,
        eligible.needsCategoryReview,
        eligible.code,
      ],
    );
  } catch (err) {
    const conflict = err as { code?: string; constraint?: string };
    if (conflict.code === "23505" && conflict.constraint === "hotels_hotelbeds_code_uidx") {
      const locked = await lockByCode(client, eligible.code);
      if (!locked) throw err;
      await applyPatch(client, buildPatch(locked, eligible));
      return;
    }
    throw err;
  }
}

async function applyPlan(client: Client, plan: HotelbedsPlan): Promise<void> {
  await client.query("begin");
  try {
    for (const item of plan.items) {
      if (item.kind === "skip" || item.kind === "review") continue;
      const locked = await lockByCode(client, item.eligible.code);
      if (locked) {
        await applyPatch(client, buildPatch(locked, item.eligible));
        continue;
      }
      if (item.kind === "insert") {
        await insertHotel(client, item.eligible, item.destination);
      }
    }
    await client.query("commit");
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      /* the original error is the one to report */
    }
    throw err;
  }
}

function countKind(items: PlannedHotel[], kind: PlannedHotel["kind"]): number {
  return items.filter((item) => item.kind === kind).length;
}

export async function runHotelbedsImport(options: {
  client: Client;
  rawDir: string;
  apply: boolean;
  matchesOut: string;
}): Promise<HotelbedsReport> {
  const raws = await readHotelbedsPages(options.rawDir);
  const [existing, destinations] = await Promise.all([
    loadExisting(options.client),
    loadDestinations(options.client),
  ]);
  const plan = planHotelbedsImport(raws, existing, destinations);
  const matches = reviewMatches(plan);
  await mkdir(path.dirname(options.matchesOut), { recursive: true });
  await writeFile(options.matchesOut, renderMatchesCsv(matches), "utf8");
  if (options.apply) await applyPlan(options.client, plan);
  return {
    apply: options.apply,
    records: raws.length,
    inserts: countKind(plan.items, "insert"),
    upserts: countKind(plan.items, "upsert"),
    reviews: countKind(plan.items, "review"),
    skips: countKind(plan.items, "skip"),
    matches: matches.length,
    matchesOut: options.matchesOut,
  };
}
