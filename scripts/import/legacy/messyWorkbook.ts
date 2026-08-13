/**
 * Generic messy-workbook legacy adapter (CSV/XLSX). Handles the common quirks of
 * the current legacy research spreadsheets — repeated header rows, column-name
 * variance, narrative columns, and multiple emails in one cell — and emits clean
 * canonical raw sheets. Ugly internally by design; clean output (D030).
 *
 * It never fabricates identity: a property must have a name; unmapped geography
 * falls back to the source's known default (or stays empty for downstream review).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import ExcelJS from "exceljs";
import Papa from "papaparse";

import { emptyRawSheets, legacyRow, type LegacyAdapter } from "../../../src/lib/import/legacy";
import { extractEmails, foldForMatch, normalizeString } from "../../../src/lib/import/normalize";
import type { RawRow, RawSheets } from "../../../src/lib/import/parse";

export interface WorkbookAdapterConfig {
  key: string;
  description: string;
  parserName: string;
  parserVersion: string;
  defaultCountryCode?: string;
  defaultDestination?: string;
  /** Contact-heavy sheets: each data row is primarily a contact for a property. */
  contactHeavy?: boolean;
}

// Canonical field <- legacy header synonyms (folded for comparison).
const SYNONYMS: Record<string, string[]> = {
  property_name: [
    "hotel",
    "hotel name",
    "property",
    "property name",
    "name",
    "accommodation",
    "establishment",
    "resort",
  ],
  brand_name: ["brand", "chain", "group brand", "brand name"],
  hotel_type: ["type", "category", "property type", "hotel type", "segment"],
  star_rating: ["stars", "star", "rating", "star rating"],
  country_code: ["country", "country code"],
  region: ["region", "state", "emirate", "province"],
  city: ["city", "town"],
  destination_name: [
    "destination",
    "area",
    "neighbourhood",
    "neighborhood",
    "location",
    "district",
  ],
  parent_destination_name: ["parent destination", "region group"],
  address: ["address", "location address", "street"],
  website_url: ["website", "url", "site", "web", "web site"],
  instagram_url: ["instagram", "ig", "insta", "instagram url"],
  source_url: ["source", "source url", "reference", "link", "citation", "evidence"],
  email: ["email", "e mail", "emails", "contact email", "mail", "e-mail"],
  contact_name: ["contact", "contact name", "person", "name of contact", "contact person"],
  job_title: ["title", "role", "position", "job title", "designation"],
  department: ["department", "dept"],
  phone: ["phone", "tel", "telephone", "mobile", "whatsapp", "contact number"],
  linkedin_url: ["linkedin", "linkedin url"],
  verification_status: ["verification", "verified", "status", "verification status", "confidence"],
  contact_scope: ["scope", "contact scope"],
  organization_name: [
    "organization",
    "organisation",
    "organization name",
    "organisation name",
    "company",
    "company name",
    "group name",
    "operator name",
    "agency name",
    "management company",
  ],
  notes: ["notes", "note", "comments", "remarks", "description"],
};

export const HEADER_LOOKUP: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [canonical, aliases] of Object.entries(SYNONYMS)) {
    for (const alias of aliases) map[foldForMatch(alias)] = canonical;
  }
  return map;
})();

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const v = value as { text?: unknown; result?: unknown; hyperlink?: unknown };
    if (typeof v.text === "string") return v.text.trim();
    if (typeof v.result === "string" || typeof v.result === "number")
      return String(v.result).trim();
    if (typeof v.hyperlink === "string") return v.hyperlink.trim();
    return "";
  }
  return String(value).trim();
}

interface Grid {
  sheet: string;
  rows: string[][];
}

async function readGrid(filePath: string): Promise<Grid[]> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".xlsx") {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    return wb.worksheets.map((ws) => {
      const rows: string[][] = [];
      ws.eachRow({ includeEmpty: false }, (row) => {
        const arr = row.values as unknown[]; // 1-indexed; [0] is empty
        const vals: string[] = [];
        for (let i = 1; i < arr.length; i++) vals.push(cellText(arr[i]));
        rows.push(vals);
      });
      return { sheet: ws.name, rows };
    });
  }
  if (ext === ".csv") {
    const content = await readFile(filePath, "utf8");
    const parsed = Papa.parse<string[]>(content, { skipEmptyLines: "greedy" });
    return [
      { sheet: "sheet1", rows: parsed.data.map((r) => r.map((c) => String(c ?? "").trim())) },
    ];
  }
  throw new Error(`Unsupported legacy workbook type: ${ext}`);
}

