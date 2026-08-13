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

const SPREADSHEETML_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/**
 * Load an .xlsx workbook, tolerating standards-valid OOXML that serializes the
 * spreadsheetml elements with a namespace PREFIX (e.g. `<x:workbook>`,
 * `<x:worksheet>`, `<x:row>`). ExcelJS 4.x's reader is not namespace-aware and
 * returns an empty/undefined workbook for such files, so we first try a normal
 * read and, only if that yields no worksheets, normalize the prefixed elements
 * back to the default namespace (which ExcelJS expects) and reload.
 *
 * This is a general reader-robustness fix — it is not source-specific and it
 * NEVER alters cell data: cell text is XML-escaped, so the `<x:`/`</x:` tag
 * sequences only ever appear as element markup, and only the spreadsheetml
 * namespace prefix is rewritten (the `r:` relationship prefix is preserved).
 */
async function loadXlsxWorkbook(filePath: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath);
    if (workbook.worksheets.length > 0) return workbook;
  } catch {
    // Fall through to namespace normalization below.
  }

  const zip = await JSZip.loadAsync(await readFile(filePath));

  // Drop Excel "table" definitions entirely. They are presentation metadata over
  // cell ranges we already read directly (header + values), and ExcelJS's table
  // reader throws on some writers' output. Removing them changes no cell data.
  for (const name of Object.keys(zip.files)) {
    if (/^xl\/tables\//.test(name)) zip.remove(name);
  }

  let changed = false;
  for (const name of Object.keys(zip.files)) {
    if (!name.endsWith(".xml") && !name.endsWith(".rels")) continue;
    const before = await zip.files[name]!.async("string");
    const after = before
      // Normalize the spreadsheetml namespace prefix to the default namespace.
      .split(`xmlns:x="${SPREADSHEETML_NS}"`)
      .join(`xmlns="${SPREADSHEETML_NS}"`)
      .split("<x:")
      .join("<")
      .split("</x:")
      .join("</")
      // Detach the now-removed table definitions from worksheets, relationships,
      // and content types so ExcelJS does not try to resolve them.
      .replace(/<tableParts[\s\S]*?<\/tableParts>/g, "")
      .replace(/<tableParts\b[^>]*\/>/g, "")
      .replace(/<Override\b[^>]*tables\/[^>]*\/>/g, "")
      .replace(/<Relationship\b[^>]*tables\/[^>]*\/>/g, "");
    if (after !== before) {
      zip.file(name, after);
      changed = true;
    }
  }
  if (!changed) return workbook;

  const normalized = new ExcelJS.Workbook();
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  await normalized.xlsx.load(buffer as unknown as Parameters<typeof normalized.xlsx.load>[0]);
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
