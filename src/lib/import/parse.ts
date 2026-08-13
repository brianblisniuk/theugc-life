/**
 * Source-file parsing for the standard importer (IMPORT_SPEC.md §9).
 *
 * Reads the canonical interchange formats into raw rows, preserving original
 * header names + cell text in `data` (raw lineage). Normalization/validation is
 * a separate stage — this layer only extracts.
 *
 *  - XLSX: one workbook with `properties`, `contacts`, optional `evidence` sheets.
 *  - CSV : one sheet per file (`--file` = properties; optional sibling CSVs for
 *          contacts/evidence).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import ExcelJS from "exceljs";
import JSZip from "jszip";
import Papa from "papaparse";

import type { RowKind } from "./contract";

export const SPREADSHEETML_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/**
 * Normalize a single OOXML part for the fallback reader.
 *
 * The spreadsheetml element prefix is stripped ONLY when this part actually
 * binds `x` to the spreadsheetml namespace (review fix P2) — an `x:` prefix
 * bound to any other namespace is left untouched. Independently, references to
 * the Excel "table" definitions (which the fallback removes as parts) are
 * detached from worksheet tableParts, relationships, and content types.
 *
 * Cell data is never altered: cell text is XML-escaped, so the `<x:`/`</x:` tag
 * sequences only ever appear as element markup, and the `r:` relationship
 * prefix is preserved. Returns the (possibly unchanged) XML.
 */
export function normalizeOoxmlPartForFallback(xml: string): string {
  let out = xml;
  // P2: only rewrite the element prefix in parts that BIND `x` to spreadsheetml.
  if (xml.includes(`xmlns:x="${SPREADSHEETML_NS}"`)) {
    out = out
      .split(`xmlns:x="${SPREADSHEETML_NS}"`)
      .join(`xmlns="${SPREADSHEETML_NS}"`)
      .split("<x:")
      .join("<")
      .split("</x:")
      .join("</");
  }
  // Detach removed table definitions (scoped to the OOXML table refs only).
  out = out
    .replace(/<tableParts[\s\S]*?<\/tableParts>/g, "")
    .replace(/<tableParts\b[^>]*\/>/g, "")
    .replace(/<Override\b[^>]*tables\/[^>]*\/>/g, "")
    .replace(/<Relationship\b[^>]*tables\/[^>]*\/>/g, "");
  return out;
}

/** Build a loud parse error that retains the underlying cause (review fix P1). */
function xlsxParseFailure(filePath: string, cause: unknown): Error {
  const detail =
    cause instanceof Error ? cause.message : cause != null ? String(cause) : "no worksheets found";
  return new Error(`Unable to read workbook ${path.basename(filePath)}: ${detail}`, {
    cause: cause ?? undefined,
  });
}

/**
 * Load an .xlsx workbook, tolerating standards-valid OOXML that ExcelJS 4.x
 * cannot read directly: spreadsheetml elements serialized with a namespace
 * PREFIX (`<x:workbook>`, `<x:worksheet>`, `<x:row>`…) and/or Excel "table"
 * definitions its reader throws on. We first try a normal read; only if that
 * fails or yields no worksheets do we normalize prefixed parts + strip table
 * definitions and reload.
 *
 * A malformed/corrupt workbook must fail loudly (review fix P1): the original
 * ExcelJS error is preserved and rethrown when the fallback has nothing
 * applicable to change or cannot itself produce a non-empty workbook. This
 * function never returns an empty workbook as success.
 */
async function loadXlsxWorkbook(filePath: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  let originalError: unknown = null;
  try {
    await workbook.xlsx.readFile(filePath);
    if (workbook.worksheets.length > 0) return workbook;
    // Read succeeded but produced no worksheets — try the fallback below, and
    // fail loudly if it cannot recover a non-empty workbook.
  } catch (err) {
    originalError = err;
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await readFile(filePath));
  } catch (zipErr) {
    // Not even a readable package: surface the real failure, not zero sheets.
    throw xlsxParseFailure(filePath, originalError ?? zipErr);
  }

  // Drop Excel "table" definitions entirely. They are presentation metadata over
  // cell ranges we already read directly (header + values), and ExcelJS's table
  // reader throws on some writers' output. Removing them changes no cell data.
  let changed = false;
  for (const name of Object.keys(zip.files)) {
    if (/^xl\/tables\//.test(name)) {
      zip.remove(name);
      changed = true;
    }
  }

  for (const name of Object.keys(zip.files)) {
    if (!name.endsWith(".xml") && !name.endsWith(".rels")) continue;
    const before = await zip.files[name]!.async("string");
    const after = normalizeOoxmlPartForFallback(before);
    if (after !== before) {
      zip.file(name, after);
      changed = true;
    }
  }

  // P1: if the fallback has nothing applicable to change, it cannot help — the
  // workbook is genuinely unreadable, so rethrow rather than return zero sheets.
  if (!changed) {
    throw xlsxParseFailure(filePath, originalError);
  }

  let normalized: ExcelJS.Workbook;
  try {
    normalized = new ExcelJS.Workbook();
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    await normalized.xlsx.load(buffer as unknown as Parameters<typeof normalized.xlsx.load>[0]);
  } catch (loadErr) {
    throw xlsxParseFailure(filePath, originalError ?? loadErr);
  }

  // P1: a normalized workbook that still has zero worksheets is a failure.
  if (normalized.worksheets.length === 0) {
    throw xlsxParseFailure(filePath, originalError);
  }
  return normalized;
}

