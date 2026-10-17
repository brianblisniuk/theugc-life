/**
 * Storage and PostgREST calls for the photo loaders.
 * The service-role key is a header only. It is never written to a URL or a log.
 */

export interface RestClient {
  url: string;
  key: string;
  fetchImpl: typeof fetch;
}

export function scrub(message: string, secret: string): string {
  if (!secret) return message;
  return message.split(secret).join("[redacted]");
}

/** The three variables the loaders read. A test can pass a partial object. */
export interface ServiceEnv {
  SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

export function requireServiceEnv(env?: ServiceEnv): { url: string; key: string } {
  const source: ServiceEnv = env ?? {
    SUPABASE_URL: process.env.SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  const url = source.SUPABASE_URL?.trim() || source.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const key = source.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. Neither value is printed.");
  }
  return { url: url.replace(/\/$/, ""), key };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function request(
  client: RestClient,
  path: string,
  init: RequestInit,
  attempts = 4,
): Promise<Response> {
  let last = "request failed";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await client.fetchImpl(`${client.url}${path}`, {
        ...init,
        headers: {
          apikey: client.key,
          authorization: `Bearer ${client.key}`,
          ...(init.headers ?? {}),
        },
      });
      if (response.ok || (response.status < 500 && response.status !== 429)) return response;
      last = `HTTP ${response.status} ${path}`;
    } catch (error) {
      last = scrub(error instanceof Error ? error.message : "network error", client.key);
    }
    await sleep(200 * 2 ** attempt);
  }
  throw new Error(scrub(last, client.key));
}

/**
 * Uploads one WebP. `x-upsert` replaces bytes at this public path.
 * Callers must not use it for a hidden catalog row. Hiding moves that object
 * out of this bucket, and an upsert would publish a new public file.
 */
export async function uploadWebp(client: RestClient, objectPath: string, body: Buffer): Promise<void> {
  const response = await request(client, `/storage/v1/object/hotel-media/${objectPath}`, {
    method: "POST",
    headers: {
      "content-type": "image/webp",
      "x-upsert": "true",
    },
    body: new Uint8Array(body),
  });
  if (!response.ok) {
    throw new Error(`Upload failed HTTP ${response.status} for ${objectPath}`);
  }
}

export async function insertRows(
  client: RestClient,
  table: string,
  rows: readonly unknown[],
): Promise<unknown[]> {
  if (rows.length === 0) return [];
  const response = await request(client, `/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      prefer: "return=representation",
    },
    body: JSON.stringify(rows),
  });
  if (!response.ok) throw new Error(`Insert ${table} failed HTTP ${response.status}`);
  const payload = (await response.json()) as unknown;
  return Array.isArray(payload) ? payload : [];
}

export async function callRpc(client: RestClient, name: string, args: unknown): Promise<void> {
  const response = await request(client, `/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`RPC ${name} failed HTTP ${response.status}`);
}

export function inFilter(values: readonly string[]): string {
  return `in.(${values.map((value) => `"${encodeURIComponent(value)}"`).join(",")})`;
}

