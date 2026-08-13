/**
 * Destination resolution + catalog management (DESTINATION_CATALOG.md).
 *
 * The resolver is deterministic and conservative. It NEVER fuzzy-matches
 * geography and NEVER auto-creates a canonical destination from free text.
 * Resolution order (exactly §5):
 *   1. exact active destination_slug;
 *   2. exact active alias + compatible country;
 *   3. exact normalized canonical name + compatible country, when unique;
 *   4. otherwise unresolved.
 */
import type { Client } from "pg";

import { foldForMatch, normalizeSlug, normalizeString } from "./normalize";

export const DESTINATION_TYPES = ["country", "region", "island", "city", "area"] as const;
export type DestinationType = (typeof DESTINATION_TYPES)[number];

export interface CatalogDestination {
  id: string;
  slug: string;
  nameFold: string;
  countryCode: string | null;
}

export interface CatalogAlias {
  destinationId: string;
  normalizedAlias: string;
  countryCode: string | null;
}

export interface DestinationCatalog {
  destinations: CatalogDestination[];
  aliases: CatalogAlias[];
}

export type DestinationMethod = "destination_slug" | "alias_country" | "name_country";

export interface DestinationResolution {
  destinationId: string | null;
  method: DestinationMethod | null;
  /** True when a match was ambiguous (multiple destinations) and thus rejected. */
  ambiguous: boolean;
}

export interface DestinationInput {
  slug?: string | null;
  name?: string | null;
  countryCode?: string | null;
}

/** Two country codes are compatible when neither conflicts (null is a wildcard). */
function countryCompatible(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return true;
  return a === b;
}

export function resolveDestination(
  input: DestinationInput,
  catalog: DestinationCatalog,
): DestinationResolution {
  const slug = input.slug ? normalizeSlug(input.slug) : null;
  const nameFold = input.name ? foldForMatch(input.name) : null;
  const country = input.countryCode ?? null;

  // 1. Exact active canonical slug (slugs are globally unique). A slug hit only
  // resolves when the staged country is compatible with the destination's known
  // country (review fix F10): an exact slug with a KNOWN conflicting staged
  // country must not resolve cleanly.
  if (slug) {
    const bySlug = catalog.destinations.filter((d) => d.slug === slug);
    if (bySlug.length === 1 && countryCompatible(bySlug[0]!.countryCode, country)) {
      return { destinationId: bySlug[0]!.id, method: "destination_slug", ambiguous: false };
    }
  }

  // 2. Exact active alias + compatible country. Compatibility considers BOTH
  // the alias's optional country_code AND the target canonical destination's
  // country_code (review fix F3): a NULL-country alias must never resolve
  // across a known country conflict on the destination itself.
  if (nameFold) {
    const destCountryById = new Map(catalog.destinations.map((d) => [d.id, d.countryCode]));
    const aliasMatches = catalog.aliases.filter(
      (a) =>
        a.normalizedAlias === nameFold &&
        countryCompatible(a.countryCode, country) &&
        countryCompatible(destCountryById.get(a.destinationId) ?? null, country),
    );
    const distinct = new Set(aliasMatches.map((a) => a.destinationId));
    if (distinct.size === 1) {
      return {
        destinationId: aliasMatches[0]!.destinationId,
        method: "alias_country",
        ambiguous: false,
      };
    }
    if (distinct.size > 1) {
      return { destinationId: null, method: null, ambiguous: true };
    }
  }

  // 3. Exact normalized canonical destination name + compatible country, unique.
  if (nameFold) {
    const nameMatches = catalog.destinations.filter(
      (d) => d.nameFold === nameFold && countryCompatible(d.countryCode, country),
    );
    if (nameMatches.length === 1) {
      return { destinationId: nameMatches[0]!.id, method: "name_country", ambiguous: false };
    }
    if (nameMatches.length > 1) {
      return { destinationId: null, method: null, ambiguous: true };
    }
  }

  // 4. Unresolved.
  return { destinationId: null, method: null, ambiguous: false };
}

