/**
 * Reader robustness for standards-valid OOXML that serializes spreadsheetml
 * with a namespace PREFIX (`<x:workbook>`, `<x:worksheet>`, `<x:row>`…) and
 * carries Excel "table" definitions — a shape ExcelJS 4.x cannot read directly.
 * The canonical importer normalizes such workbooks before parsing (Sprint 1C).
 *
 * Fully synthetic: the workbook is assembled in-memory with invented data; no
 * real pilot content is referenced.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  SPREADSHEETML_NS,
  inspectSource,
  normalizeOoxmlPartForFallback,
  readCanonicalSource,
} from "@/lib/import/parse";

const NS = SPREADSHEETML_NS;
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";

/** Build a minimal .xlsx whose spreadsheetml elements are `x:`-prefixed and
 *  which declares a worksheet table — then return it as a file on disk. */
async function writePrefixedXlsx(): Promise<string> {
  const zip = new JSZip();

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
      `<Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>` +
      `</Types>`,
  );

  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="${PKG}">` +
      `<Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`,
  );

  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<x:workbook xmlns:x="${NS}"><x:sheets>` +
      `<x:sheet name="properties" sheetId="1" r:id="rId1" xmlns:r="${R}"/>` +
      `</x:sheets></x:workbook>`,
  );

  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="${PKG}">` +
      `<Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId2" Type="${R}/styles" Target="styles.xml"/>` +
      `<Relationship Id="rId3" Type="${R}/sharedStrings" Target="sharedStrings.xml"/>` +
      `</Relationships>`,
  );

  const cell = (ref: string, text: string) =>
    `<x:c r="${ref}" t="inlineStr"><x:is><x:t>${text}</x:t></x:is></x:c>`;
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<x:worksheet xmlns:x="${NS}"><x:sheetData>` +
      `<x:row r="1">${cell("A1", "source_property_id")}${cell("B1", "property_name")}</x:row>` +
      `<x:row r="2">${cell("A2", "zzc-1")}${cell("B2", "ZZ Prefixed Hotel")}</x:row>` +
      `</x:sheetData>` +
      `<x:tableParts count="1"><x:tablePart r:id="rId1" xmlns:r="${R}"/></x:tableParts>` +
      `</x:worksheet>`,
  );

  zip.file(
    "xl/worksheets/_rels/sheet1.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="${PKG}">` +
      `<Relationship Id="rId1" Type="${R}/table" Target="../tables/table1.xml"/>` +
      `</Relationships>`,
  );

  zip.file(
    "xl/tables/table1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<x:table xmlns:x="${NS}" id="1" name="Table1" displayName="Table1" ref="A1:B2">` +
      `<x:tableColumns count="2"><x:tableColumn id="1" name="source_property_id"/>` +
      `<x:tableColumn id="2" name="property_name"/></x:tableColumns></x:table>`,
  );

  zip.file(
    "xl/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<x:styleSheet xmlns:x="${NS}">` +
      `<x:fonts count="1"><x:font><x:sz val="11"/><x:name val="Calibri"/></x:font></x:fonts>` +
      `<x:fills count="1"><x:fill><x:patternFill patternType="none"/></x:fill></x:fills>` +
      `<x:borders count="1"><x:border/></x:borders>` +
      `<x:cellStyleXfs count="1"><x:xf/></x:cellStyleXfs>` +
      `<x:cellXfs count="1"><x:xf/></x:cellXfs></x:styleSheet>`,
  );

  zip.file(
    "xl/sharedStrings.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<x:sst xmlns:x="${NS}" count="0" uniqueCount="0"/>`,
  );

  const dir = await mkdtemp(path.join(os.tmpdir(), "theugc-prefixed-"));
  const file = path.join(dir, "prefixed.xlsx");
  await writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
  return file;
}

/** A normal, ExcelJS-written workbook (default namespace, no table defs). */
async function writeNormalXlsx(): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("properties");
  ws.addRow(["source_property_id", "property_name"]);
  ws.addRow(["zzn-1", "ZZ Normal Hotel"]);
  const dir = await mkdtemp(path.join(os.tmpdir(), "theugc-normal-"));
  const file = path.join(dir, "normal.xlsx");
  await wb.xlsx.writeFile(file);
  return file;
}

