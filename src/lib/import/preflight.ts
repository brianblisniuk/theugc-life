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
import { readdir } from "node:fs/promises";

import type { Client } from "pg";

export type HostClass =
  | "loopback"
  | "localhost"
  | "local-supabase"
  | "container-bridge"
  | "private-network"
  | "remote"
  | "unknown";

/**
 * Container/VM bridge aliases that resolve to the developer host from inside a
 * container. A real --apply must never reach a developer-host Postgres through
 * one of these (review fix PF3). Lexical/deterministic — no DNS resolution.
 */
const CONTAINER_BRIDGE_HOSTS = new Set([
  "host.docker.internal",
  "gateway.docker.internal",
  "host.containers.internal",
]);

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
  // Container/VM bridge aliases to the developer host (PF3).
  if (CONTAINER_BRIDGE_HOSTS.has(h)) return "container-bridge";
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

/**
 * The repository's migration version identifiers — the numeric prefix of each
 * `supabase/migrations/NNNN_*.sql` file (e.g. "0001" … "0017"). These are what
 * the Supabase CLI records in `supabase_migrations.schema_migrations` when the
 * canonical `supabase db push` deploys them. Read-only fs access.
 */
export async function readRepoMigrationVersions(migrationsDir: string): Promise<string[]> {
  const files = await readdir(migrationsDir);
  const versions = files
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .map((f) => f.slice(0, f.indexOf("_")));
  return [...new Set(versions)].sort();
}

// --- Safe error categorization (PF1) --------------------------------------

export type PreflightFailureCode =
  | "PERSISTENT_DATABASE_CONNECTION_FAILED"
  | "PERSISTENT_DATABASE_AUTH_FAILED"
  | "PERSISTENT_DATABASE_PREFLIGHT_FAILED";

/** SQLSTATE codes that indicate an authentication/authorization failure. */
const AUTH_SQLSTATES = new Set(["28P01", "28000"]);

/** Node/pg/TLS error codes that indicate a connectivity failure. */
const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "EPIPE",
  "EAI_AGAIN",
  "EPROTO",
]);

/** OpenSSL/Node TLS certificate error codes (connectivity-class failures). */
const TLS_ERROR_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * Map an arbitrary error to a categorical, connection-detail-free code
 * (review fix PF1). It reads ONLY the structured `code`/`errno` — never the
 * message — so no hostname, IP, port, URL, username, password, token, or
 * certificate detail can leak from a pg/DNS/TLS/socket/parser error.
 */
export function categorizePreflightError(err: unknown): PreflightFailureCode {
  const code =
    err && typeof err === "object" && "code" in err && typeof err.code === "string" ? err.code : "";
  if (AUTH_SQLSTATES.has(code)) return "PERSISTENT_DATABASE_AUTH_FAILED";
  if (CONNECTION_ERROR_CODES.has(code) || TLS_ERROR_CODES.has(code)) {
    return "PERSISTENT_DATABASE_CONNECTION_FAILED";
  }
  // Any other TLS/cert code shape.
  if (/^(CERT_|ERR_TLS|ERR_SSL)/.test(code)) return "PERSISTENT_DATABASE_CONNECTION_FAILED";
  return "PERSISTENT_DATABASE_PREFLIGHT_FAILED";
}

/**
 * CLI-safe one-line failure string. Returns ONLY the categorical code — it
 * never echoes the underlying error message, so it cannot leak connection
 * details. The original error may still be inspected via its `cause` internally.
 */
export function formatPreflightFailure(err: unknown): string {
  return categorizePreflightError(err);
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

export type MigrationStatus =
  "verified" | "ledger-absent" | "ledger-shape-unknown" | "missing-required" | "ahead-unknown";

export interface MigrationState {
  status: MigrationStatus;
  ledgerPresent: boolean;
  /** Migration version identifiers found in the ledger (no connection detail). */
  ledgerVersions: string[];
  /** Expected repository versions absent from the ledger (e.g. "0017"). */
  missing: string[];
  /** Ledger versions not expected by this repository (drift / ahead). */
  ahead: string[];
  /** True only when the reviewed migration state through the head is proven. */
  verified: boolean;
}

export interface PreflightResult {
  schemaReady: boolean;
  missing: string[];
  baselineCounts: Record<string, number>;
  destinations: DestinationReadiness;
  migration: MigrationState;
}

/**
 * Read the deployed Supabase migration ledger
 * (`supabase_migrations.schema_migrations`) READ-ONLY and prove that the
 * reviewed repository migration versions (through the head, e.g. 0017) are all
 * recorded, in order, with no unexpected/ahead versions (review fix PF2).
 *
 * The ledger's presence and column shape are inspected safely — absence or an
 * unrecognized shape yields an explicit non-verified status rather than an
 * assumption. Only version identifiers are ever surfaced, never connection
 * details.
 */
export async function verifyMigrationLedger(
  client: Client,
  expectedVersions: string[],
): Promise<MigrationState> {
  const expected = [...expectedVersions].sort();
  const empty = (status: MigrationStatus): MigrationState => ({
    status,
    ledgerPresent: status !== "ledger-absent",
    ledgerVersions: [],
    missing: [...expected],
    ahead: [],
    verified: false,
  });

  const tableRes = await client.query<{ n: string }>(
    `select count(*)::text n from information_schema.tables
       where table_schema = 'supabase_migrations' and table_name = 'schema_migrations'`,
  );
  if (Number(tableRes.rows[0]!.n) === 0) return empty("ledger-absent");

  // Inspect the column shape safely — the ledger must expose a `version` column.
  const colRes = await client.query<{ column_name: string }>(
    `select column_name from information_schema.columns
       where table_schema='supabase_migrations' and table_name='schema_migrations'`,
  );
  const cols = new Set(colRes.rows.map((r) => r.column_name));
  if (!cols.has("version")) return empty("ledger-shape-unknown");

  const verRes = await client.query<{ version: string }>(
    "select version::text as version from supabase_migrations.schema_migrations order by version",
  );
  const ledgerVersions = verRes.rows.map((r) => r.version);
  const ledgerSet = new Set(ledgerVersions);
  const expectedSet = new Set(expected);

  const missing = expected.filter((v) => !ledgerSet.has(v));
  const ahead = ledgerVersions.filter((v) => !expectedSet.has(v)).sort();

  let status: MigrationStatus;
  if (missing.length > 0) status = "missing-required";
  else if (ahead.length > 0) status = "ahead-unknown";
  else status = "verified";

  return {
    status,
    ledgerPresent: true,
    ledgerVersions,
    missing,
    ahead,
    verified: status === "verified",
  };
}

/**
 * Read-only preflight inspection. Performs NO writes and returns no PII.
 * `expectedMigrationVersions` are the repository's migration version identifiers
 * (e.g. ["0001", …, "0017"]) that must be proven present in the deployed ledger.
 */
export async function runPreflight(
  client: Client,
  expectedMigrationVersions: string[] = [],
): Promise<PreflightResult> {
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
  const migration = await verifyMigrationLedger(client, expectedMigrationVersions);

  return { schemaReady, missing, baselineCounts, destinations, migration };
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
