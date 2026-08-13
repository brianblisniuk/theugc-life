/**
 * Legacy adapter registry (IMPORT_SPEC.md §10, LEGACY_DATA_MIGRATION.md §3).
 *
 * One isolated adapter per current legacy source. Adapters translate messy
 * inputs into canonical raw sheets; their quirks never reach canonical schema.
 * Exact source filenames are local details — adapters are selected by key.
 */
import type { LegacyAdapter } from "../../../src/lib/import/legacy";

import { makeWorkbookAdapter } from "./messyWorkbook";
import { makeMarkdownAdapter } from "./markdownResearch";

export const LEGACY_ADAPTERS: Record<string, LegacyAdapter> = {
  // Broad Dubai accommodation research workbook (wide, mixed columns).
  "dubai-broad": makeWorkbookAdapter({
    key: "dubai-broad",
    description: "Broad Dubai accommodation research workbook",
    parserName: "legacy-dubai-broad",
    parserVersion: "1.0.0",
    defaultCountryCode: "AE",
    defaultDestination: "Dubai",
  }),

  // Curated Dubai outreach/contact workbook (contact-heavy).
  "dubai-contacts": makeWorkbookAdapter({
    key: "dubai-contacts",
    description: "Curated Dubai outreach/contact workbook",
    parserName: "legacy-dubai-contacts",
    parserVersion: "1.0.0",
    defaultCountryCode: "AE",
    defaultDestination: "Dubai",
    contactHeavy: true,
  }),

  // Multi-destination mixed research workbook (no single default geography).
  "multi-destination": makeWorkbookAdapter({
    key: "multi-destination",
    description: "Multi-destination mixed research workbook",
    parserName: "legacy-multi-destination",
    parserVersion: "1.0.0",
  }),

  // Structured Florianópolis research Markdown.
  "florianopolis-md": makeMarkdownAdapter({
    key: "florianopolis-md",
    description: "Structured Florianópolis research Markdown",
    parserName: "legacy-florianopolis-md",
    parserVersion: "1.0.0",
    defaultCountryCode: "BR",
    defaultDestination: "Florianópolis",
  }),
};

export function getLegacyAdapter(key: string): LegacyAdapter {
  const adapter = LEGACY_ADAPTERS[key];
  if (!adapter) {
    const keys = Object.keys(LEGACY_ADAPTERS).join(", ");
    throw new Error(`Unknown legacy adapter "${key}". Available: ${keys}`);
  }
  return adapter;
}

export function listLegacyAdapters(): { key: string; description: string }[] {
  return Object.values(LEGACY_ADAPTERS).map((a) => ({
    key: a.key,
    description: a.description,
  }));
}