export interface RawRow {
  sheetName: string;
  sourceRowNumber: number;
  /** Keyed by ORIGINAL header text; values are trimmed cell strings or null. */
  data: Record<string, string | null>;
}

export interface RawSheets {
  properties: RawRow[];
  contacts: RawRow[];
  evidence: RawRow[];
}

export interface SourceInspection {
  fileName: string;
  ext: string;
  sheets: { name: string; kind: RowKind | "unknown"; columns: string[]; rowCount: number }[];
}

const SHEET_KINDS: Record<string, RowKind> = {
  properties: "property",
  property: "property",
  contacts: "contact",
  contact: "contact",
  evidence: "evidence",
};

function cellToString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    const v = value as { text?: unknown; result?: unknown; hyperlink?: unknown };
    if (typeof v.text === "string") return v.text.trim() || null;
    if (typeof v.result === "string") return v.result.trim() || null;
    if (typeof v.hyperlink === "string") return v.hyperlink.trim() || null;
    return null;
  }
  const s = String(value).trim();
  return s.length === 0 ? null : s;
}

async function readXlsxSheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
): Promise<{ columns: string[]; rows: RawRow[] } | null> {
  const ws = workbook.worksheets.find((w) => w.name.trim().toLowerCase() === sheetName);
  if (!ws) return null;

  const headerRow = ws.getRow(1);
  const columns: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell) => {
    const h = cellToString(cell.value);
    if (h) columns.push(h);
  });

  const rows: RawRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const data: Record<string, string | null> = {};
    let nonEmpty = false;
    columns.forEach((col, idx) => {
      const value = cellToString(row.getCell(idx + 1).value);
      data[col] = value;
      if (value !== null) nonEmpty = true;
    });
    if (nonEmpty) rows.push({ sheetName: ws.name, sourceRowNumber: rowNumber, data });
  });

  return { columns, rows };
}

function parseCsv(content: string, sheetName: string): { columns: string[]; rows: RawRow[] } {
  const parsed = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  const columns = parsed.meta.fields ?? [];
  const rows: RawRow[] = parsed.data.map((record, index) => {
    const data: Record<string, string | null> = {};
    for (const col of columns) {
      const value = record[col];
      const s = value === undefined || value === null ? null : String(value).trim();
      data[col] = s && s.length > 0 ? s : null;
    }
    // +2: 1-based, plus the header row.
    return { sheetName, sourceRowNumber: index + 2, data };
  });
  return { columns, rows };
}

export interface CanonicalSourceOptions {
  file: string;
  contacts?: string;
  evidence?: string;
}

/** Read a canonical source into raw rows for the three sheet kinds. */
export async function readCanonicalSource(opts: CanonicalSourceOptions): Promise<RawSheets> {
  const ext = path.extname(opts.file).toLowerCase();
  const empty: RawSheets = { properties: [], contacts: [], evidence: [] };

  if (ext === ".xlsx") {
    const workbook = await loadXlsxWorkbook(opts.file);
    const props = await readXlsxSheet(workbook, "properties");
    const contacts = await readXlsxSheet(workbook, "contacts");
    const evidence = await readXlsxSheet(workbook, "evidence");
    return {
      properties: props?.rows ?? [],
      contacts: contacts?.rows ?? [],
      evidence: evidence?.rows ?? [],
    };
  }

  if (ext === ".csv") {
    const propsContent = await readFile(opts.file, "utf8");
    const result: RawSheets = { ...empty };
    result.properties = parseCsv(propsContent, "properties").rows;
    if (opts.contacts) {
      result.contacts = parseCsv(await readFile(opts.contacts, "utf8"), "contacts").rows;
    }
    if (opts.evidence) {
      result.evidence = parseCsv(await readFile(opts.evidence, "utf8"), "evidence").rows;
    }
    return result;
  }

  throw new Error(`Unsupported file type: ${ext} (expected .xlsx or .csv)`);
}

/** Inspect a source's structure without normalizing (import:inspect). */
export async function inspectSource(filePath: string): Promise<SourceInspection> {
  const ext = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath);
  const sheets: SourceInspection["sheets"] = [];

  if (ext === ".xlsx") {
    const workbook = await loadXlsxWorkbook(filePath);
    for (const ws of workbook.worksheets) {
      const parsed = await readXlsxSheet(workbook, ws.name.trim().toLowerCase());
      const key = ws.name.trim().toLowerCase();
      sheets.push({
        name: ws.name,
        kind: SHEET_KINDS[key] ?? "unknown",
        columns: parsed?.columns ?? [],
        rowCount: parsed?.rows.length ?? 0,
      });
    }
  } else if (ext === ".csv") {
    const parsed = parseCsv(await readFile(filePath, "utf8"), "properties");
    sheets.push({
      name: "properties",
      kind: "property",
      columns: parsed.columns,
      rowCount: parsed.rows.length,
    });
  } else {
    throw new Error(`Unsupported file type: ${ext} (expected .xlsx or .csv)`);
  }

  return { fileName, ext, sheets };
}