export async function upsertRows(
  client: RestClient,
  table: string,
  onConflict: string,
  rows: readonly unknown[],
  resolution: "ignore-duplicates" | "merge-duplicates",
): Promise<unknown[]> {
  if (rows.length === 0) return [];
  const response = await request(
    client,
    `/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        prefer: `resolution=${resolution},return=representation`,
      },
      body: JSON.stringify(rows),
    },
  );
  if (!response.ok) {
    throw new Error(`Upsert ${table} failed HTTP ${response.status}`);
  }
  const payload = (await response.json()) as unknown;
  return Array.isArray(payload) ? payload : [];
}

export async function restGet(client: RestClient, path: string): Promise<unknown> {
  const response = await request(client, path, { method: "GET" });
  if (!response.ok) throw new Error(`GET failed HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

/** PostgREST `max_rows`. A full page is not the end of the list. */
const HIDDEN_PAGE_SIZE = 1000;

function hiddenMarker(row: {
  hotel_id?: unknown;
  source_media_key?: unknown;
  storage_path?: unknown;
}): string {
  return `${String(row.hotel_id)}\n${String(row.source_media_key)}\n${String(row.storage_path)}`;
}

/**
 * Every hidden row for this filter. Pages with Range and limit until a short
 * page. A failed read, a non-list body, or a page that does not move forward
 * throws, so the importer does not upload.
 */
async function readHiddenPages(client: RestClient, filterPath: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (;;) {
    const path = `${filterPath}&order=id.asc&limit=${HIDDEN_PAGE_SIZE}&offset=${offset}`;
    const response = await request(client, path, {
      method: "GET",
      headers: {
        Range: `${offset}-${offset + HIDDEN_PAGE_SIZE - 1}`,
        "Range-Unit": "items",
      },
    });
    if (!response.ok) {
      throw new Error(`hidden hotel_media read failed HTTP ${response.status}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("hidden hotel_media response was not a list");
    }
    if (!Array.isArray(payload)) throw new Error("hidden hotel_media response was not a list");
    if (payload.length > HIDDEN_PAGE_SIZE) {
      throw new Error("hidden hotel_media page was longer than the limit");
    }
    const contentRange = response.headers.get("content-range");
    if (contentRange && payload.length > 0 && !contentRange.startsWith(`${offset}-`)) {
      throw new Error("hidden hotel_media page range did not match");
    }
    let advanced = false;
    for (const row of payload) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new Error("hidden hotel_media row was not an object");
      }
      const marker = hiddenMarker(
        row as { hotel_id?: unknown; source_media_key?: unknown; storage_path?: unknown },
      );
      if (!seen.has(marker)) {
        seen.add(marker);
        advanced = true;
      }
      rows.push(row);
    }
    if (payload.length === HIDDEN_PAGE_SIZE && !advanced) {
      throw new Error("hidden hotel_media page did not advance");
    }
    if (payload.length < HIDDEN_PAGE_SIZE) return rows;
    offset += HIDDEN_PAGE_SIZE;
  }
}

function collectHidden(
  payload: readonly unknown[],
  keys: Set<string>,
  paths: Set<string>,
): void {
  for (const row of payload) {
    const record = row as {
      hotel_id?: unknown;
      source_media_key?: unknown;
      storage_path?: unknown;
    };
    if (typeof record.hotel_id === "string" && typeof record.source_media_key === "string") {
      keys.add(`${record.hotel_id}\n${record.source_media_key}`);
    }
    if (typeof record.storage_path === "string" && record.storage_path.length > 0) {
      paths.add(record.storage_path);
    }
  }
}

/**
 * Hidden catalog rows for these hotels. A failed read throws, so the importer
 * does not upload. Keys are `hotelId\\nsource_media_key`. Paths are Forbes bases.
 */
export async function hiddenHotelMedia(
  client: RestClient,
  source: "forbes" | "hotelbeds",
  hotelIds: readonly string[],
): Promise<{ keys: Set<string>; paths: Set<string> }> {
  const keys = new Set<string>();
  const paths = new Set<string>();
  const unique = [...new Set(hotelIds)];
  for (let index = 0; index < unique.length; index += 80) {
    const batch = unique.slice(index, index + 80);
    const payload = await readHiddenPages(
      client,
      `/rest/v1/hotel_media?select=hotel_id,source_media_key,storage_path&source=eq.${source}&status=eq.hidden&hotel_id=${inFilter(batch)}`,
    );
    collectHidden(payload, keys, paths);
  }
  return { keys, paths };
}

/**
 * Forbes storage paths in this batch whose catalog row is hidden.
 * Checked again immediately before a public upload. A failed read throws.
 */
export async function hiddenForbesStoragePaths(
  client: RestClient,
  storagePaths: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  const unique = [...new Set(storagePaths.filter((storagePath) => storagePath.length > 0))];
  for (let index = 0; index < unique.length; index += 80) {
    const batch = unique.slice(index, index + 80);
    const wanted = new Set(batch);
    const payload = await readHiddenPages(
      client,
      `/rest/v1/hotel_media?select=hotel_id,source_media_key,storage_path&source=eq.forbes&status=eq.hidden&storage_path=${inFilter(batch)}`,
    );
    for (const row of payload) {
      const storagePath = (row as { storage_path?: unknown }).storage_path;
      if (typeof storagePath === "string" && wanted.has(storagePath)) found.add(storagePath);
    }
  }
  return found;
}