/** Map a header row to canonical field names; null when it isn't a header. */
function detectHeader(row: string[]): (string | null)[] | null {
  const mapped = row.map((cell) => HEADER_LOOKUP[foldForMatch(cell)] ?? null);
  const hits = mapped.filter((m) => m !== null).length;
  return hits >= 2 ? mapped : null;
}

export function makeWorkbookAdapter(config: WorkbookAdapterConfig): LegacyAdapter {
  return {
    key: config.key,
    description: config.description,
    parserName: config.parserName,
    parserVersion: config.parserVersion,
    async parse(filePath: string): Promise<RawSheets> {
      const grids = await readGrid(filePath);
      const sheets = emptyRawSheets();

      // Stable property keys shared by a property and its contacts.
      const propKeyByIdentity = new Map<string, string>();
      let propCounter = 0;
      let outRowNum = 0;

      for (const grid of grids) {
        let header: (string | null)[] | null = null;
        let headerSignature = "";

        for (let r = 0; r < grid.rows.length; r++) {
          const row = grid.rows[r]!;
          const signature = row.join("");

          if (!header) {
            const detected = detectHeader(row);
            if (detected) {
              header = detected;
              headerSignature = signature;
            }
            continue;
          }
          // Skip repeated header rows (a common legacy artifact).
          if (signature === headerSignature) continue;

          const rec: Record<string, string> = {};
          header.forEach((canonical, idx) => {
            if (!canonical) return;
            const val = normalizeString(row[idx]);
            if (val) rec[canonical] = val;
          });

          const propertyName = rec.property_name ?? null;
          if (!propertyName) continue; // no identity → drop (LEGACY §5)

          const destination = rec.destination_name ?? config.defaultDestination ?? null;
          const country = rec.country_code ?? config.defaultCountryCode ?? null;

          const identity = `${foldForMatch(propertyName)}|${foldForMatch(destination ?? "")}`;
          let propKey = propKeyByIdentity.get(identity);
          if (!propKey) {
            propKey = `${config.key}:${++propCounter}`;
            propKeyByIdentity.set(identity, propKey);

            outRowNum++;
            const propValues: Record<string, string | null> = {
              source_property_id: propKey,
              property_name: propertyName,
              brand_name: rec.brand_name ?? null,
              hotel_type: rec.hotel_type ?? null,
              star_rating: rec.star_rating ?? null,
              country_code: country,
              region: rec.region ?? null,
              city: rec.city ?? null,
              destination_name: destination,
              parent_destination_name: rec.parent_destination_name ?? null,
              address: rec.address ?? null,
              website_url: rec.website_url ?? null,
              instagram_url: rec.instagram_url ?? null,
              source_url: rec.source_url ?? null,
              notes: rec.notes ?? null,
            };
            sheets.properties.push(legacyRow("properties", outRowNum, propValues, row));
          }

          // Contacts: split multiple emails in one cell into separate contacts.
          const emailCell = rec.email ?? "";
          const extraction = extractEmails(emailCell);
          const emails = extraction.emails;
          const contactBase = {
            source_property_id: propKey,
            contact_name: rec.contact_name ?? null,
            job_title: rec.job_title ?? null,
            department: rec.department ?? null,
            phone: rec.phone ?? null,
            linkedin_url: rec.linkedin_url ?? null,
            contact_scope: rec.contact_scope ?? null,
            organization_name: rec.organization_name ?? null,
            verification_status: rec.verification_status ?? null,
            source_url: rec.source_url ?? null,
            notes: rec.notes ?? null,
          };

          if (emails.length > 1) {
            for (const email of emails) {
              outRowNum++;
              sheets.contacts.push(
                legacyRow("contacts", outRowNum, { ...contactBase, email }, row),
              );
            }
          } else if (emails.length === 1) {
            outRowNum++;
            sheets.contacts.push(
              legacyRow("contacts", outRowNum, { ...contactBase, email: emails[0]! }, row),
            );
          } else if (emailCell || rec.contact_name || rec.phone || config.contactHeavy) {
            // Keep the (possibly masked/empty) cell so staging can classify it.
            outRowNum++;
            sheets.contacts.push(
              legacyRow("contacts", outRowNum, { ...contactBase, email: emailCell || null }, row),
            );
          }
        }
      }

      return sheets;
    },
  };
}

// Re-export the row type for adapter tests.
export type { RawRow };
