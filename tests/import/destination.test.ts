/**
 * Destination resolver + catalog management tests (DESTINATION_CATALOG.md).
 * Pure resolver tests always run; management/cycle tests need a DB. Synthetic
 * data only; Sprint 1B test slugs are namespaced to avoid cross-file clashes.
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DestinationValidationError,
  addAlias,
  resolveDestination,
  upsertDestination,
  type DestinationCatalog,
} from "@/lib/import/destination";

import { hasTestDb, setupDatabase } from "../db/harness";

const CATALOG: DestinationCatalog = {
  destinations: [
    { id: "d-bali", slug: "bali", nameFold: "bali", countryCode: "ID" },
    { id: "d-ubud", slug: "ubud", nameFold: "ubud", countryCode: "ID" },
    { id: "d-paris-fr", slug: "paris", nameFold: "paris", countryCode: "FR" },
    { id: "d-paris-us", slug: "paris-tx", nameFold: "paris", countryCode: "US" },
  ],
  aliases: [
    { destinationId: "d-flori", normalizedAlias: "floripa", countryCode: "BR" },
    // Ambiguous "jbr" alias → two different destinations.
    { destinationId: "d-marina", normalizedAlias: "jbr", countryCode: null },
    { destinationId: "d-other", normalizedAlias: "jbr", countryCode: null },
  ],
};

describe("destination resolution order (DESTINATION_CATALOG §5)", () => {
  it("1) exact canonical slug resolves", () => {
    const r = resolveDestination({ slug: "bali", name: "Anything" }, CATALOG);
    expect(r).toMatchObject({ destinationId: "d-bali", method: "destination_slug" });
  });

  it("2) exact active alias + compatible country resolves", () => {
    const r = resolveDestination({ name: "Floripa", countryCode: "BR" }, CATALOG);
    expect(r).toMatchObject({ destinationId: "d-flori", method: "alias_country" });
  });

  it("ambiguous alias stays unresolved (never auto-resolves)", () => {
    const r = resolveDestination({ name: "JBR" }, CATALOG);
    expect(r.destinationId).toBeNull();
    expect(r.ambiguous).toBe(true);
  });

  it("3) exact normalized canonical name + compatible country (unique) resolves", () => {
    const r = resolveDestination({ name: "Ubud", countryCode: "ID" }, CATALOG);
    expect(r).toMatchObject({ destinationId: "d-ubud", method: "name_country" });
  });

  it("same name in two countries: country disambiguates", () => {
    const r = resolveDestination({ name: "Paris", countryCode: "FR" }, CATALOG);
    expect(r).toMatchObject({ destinationId: "d-paris-fr", method: "name_country" });
  });

  it("same name in two countries with no country stays ambiguous/unresolved", () => {
    const r = resolveDestination({ name: "Paris" }, CATALOG);
    expect(r.destinationId).toBeNull();
  });

  it("incompatible country yields unresolved (no fuzzy geography)", () => {
    const r = resolveDestination({ name: "Paris", countryCode: "ID" }, CATALOG);
    expect(r.destinationId).toBeNull();
  });

  it("unknown free text is unresolved", () => {
    const r = resolveDestination({ name: "Nowhere City" }, CATALOG);
    expect(r).toMatchObject({ destinationId: null, method: null, ambiguous: false });
  });

  it("F3: a NULL-country alias never resolves across a known destination-country conflict", () => {
    const catalog: DestinationCatalog = {
      destinations: [
        { id: "d-flori-br", slug: "florianopolis", nameFold: "florianopolis", countryCode: "BR" },
      ],
      // Alias country is NULL, but the destination it points to is known BR.
      aliases: [{ destinationId: "d-flori-br", normalizedAlias: "floripa", countryCode: null }],
    };
    // AR source input conflicts with the BR destination → must NOT resolve.
    expect(resolveDestination({ name: "Floripa", countryCode: "AR" }, catalog).destinationId).toBe(
      null,
    );
    // Compatible (BR) or unknown source country still resolves via the alias.
    expect(resolveDestination({ name: "Floripa", countryCode: "BR" }, catalog).destinationId).toBe(
      "d-flori-br",
    );
    expect(resolveDestination({ name: "Floripa" }, catalog).destinationId).toBe("d-flori-br");
  });
});

const d = describe.skipIf(!hasTestDb);

d("destination catalog management (CLI logic)", () => {
  let client: Client;
  beforeAll(async () => {
    if (!hasTestDb) return;
    await setupDatabase();
    client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
  });
  afterAll(async () => {
    if (client) await client.end();
  });

  it("upserts a parent + child and rejects hierarchy cycles", async () => {
    await upsertDestination(client, {
      slug: "zzt-bali",
      name: "ZZT Bali",
      type: "island",
      countryCode: "ID",
    });
    await upsertDestination(client, {
      slug: "zzt-ubud",
      name: "ZZT Ubud",
      type: "area",
      countryCode: "ID",
      parentSlug: "zzt-bali",
    });
    // Attempt to make the parent a child of its own descendant → cycle.
    await expect(
      upsertDestination(client, {
        slug: "zzt-bali",
        name: "ZZT Bali",
        type: "island",
        countryCode: "ID",
        parentSlug: "zzt-ubud",
      }),
    ).rejects.toBeInstanceOf(DestinationValidationError);
  });

  it("rejects an unknown parent and validates taxonomy/coords", async () => {
    await expect(
      upsertDestination(client, {
        slug: "zzt-x",
        name: "X",
        type: "area",
        parentSlug: "zzt-missing",
      }),
    ).rejects.toBeInstanceOf(DestinationValidationError);
    await expect(
      upsertDestination(client, { slug: "zzt-y", name: "Y", type: "galaxy" }),
    ).rejects.toBeInstanceOf(DestinationValidationError);
    await expect(
      upsertDestination(client, { slug: "zzt-z", name: "Z", type: "city", latitude: 999 }),
    ).rejects.toBeInstanceOf(DestinationValidationError);
  });

  it("adds aliases and blocks duplicate active alias identity", async () => {
    await addAlias(client, {
      destinationSlug: "zzt-bali",
      alias: "Bali Island",
      countryCode: "ID",
    });
    await expect(
      addAlias(client, { destinationSlug: "zzt-bali", alias: "Bali Island", countryCode: "ID" }),
    ).rejects.toBeTruthy();
  });

  it("F3: rejects an explicit cross-country alias mapping via the CLI", async () => {
    // zzt-bali is a known ID destination; an explicit BR alias country conflicts.
    await expect(
      addAlias(client, { destinationSlug: "zzt-bali", alias: "Wrong Country", countryCode: "BR" }),
    ).rejects.toBeInstanceOf(DestinationValidationError);
    // The conflicting alias must not have been written.
    const n = await client.query<{ n: string }>(
      "select count(*)::text n from public.destination_aliases where normalized_alias = 'wrong country'",
    );
    expect(Number(n.rows[0]!.n)).toBe(0);
  });
});
