/**
 * Persistent-target preflight + safety guard (SPRINT_1C_PERSISTENT_PREFLIGHT.md).
 *
 * A real canonical `import:promote --apply` must target a DELIBERATE remote
 * persistent database. This module provides:
 *
 *  - `classifyDatabaseUrl` — parse a connection string into a NON-SECRET
 *    classification (host class, db name, ssl mode). It never returns the
 *    username, password, or full URL.
 *  - `assertPersistentApplyTarget` — the guard the apply CLI uses: require an
 *    explicit `DATABASE_URL` (NEVER fall back to `TEST_DATABASE_URL`) and refuse
 *    localhost / loopback / local-Supabase targets.
 *  - `runPreflight` — a read-only inspection of a target (schema readiness,
 *    aggregate baseline counts, UAE/Dubai destination readiness). No PII.
 *
 * Nothing here logs secrets or raw contact data.
 */
import type { Client } from "pg";

export type HostClass =
  "loopback" | "localhost" | "local-supabase" | "private-network" | "remote" | "unknown";

export interface TargetClassification {
  /** Whether a non-empty connection string was provided. */
  present: boolean;
  /** True only for a genuine remote (public) host. */
  isRemote: boolean;
  hostClass: HostClass;
  /** Safe to display: database name (never a credential). */
  databaseName: string | null;
  /** e.g. "require", "verify-full", or null when unspecified. */
  sslMode: string | null;
  /** Non-secret one-liner: host CLASS + db + ssl. Never the host, user, or pass. */
  redactedTarget: string;
}

export class PersistentTargetError extends Error {}

const LOCAL_SUPABASE_PORT = "54322";

function classifyHost(host: string, port: string | null): HostClass {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "127.0.0.1" || h === "::1" || h === "0.0.0.0") {
    return port === LOCAL_SUPABASE_PORT ? "local-supabase" : "loopback";
  }
  if (h === "localhost" || h.endsWith(".localhost")) {
    return port === LOCAL_SUPABASE_PORT ? "local-supabase" : "localhost";
  }
  // Local Supabase docker service names.
  if (h.startsWith("supabase_db_") || h === "db" || h === "kong") return "local-supabase";
  // Private / non-routable ranges and mDNS — treated as local, not persistent.
  if (h.endsWith(".local")) return "private-network";
  if (/^10\./.test(h)) return "private-network";
  if (/^192\.168\./.test(h)) return "private-network";
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return "private-network";
  if (/^169\.254\./.test(h)) return "private-network";
  return "remote";
}