/** A valid ZIP shaped like an .xlsx but with no parseable workbook and nothing
 *  the fallback normalization can act on (no spreadsheetml binding, no tables). */
async function writeUnparseableXlsx(): Promise<string> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="xml" ContentType="application/xml"/></Types>`,
  );
  // Present but not a workbook ExcelJS can parse; no `xmlns:x` spreadsheetml bind.
  zip.file("xl/notaworkbook.xml", `<?xml version="1.0"?><garbage/>`);
  const dir = await mkdtemp(path.join(os.tmpdir(), "theugc-bad-"));
  const file = path.join(dir, "corrupt.xlsx");
  await writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
  return file;
}

describe("namespace-prefixed OOXML reader robustness", () => {
  it("P3.1: inspects a prefixed workbook with table definitions", async () => {
    const file = await writePrefixedXlsx();
    const inspection = await inspectSource(file);
    const props = inspection.sheets.find((s) => s.name.toLowerCase() === "properties");
    expect(props).toBeDefined();
    expect(props!.kind).toBe("property");
    expect(props!.columns).toEqual(["source_property_id", "property_name"]);
    expect(props!.rowCount).toBe(1);
  });

  it("P3.1: reads canonical rows from a prefixed workbook without altering data", async () => {
    const file = await writePrefixedXlsx();
    const sheets = await readCanonicalSource({ file });
    expect(sheets.properties).toHaveLength(1);
    expect(sheets.properties[0]!.data.source_property_id).toBe("zzc-1");
    expect(sheets.properties[0]!.data.property_name).toBe("ZZ Prefixed Hotel");
  });

  it("P3.2: a normal ExcelJS-readable workbook parses unchanged via the normal path", async () => {
    // A default-namespace workbook is read by ExcelJS directly (worksheets > 0),
    // so the fallback never runs; the data must round-trip intact.
    const file = await writeNormalXlsx();
    const sheets = await readCanonicalSource({ file });
    expect(sheets.properties).toHaveLength(1);
    expect(sheets.properties[0]!.data.source_property_id).toBe("zzn-1");
    expect(sheets.properties[0]!.data.property_name).toBe("ZZ Normal Hotel");
  });

  it("P3.3: an unparseable package with no applicable normalization throws (never zero sheets)", async () => {
    const file = await writeUnparseableXlsx();
    await expect(readCanonicalSource({ file })).rejects.toThrow(/Unable to read workbook/i);
    await expect(inspectSource(file)).rejects.toThrow(/Unable to read workbook/i);
  });
});

describe("P3.4 — scoped namespace rewrite (normalizeOoxmlPartForFallback)", () => {
  it("strips the x: prefix only when the part binds x to spreadsheetml", () => {
    const part = `<x:worksheet xmlns:x="${NS}"><x:sheetData><x:row/></x:sheetData></x:worksheet>`;
    const out = normalizeOoxmlPartForFallback(part);
    expect(out).toContain(`<worksheet xmlns="${NS}">`);
    expect(out).not.toContain("<x:");
    expect(out).not.toContain(`xmlns:x="${NS}"`);
  });

  it("leaves an x: prefix bound to an UNRELATED namespace untouched", () => {
    const other = `<x:root xmlns:x="http://example.com/other"><x:node>keep me</x:node></x:root>`;
    expect(normalizeOoxmlPartForFallback(other)).toBe(other);
  });

  it("detaches table references but not unrelated markup", () => {
    const ws =
      `<x:worksheet xmlns:x="${NS}"><x:sheetData/>` +
      `<x:tableParts count="1"><x:tablePart r:id="rId1"/></x:tableParts></x:worksheet>`;
    const out = normalizeOoxmlPartForFallback(ws);
    expect(out).not.toContain("tableParts");
    expect(out).toContain("<sheetData/>");
  });
});