// ===========================================================================
// Catalog management (admin/server CLI). Validation is enforced here (no
// third-party geocoder in Sprint 1B).
// ===========================================================================

export interface UpsertDestinationInput {
  slug: string;
  name: string;
  type: string;
  countryCode?: string | null;
  countryName?: string | null;
  parentSlug?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  isSellable?: boolean;
  isFeatured?: boolean;
}

export class DestinationValidationError extends Error {}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new DestinationValidationError(message);
}

/** Insert or update a canonical destination with full validation. */
export async function upsertDestination(
  client: Client,
  input: UpsertDestinationInput,
): Promise<{ id: string; created: boolean }> {
  const slug = normalizeSlug(input.slug);
  assert(slug !== null, "slug is required");
  const name = normalizeString(input.name);
  assert(name !== null, "name is required");
  assert(
    (DESTINATION_TYPES as readonly string[]).includes(input.type),
    `type must be one of: ${DESTINATION_TYPES.join(", ")}`,
  );
  const country = input.countryCode ? input.countryCode.toUpperCase() : null;
  if (country !== null) assert(/^[A-Z]{2}$/.test(country), "country_code must be ISO alpha-2");
  if (input.latitude != null)
    assert(input.latitude >= -90 && input.latitude <= 90, "latitude out of range");
  if (input.longitude != null)
    assert(input.longitude >= -180 && input.longitude <= 180, "longitude out of range");

  // Resolve parent (must exist) and guard against cycles.
  let parentId: string | null = null;
  if (input.parentSlug) {
    const parentSlug = normalizeSlug(input.parentSlug);
    const parent = await client.query<{ id: string; country_code: string | null }>(
      "select id, country_code from public.destinations where slug = $1",
      [parentSlug],
    );
    assert(parent.rows.length === 1, `parent destination not found: ${input.parentSlug}`);
    parentId = parent.rows[0]!.id;
    if (country && parent.rows[0]!.country_code) {
      assert(
        country === parent.rows[0]!.country_code,
        "country_code must match parent destination's country",
      );
    }
  }

  const existing = await client.query<{ id: string }>(
    "select id from public.destinations where slug = $1",
    [slug],
  );

  if (existing.rows.length === 1) {
    const id = existing.rows[0]!.id;
    // Cycle guard: the chosen parent must not be this node or a descendant.
    if (parentId) {
      assert(parentId !== id, "a destination cannot be its own parent");
      await assertNoCycle(client, id, parentId);
    }
    await client.query(
      `update public.destinations set
         name=$2, type=$3, country_code=$4, country_name=$5, parent_destination_id=$6,
         latitude=$7, longitude=$8,
         is_sellable=coalesce($9, is_sellable), is_featured=coalesce($10, is_featured)
       where id=$1`,
      [
        id,
        name,
        input.type,
        country,
        normalizeString(input.countryName),
        parentId,
        input.latitude ?? null,
        input.longitude ?? null,
        input.isSellable ?? null,
        input.isFeatured ?? null,
      ],
    );
    return { id, created: false };
  }

  const inserted = await client.query<{ id: string }>(
    `insert into public.destinations
       (name, slug, type, country_code, country_name, parent_destination_id,
        latitude, longitude, is_sellable, is_featured)
     values ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9,false),coalesce($10,false))
     returning id`,
    [
      name,
      slug,
      input.type,
      country,
      normalizeString(input.countryName),
      parentId,
      input.latitude ?? null,
      input.longitude ?? null,
      input.isSellable ?? null,
      input.isFeatured ?? null,
    ],
  );
  return { id: inserted.rows[0]!.id, created: true };
}

