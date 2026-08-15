/**
 * Dubai pilot probe — INPUT PREPARATION ONLY (brief §15).
 *
 *   npx tsx scripts/provider-evaluation/pilot-probe.ts
 *
 * Reads the local, gitignored Sprint 1C Dubai pilot workbook and writes a probe
 * input list under `.data/provider-evaluation/` (also gitignored). That list is
 * the "do the providers know about the properties we already researched?" input.
 *
 * Three hard boundaries:
 *
 *  - It reads a LOCAL FILE. It never contacts production Supabase, so it cannot
 *    read or modify the 30 canonical rows. The workbook is the same artifact the
 *    pilot was imported from, which makes it a safe stand-in for their identity.
 *  - It writes only under `.data/`, which is gitignored. The pilot workbook is
 *    private research data and neither it nor its contents may be committed.
 *  - It resolves NOTHING. The output is an input to a future probe, not a match.
 *
 * The 30-property pilot is a TECHNICAL PILOT (D061). It is not Dubai inventory
 * and must never be used as a coverage baseline; here it is only a match-rate
 * probe against data we already trust.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { readCanonicalSource, type RawRow } from "@/lib/import/parse";

import { writeArtifact } from "./artifacts";
import { createSafeLogger, collectSecretValues } from "./redact";

const PILOT_WORKBOOK = "data/imports/raw/theugc-life_Sprint1C_Dubai_Pilot_30.xlsx";

export interface PilotProbeEntry {
  sourcePropertyId: string | null;
  name: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  websiteUrl: string | null;
  starRating: number | null;
}

export interface PilotProbeInput {
  sourceArtifact: string;
  entryCount: number;
  entries: PilotProbeEntry[];
  /** Fields present often enough to be usable as matching signals. */
  usableMatchSignals: string[];
  notes: string[];
}

function pick(row: RawRow, column: string): string | null {
  const value = row.data[column];
  if (value === null || value === undefined) return null;
  const text = value.trim();
  return text === "" ? null : text;
}

function pickNumber(row: RawRow, column: string): number | null {
  const text = pick(row, column);
  if (text === null) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildProbeEntries(rows: readonly RawRow[]): PilotProbeEntry[] {
  const entries: PilotProbeEntry[] = [];
  for (const row of rows) {
    const name = pick(row, "property_name");
    // A row without a name cannot identify a property to probe for.
    if (!name) continue;
    entries.push({
      sourcePropertyId: pick(row, "source_property_id"),
      name,
      address: pick(row, "address"),
      latitude: pickNumber(row, "latitude"),
      longitude: pickNumber(row, "longitude"),
      websiteUrl: pick(row, "website_url"),
      starRating: pickNumber(row, "star_rating"),
    });
  }
  return entries;
}

export function summariseProbe(entries: readonly PilotProbeEntry[]): {
  usableMatchSignals: string[];
  notes: string[];
} {
  const withCoords = entries.filter((e) => e.latitude !== null && e.longitude !== null).length;
  const withWebsite = entries.filter((e) => e.websiteUrl !== null).length;
  const withAddress = entries.filter((e) => e.address !== null).length;
  const withStars = entries.filter((e) => e.starRating !== null).length;

  const usableMatchSignals = ["name"];
  if (withCoords > 0) usableMatchSignals.push("coordinates");
  if (withWebsite > 0) usableMatchSignals.push("website domain");
  if (withAddress > 0) usableMatchSignals.push("address");

  const notes = [
    "TECHNICAL PILOT ONLY (D061). Not Dubai inventory and not a coverage baseline.",
    `Coordinates present on ${withCoords}/${entries.length} entries.`,
    `Website present on ${withWebsite}/${entries.length} entries.`,
    `Address present on ${withAddress}/${entries.length} entries.`,
    `Star value present on ${withStars}/${entries.length} entries (research value; provenance not established).`,
  ];
  if (withCoords === 0) {
    notes.push(
      "No coordinates in the pilot artifact: coordinate agreement cannot be measured in the probe, and matching leans on name plus website/address.",
    );
  }
  return { usableMatchSignals, notes };
}

export async function buildPilotProbeInput(workbookPath: string): Promise<PilotProbeInput> {
  const sheets = await readCanonicalSource({ file: workbookPath });
  const entries = buildProbeEntries(sheets.properties);
  const { usableMatchSignals, notes } = summariseProbe(entries);

  return {
    sourceArtifact: workbookPath,
    entryCount: entries.length,
    entries,
    usableMatchSignals,
    notes,
  };
}

async function main(): Promise<void> {
  const log = createSafeLogger(collectSecretValues());
  const path = resolve(process.cwd(), PILOT_WORKBOOK);

  if (!existsSync(path)) {
    log(`DUBAI PILOT MATCH PROBE = BLOCKED — artifact not locally available.`);
    log(`Expected gitignored artifact at: ${PILOT_WORKBOOK}`);
    log("");
    log("Do not invent the pilot identity list and do not query production to");
    log("reconstruct it. Supply the workbook locally, or export the 30 canonical");
    log("identities (name, address, coordinates, website) through an approved");
    log("admin path into that location.");
    process.exitCode = 1;
    return;
  }

  const input = await buildPilotProbeInput(path);
  const written = writeArtifact("dubai-pilot-probe-input.json", input);

  // Count and signal availability only — never property-level content.
  log(`Dubai pilot probe input prepared: ${input.entryCount} entries.`);
  log(`Usable match signals: ${input.usableMatchSignals.join(", ")}`);
  for (const note of input.notes) log(`  - ${note}`);
  log(`Artifact (gitignored): ${written}`);
  log("");
  log("Probe EXECUTION remains blocked until at least one provider adapter is");
  log("verified and credentialed. This step only prepares the input.");
}

// Only run when invoked directly, so the builder stays unit-testable.
if (process.argv[1]?.endsWith("pilot-probe.ts")) {
  void main();
}
