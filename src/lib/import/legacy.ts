/**
 * Legacy adapter contract (IMPORT_SPEC.md §10, LEGACY_DATA_MIGRATION.md, D030).
 *
 * Legacy adapters are one-time migration code. They may parse messy inputs
 * however they must, but their OUTPUT is the SAME canonical raw-sheet shape the
 * standard importer produces, so downstream staging/validation/resolution is
 * identical. No legacy column name ever becomes a canonical DB column.
 *
 * The concrete adapters live under `scripts/import/legacy/`; only this shared
 * contract + helpers live in the durable lib so the pipeline stays decoupled
 * from source-specific code.
 */
import type { RawRow, RawSheets } from "./parse";

export interface LegacyAdapter {
  /** Stable key used to select the adapter on the CLI. */
  key: string;
  /** Human description of the legacy source it handles. */
  description: string;
  parserName: string;
  parserVersion: string;
  /** Parse a legacy file into canonical raw sheets. */
  parse(filePath: string): Promise<RawSheets>;
}

/**
 * Build a canonical raw row from an adapter, preserving the original messy row
 * under `_legacy_source` for lineage. `_legacy_source` is not a canonical header
 * so staging ignores it for field mapping while raw_data retains it.
 */
export function legacyRow(
  sheetName: string,
  sourceRowNumber: number,
  canonicalValues: Record<string, string | null>,
  original: unknown,
): RawRow {
  return {
    sheetName,
    sourceRowNumber,
    data: {
      ...canonicalValues,
      _legacy_source: original === undefined ? null : JSON.stringify(original),
    },
  };
}

export function emptyRawSheets(): RawSheets {
  return { properties: [], contacts: [], evidence: [] };
}