/** Ensure setting `newParentId` as the parent of `nodeId` introduces no cycle. */
async function assertNoCycle(client: Client, nodeId: string, newParentId: string): Promise<void> {
  let current: string | null = newParentId;
  let depth = 0;
  while (current !== null && depth < 50) {
    if (current === nodeId) {
      throw new DestinationValidationError("parent assignment would create a hierarchy cycle");
    }
    const res: { rows: { parent_destination_id: string | null }[] } = await client.query(
      "select parent_destination_id from public.destinations where id = $1",
      [current],
    );
    current = res.rows[0]?.parent_destination_id ?? null;
    depth++;
  }
}

export interface AddAliasInput {
  destinationSlug: string;
  alias: string;
  countryCode?: string | null;
  source?: string;
}

/** Add an active editorial alias to a destination. */
export async function addAlias(client: Client, input: AddAliasInput): Promise<{ id: string }> {
  const alias = normalizeString(input.alias);
  assert(alias !== null, "alias is required");
  const destSlug = normalizeSlug(input.destinationSlug);
  const dest = await client.query<{ id: string; country_code: string | null }>(
    "select id, country_code from public.destinations where slug = $1",
    [destSlug],
  );
  assert(dest.rows.length === 1, `destination not found: ${input.destinationSlug}`);
  const country = input.countryCode ? input.countryCode.toUpperCase() : null;
  if (country !== null) assert(/^[A-Z]{2}$/.test(country), "country_code must be ISO alpha-2");

  // Never permit an explicit cross-country alias mapping (review fix F3): when
  // an alias country is supplied and the destination has a known country, they
  // must match. This keeps the alias catalog free of country-conflicting rows
  // that the resolver would otherwise have to defensively reject at read time.
  const destCountry = dest.rows[0]!.country_code;
  if (country !== null && destCountry !== null) {
    assert(
      country === destCountry,
      `alias country ${country} conflicts with destination country ${destCountry}`,
    );
  }

  const res = await client.query<{ id: string }>(
    `insert into public.destination_aliases
       (destination_id, alias, normalized_alias, country_code, source)
     values ($1,$2,$3,$4,$5)
     returning id`,
    [dest.rows[0]!.id, alias, foldForMatch(alias), country, input.source ?? "editorial"],
  );
  return { id: res.rows[0]!.id };
}

export interface DestinationListRow {
  id: string;
  slug: string;
  name: string;
  type: string;
  countryCode: string | null;
  parentSlug: string | null;
  isSellable: boolean;
  aliasCount: number;
}

export async function listDestinations(client: Client): Promise<DestinationListRow[]> {
  const res = await client.query(
    `select d.id, d.slug, d.name, d.type, d.country_code, d.is_sellable,
            p.slug as parent_slug,
            (select count(*) from public.destination_aliases a
               where a.destination_id = d.id and a.is_active) as alias_count
       from public.destinations d
       left join public.destinations p on p.id = d.parent_destination_id
       order by d.country_code nulls first, d.slug`,
  );
  return res.rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    type: r.type,
    countryCode: r.country_code,
    parentSlug: r.parent_slug,
    isSellable: r.is_sellable,
    aliasCount: Number(r.alias_count),
  }));
}

/** Load the resolution catalog (active aliases only). */
export async function loadDestinationCatalog(client: Client): Promise<DestinationCatalog> {
  const dests = await client.query<{
    id: string;
    slug: string;
    name: string;
    country_code: string | null;
  }>("select id, slug, name, country_code from public.destinations");
  const aliases = await client.query<{
    destination_id: string;
    normalized_alias: string;
    country_code: string | null;
  }>(
    "select destination_id, normalized_alias, country_code from public.destination_aliases where is_active",
  );
  return {
    destinations: dests.rows.map((d) => ({
      id: d.id,
      slug: d.slug,
      nameFold: foldForMatch(d.name),
      countryCode: d.country_code,
    })),
    aliases: aliases.rows.map((a) => ({
      destinationId: a.destination_id,
      normalizedAlias: a.normalized_alias,
      countryCode: a.country_code,
    })),
  };
}
