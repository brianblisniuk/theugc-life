/**
 * Legacy Markdown research adapter. Parses a structured research Markdown file
 * (one property per `##` section, key/value lines, and contact lines/emails)
 * into canonical raw sheets. Heuristic and isolated; clean output only (D030).
 */
import { readFile } from "node:fs/promises";

import { emptyRawSheets, legacyRow, type LegacyAdapter } from "../../../src/lib/import/legacy";
import { extractEmails, foldForMatch, normalizeString } from "../../../src/lib/import/normalize";
import type { RawSheets } from "../../../src/lib/import/parse";

import { HEADER_LOOKUP } from "./messyWorkbook";

export interface MarkdownAdapterConfig {
  key: string;
  description: string;
  parserName: string;
  parserVersion: string;
  defaultCountryCode?: string;
  defaultDestination?: string;
}

function slug(text: string): string {
  return foldForMatch(text).replace(/\s+/g, "-").slice(0, 60);
}

function stripBullet(line: string): string {
  return line.replace(/^\s*[-*+]\s+/, "").trim();
}

export function makeMarkdownAdapter(config: MarkdownAdapterConfig): LegacyAdapter {
  return {
    key: config.key,
    description: config.description,
    parserName: config.parserName,
    parserVersion: config.parserVersion,
    async parse(filePath: string): Promise<RawSheets> {
      const content = await readFile(filePath, "utf8");
      const lines = content.split(/\r?\n/);
      const sheets = emptyRawSheets();

      // Split into property sections at `## ` headings.
      const sections: { name: string; body: string[] }[] = [];
      let current: { name: string; body: string[] } | null = null;
      for (const line of lines) {
        const h2 = line.match(/^##\s+(.+?)\s*$/);
        if (h2 && !line.startsWith("###")) {
          if (current) sections.push(current);
          current = { name: h2[1]!.trim(), body: [] };
        } else if (current) {
          current.body.push(line);
        }
      }
      if (current) sections.push(current);

      let outRowNum = 0;
      let propCounter = 0;

      for (const section of sections) {
        const propertyName = normalizeString(section.name);
        if (!propertyName) continue;

        const propKey = `${config.key}:${slug(propertyName)}:${++propCounter}`;
        const fields: Record<string, string> = {};
        const contactLines: string[] = [];

        for (const rawLine of section.body) {
          const line = stripBullet(rawLine);
          if (!line) continue;

          // key: value line
          const kv = line.match(/^([A-Za-z][A-Za-z /_-]{1,30}):\s*(.+)$/);
          if (kv) {
            const canonical = HEADER_LOOKUP[foldForMatch(kv[1]!)];
            const value = normalizeString(kv[2]);
            if (canonical && value) {
              // Route contact-ish keys to contact parsing; property keys to fields.
              if (
                [
                  "email",
                  "contact_name",
                  "job_title",
                  "department",
                  "phone",
                  "linkedin_url",
                ].includes(canonical)
              ) {
                contactLines.push(line);
              } else {
                fields[canonical] = value;
              }
              continue;
            }
          }
          // Any line containing an email is a contact line.
          if (extractEmails(line).emails.length > 0) contactLines.push(line);
        }

        const destination = fields.destination_name ?? config.defaultDestination ?? null;
        const country = fields.country_code ?? config.defaultCountryCode ?? null;

        outRowNum++;
        sheets.properties.push(
          legacyRow(
            "properties",
            outRowNum,
            {
              source_property_id: propKey,
              property_name: propertyName,
              brand_name: fields.brand_name ?? null,
              hotel_type: fields.hotel_type ?? null,
              star_rating: fields.star_rating ?? null,
              country_code: country,
              region: fields.region ?? null,
              city: fields.city ?? null,
              destination_name: destination,
              address: fields.address ?? null,
              website_url: fields.website_url ?? null,
              instagram_url: fields.instagram_url ?? null,
              source_url: fields.source_url ?? null,
              notes: fields.notes ?? null,
            },
            section.name,
          ),
        );

        for (const line of contactLines) {
          const emails = extractEmails(line).emails;
          // Name = text before the first email / before a comma, best-effort.
          const beforeEmail = line.split(/[<(]|\s\S+@\S+/)[0] ?? "";
          const namePart = normalizeString(beforeEmail.replace(/^(contact|email)\s*:?/i, ""));
          const contactValues = (email: string | null) => ({
            source_property_id: propKey,
            contact_name: namePart,
            job_title: null,
            department: null,
            email,
            phone: null,
            linkedin_url: null,
            contact_scope: null,
            // Only an explicit "Organization:" line becomes an org name (F1).
            organization_name: fields.organization_name ?? null,
            verification_status: null,
            source_url: fields.source_url ?? null,
            notes: null,
          });
          if (emails.length === 0) {
            outRowNum++;
            sheets.contacts.push(legacyRow("contacts", outRowNum, contactValues(null), line));
          } else {
            for (const email of emails) {
              outRowNum++;
              sheets.contacts.push(legacyRow("contacts", outRowNum, contactValues(email), line));
            }
          }
        }
      }

      return sheets;
    },
  };
}
