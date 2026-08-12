/**
 * Entity-resolution tests (IMPORT_SPEC.md §7, D028). Synthetic data only.
 * Proves: deterministic safe matches, fuzzy = review-only, chain-domain
 * collisions never auto-match, and forbidden identity keys (email/brand/city)
 * never drive a match.
 */
import { describe, expect, it } from "vitest";

import { nameMatchKey, normalizeUrl } from "@/lib/import/normalize";
import type { RawRow } from "@/lib/import/parse";
import { resolveEntities, type ExistingData } from "@/lib/import/resolve";
import { stageRawSheets } from "@/lib/import/stage";

function existing(): ExistingData {
  const hotel = (id: string, name: string, destinationId: string, website: string | null) => {
    const url = normalizeUrl(website);
    return {
      id,
      name,
      nameMatchKey: nameMatchKey(name),
      destinationId,
      websiteNormalized: url.normalized,
      websiteHost: url.host,
    };
  };
  const dest = (id: string, name: string, country: string) => ({
    id,
    name,
    nameFold: nameMatchKey(name),
    slug: nameMatchKey(name).replace(/\s+/g, "-"),
    countryCode: country,
  });
  return {
    destinations: [dest("dest-ubud", "Ubud", "ID"), dest("dest-bali", "Bali", "ID")],
    hotels: [
      hotel("h-alila", "Alila Ubud", "dest-ubud", "https://alilahotels.com/ubud"),
      hotel("h-bulgari", "Bulgari Resort Bali", "dest-bali", null),
      hotel("h-marA", "Marriott Downtown", "dest-bali", "https://marriott.com"),
      hotel("h-marB", "Marriott Beach", "dest-bali", "https://marriott.com"),
    ],
  };
}

function propRow(n: number, fields: Record<string, string | null>): RawRow {
  return { sheetName: "properties", sourceRowNumber: n, data: fields };
}

function resolveProps(rows: RawRow[]) {
  const staged = stageRawSheets({ properties: rows, contacts: [], evidence: [] });
  return resolveEntities(staged.rows, existing());
}

describe("deterministic safe matches", () => {
  it("exact normalized name + same destination auto-matches", () => {
    const res = resolveProps([
      propRow(1, {
        source_property_id: "p1",
        property_name: "Alila Ubud",
        destination_name: "Ubud",
        country_code: "ID",
        source_url: "https://alilahotels.com/ubud",
      }),
    ]);
    const c = res.properties[0]!.hotelCandidates[0]!;
    expect(c.matchMethod).toBe("exact_name_plus_destination");
    expect(c.deterministicSafe).toBe(true);
    expect(c.candidateEntityId).toBe("h-alila");
  });

  it("exact property-specific URL + compatible name auto-matches", () => {
    const res = resolveProps([
      propRow(1, {
        source_property_id: "p1",
        property_name: "Alila Ubud Bali",
        destination_name: "Ubud",
        country_code: "ID",
        website_url: "https://alilahotels.com/ubud",
        source_url: "https://alilahotels.com/ubud",
      }),
    ]);
    const safe = res.properties[0]!.hotelCandidates.filter((c) => c.deterministicSafe);
    expect(safe.some((c) => c.matchMethod === "canonical_url_plus_name")).toBe(true);
  });
});

describe("fuzzy matching is review-only", () => {
  it("a near-duplicate name produces a fuzzy candidate, never auto-matched", () => {
    const res = resolveProps([
      propRow(1, {
        source_property_id: "p1",
        property_name: "Bulgari Resorts Bali",
        destination_name: "Bali",
        country_code: "ID",
        source_url: "https://example.com",
      }),
    ]);
    const cands = res.properties[0]!.hotelCandidates;
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.every((c) => !c.deterministicSafe)).toBe(true);
    expect(cands[0]!.matchMethod).toBe("fuzzy_name");
  });
});

describe("chain-domain collisions never auto-match", () => {
  it("a shared chain host at root path is a review candidate only", () => {
    const res = resolveProps([
      propRow(1, {
        source_property_id: "p1",
        property_name: "Some Unrelated Property",
        destination_name: "Bali",
        country_code: "ID",
        website_url: "https://marriott.com",
        source_url: "https://marriott.com",
      }),
    ]);
    const cands = res.properties[0]!.hotelCandidates;
    expect(cands.some((c) => c.matchMethod === "chain_domain_collision")).toBe(true);
    expect(cands.every((c) => !c.deterministicSafe)).toBe(true);
  });
});

describe("forbidden identity keys", () => {
  it("brand alone does not match a differently-named property", () => {
    const res = resolveProps([
      propRow(1, {
        source_property_id: "p1",
        property_name: "Totally Different Name",
        brand_name: "Bulgari",
        destination_name: "Ubud",
        country_code: "ID",
        source_url: "https://example.com",
      }),
    ]);
    expect(res.properties[0]!.hotelCandidates).toHaveLength(0);
  });

  it("same corporate email across two properties keeps them separate", () => {
    const staged = stageRawSheets({
      properties: [
        propRow(1, {
          source_property_id: "p1",
          property_name: "Harbor View Hotel",
          destination_name: "Ubud",
          country_code: "ID",
          source_url: "https://a.com",
        }),
        propRow(2, {
          source_property_id: "p2",
          property_name: "Mountain Lodge",
          destination_name: "Bali",
          country_code: "ID",
          source_url: "https://b.com",
        }),
      ],
      contacts: [
        {
          sheetName: "contacts",
          sourceRowNumber: 3,
          data: { source_property_id: "p1", email: "sales@corporate.com" },
        },
        {
          sheetName: "contacts",
          sourceRowNumber: 4,
          data: { source_property_id: "p2", email: "sales@corporate.com" },
        },
      ],
      evidence: [],
    });
    const res = resolveEntities(staged.rows, existing());
    expect(res.properties).toHaveLength(2);
    // Neither is matched to an existing hotel by the shared email.
    expect(res.properties.every((p) => p.hotelCandidates.length === 0)).toBe(true);
  });
});