/** Parse host/port/db/ssl from a URL- or libpq-DSN-style connection string. */
function parseConnection(raw: string): {
  host: string | null;
  port: string | null;
  db: string | null;
  ssl: string | null;
} {
  const trimmed = raw.trim();
  // URL form: postgres(ql)://user:pass@host:port/db?sslmode=...
  if (/^postgres(ql)?:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      const db = decodeURIComponent(u.pathname.replace(/^\//, "")) || null;
      const ssl = u.searchParams.get("sslmode") ?? u.searchParams.get("ssl");
      return { host: u.hostname || null, port: u.port || null, db, ssl };
    } catch {
      // Fall through to token parsing (e.g. password with unescaped chars).
    }
  }
  // libpq DSN form: host=... port=... dbname=... sslmode=...
  const pick = (key: string): string | null => {
    const m = trimmed.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`, "i"));
    return m ? m[1]! : null;
  };
  return {
    host: pick("host"),
    port: pick("port"),
    db: pick("dbname") ?? pick("database"),
    ssl: pick("sslmode"),
  };
}

/**
 * Classify a connection string WITHOUT exposing any secret. Returns
 * `present:false` for an empty/undefined string.
 */
export function classifyDatabaseUrl(rawUrl: string | undefined | null): TargetClassification {
  if (!rawUrl || rawUrl.trim().length === 0) {
    return {
      present: false,
      isRemote: false,
      hostClass: "unknown",
      databaseName: null,
      sslMode: null,
      redactedTarget: "(absent)",
    };
  }
  const { host, port, db, ssl } = parseConnection(rawUrl);
  const hostClass: HostClass = host ? classifyHost(host, port) : "unknown";
  const isRemote = hostClass === "remote";
  const redactedTarget = `class=${hostClass} db=${db ?? "?"} ssl=${ssl ?? "unset"}`;
  return {
    present: true,
    isRemote,
    hostClass,
    databaseName: db,
    sslMode: ssl,
    redactedTarget,
  };
}

/**
 * Guard for the real-apply CLI path. Requires an explicit `DATABASE_URL` and a
 * genuine remote target. NEVER reads or falls back to `TEST_DATABASE_URL`.
 */
export function assertPersistentApplyTarget(env: Record<string, string | undefined>): {
  url: string;
  classification: TargetClassification;
} {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    throw new PersistentTargetError(
      "DATABASE_URL is required for a real --apply. Refusing to fall back to TEST_DATABASE_URL.",
    );
  }
  const classification = classifyDatabaseUrl(url);
  if (!classification.isRemote) {
    throw new PersistentTargetError(
      `Refusing real --apply against a non-remote target (${classification.redactedTarget}). ` +
        "An approved remote persistent database is required.",
    );
  }
  return { url, classification };
}

// --- Read-only remote inspection ------------------------------------------

/** Objects whose presence proves the Sprint 0–1C schema is applied. */
const REQUIRED_TABLES = [
  "destinations",
  "destination_aliases",
  "hotels",
  "hotel_contacts",
  "editorial_evidence",
  "outreach_events",
  "hotel_intelligence",
  "destination_intelligence",
  "import_batches",
  "import_rows",
  "import_row_links",
  "import_match_candidates",
  "import_property_reviews",
  "import_row_reviews",
] as const;

/** Sprint 1B columns on hotel_contacts that must exist. */
const REQUIRED_HOTEL_CONTACT_COLUMNS = [
  "display_name",
  "verification_status",
  "organization_name",
] as const;

const BASELINE_COUNT_TABLES = [
  "destinations",
  "hotels",
  "hotel_contacts",
  "editorial_evidence",
  "outreach_events",
  "hotel_intelligence",
  "destination_intelligence",
  "import_batches",
] as const;

export interface DestinationReadiness {
  uaeOk: boolean;
  dubaiOk: boolean;
  detail: string;
}

export interface PreflightResult {
  schemaReady: boolean;
  missing: string[];
  baselineCounts: Record<string, number>;
  destinations: DestinationReadiness;
}

/** Read-only preflight inspection. Performs NO writes and returns no PII. */
export async function runPreflight(client: Client): Promise<PreflightResult> {
  const missing: string[] = [];

  const tableRes = await client.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public'",
  );
  const present = new Set(tableRes.rows.map((r) => r.table_name));
  for (const t of REQUIRED_TABLES) if (!present.has(t)) missing.push(`table:${t}`);

  if (present.has("hotel_contacts")) {
    const colRes = await client.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema='public' and table_name='hotel_contacts'",
    );
    const cols = new Set(colRes.rows.map((r) => r.column_name));
    for (const c of REQUIRED_HOTEL_CONTACT_COLUMNS)
      if (!cols.has(c)) missing.push(`column:hotel_contacts.${c}`);
  }

  // Sprint 1C uniqueness backstop (migration 0017).
  const idxRes = await client.query<{ indexname: string }>(
    "select indexname from pg_indexes where schemaname='public' and indexname = 'import_rows_one_property_per_key_uidx'",
  );
  if (idxRes.rows.length === 0) missing.push("index:import_rows_one_property_per_key_uidx");

  const schemaReady = missing.length === 0;

  const baselineCounts: Record<string, number> = {};
  if (schemaReady) {
    for (const t of BASELINE_COUNT_TABLES) {
      const r = await client.query<{ n: string }>(`select count(*)::text n from public.${t}`);
      baselineCounts[t] = Number(r.rows[0]!.n);
    }
  }

  const destinations = await inspectDestinations(client, present);

  return { schemaReady, missing, baselineCounts, destinations };
}

async function inspectDestinations(
  client: Client,
  present: Set<string>,
): Promise<DestinationReadiness> {
  if (!present.has("destinations")) {
    return { uaeOk: false, dubaiOk: false, detail: "destinations table missing" };
  }
  const res = await client.query<{
    slug: string;
    type: string;
    country_code: string | null;
    parent_slug: string | null;
  }>(
    `select d.slug, d.type, d.country_code, p.slug as parent_slug
       from public.destinations d
       left join public.destinations p on p.id = d.parent_destination_id
      where d.slug in ('united-arab-emirates','dubai')`,
  );
  const uae = res.rows.find((r) => r.slug === "united-arab-emirates");
  const dubai = res.rows.find((r) => r.slug === "dubai");
  const uaeOk = !!uae && uae.type === "country" && uae.country_code === "AE";
  const dubaiOk =
    !!dubai &&
    dubai.type === "city" &&
    dubai.country_code === "AE" &&
    dubai.parent_slug === "united-arab-emirates";
  const detail =
    `uae=${uae ? `${uae.type}/${uae.country_code}` : "missing"} ` +
    `dubai=${dubai ? `${dubai.type}/${dubai.country_code}/parent:${dubai.parent_slug ?? "none"}` : "missing"}`;
  return { uaeOk, dubaiOk, detail };
}
