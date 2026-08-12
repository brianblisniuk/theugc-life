/**
 * Legacy adapter tests (IMPORT_SPEC.md §10). Synthetic messy inputs prove the
 * adapters emit clean canonical staging: repeated headers dropped, multiple
 * emails split, ambiguous multi-property rows flagged, generic mailboxes and
 * named contacts distinguished, group/agency scope surfaced as organizations.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ContactRecord, PropertyRecord } from "@/lib/import/contract";
import { resolveEntities } from "@/lib/import/resolve";
import { stageRawSheets } from "@/lib/import/stage";

import { makeWorkbookAdapter } from "../../scripts/import/legacy/messyWorkbook";
import { makeMarkdownAdapter } from "../../scripts/import/legacy/markdownResearch";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "theugc-import-"));
});

afterAll(async () => {
  // Temp fixtures live under the OS temp dir; nothing to clean in the repo.
});

const MESSY_CSV = [
  "Hotel Name,Destination,Website,Email,Contact,Title,Scope,Verification",
  'Grand Palace,Dubai,https://grandpalace.ae,"info@grandpalace.ae; sales@grandpalace.ae",Front Desk,Reception,property,verified',
  // repeated header row (legacy artifact)
  "Hotel Name,Destination,Website,Email,Contact,Title,Scope,Verification",
  "Azure Group,Dubai,https://azuregroup.ae,pr@azuregroup.ae,Jane Roe,PR Manager,group,verified",
  "Villa One / Villa Two,Dubai,,,,,,",
  "Marina Suites,Dubai,https://marina.ae,jane.doe@marina.ae,Jane Doe,Marketing,property,probable",
].join("\n");

describe("messy workbook adapter (CSV)", () => {
  it("produces clean canonical staging from messy input", async () => {
    const file = path.join(dir, "messy.csv");
    await writeFile(file, MESSY_CSV, "utf8");

    const adapter = makeWorkbookAdapter({
      key: "test-wb",
      description: "test",
      parserName: "legacy-test",
      parserVersion: "1.0.0",
      defaultCountryCode: "AE",
    });
    const sheets = await adapter.parse(file);

    // 4 distinct properties (repeated header row dropped).
    expect(sheets.properties).toHaveLength(4);
    // Grand Palace's two emails split into two contacts (+ Azure + Marina).
    expect(sheets.contacts).toHaveLength(4);

    const staged = stageRawSheets(sheets);

    // The two Grand Palace contacts carry distinct generic-mailbox emails.
    const gpContacts = staged.rows
      .filter((r) => r.rowKind === "contact")
      .map((r) => r.normalized as unknown as ContactRecord)
      .filter((c) => c.email?.endsWith("@grandpalace.ae"));
    expect(new Set(gpContacts.map((c) => c.email))).toEqual(
      new Set(["info@grandpalace.ae", "sales@grandpalace.ae"]),
    );
    expect(gpContacts.every((c) => c.isGenericMailbox)).toBe(true);

    // Named marketing contact is not a generic mailbox.
    const marina = staged.rows
      .filter((r) => r.rowKind === "contact")
      .map((r) => r.normalized as unknown as ContactRecord)
      .find((c) => c.email === "jane.doe@marina.ae");
    expect(marina?.isGenericMailbox).toBe(false);
    expect(marina?.jobTitle).toBe("Marketing");

    // Ambiguous multi-property row is flagged for review, never split silently.
    const villa = staged.rows.find(
      (r) =>
        r.rowKind === "property" &&
        (r.normalized as unknown as PropertyRecord | null)?.propertyName ===
          "Villa One / Villa Two",
    );
    expect(villa?.status).toBe("review");
    expect(villa?.warnings.some((w) => w.includes("multi-property"))).toBe(true);

    // Group scope surfaces an organization candidate (not a fake hotel).
    const resolution = resolveEntities(staged.rows, { hotels: [], destinations: [] });
    expect(resolution.organizationCandidates.some((o) => o.scope === "group")).toBe(true);
  });
});

const RESEARCH_MD = [
  "# Florianópolis research",
  "",
  "## Hotel Boutique Sol",
  "Website: https://sol.com.br",
  "Type: Boutique Hotel",
  "Contact: Ana Lima, Marketing, ana@sol.com.br",
  "",
  "## Pousada Mar",
  "Email: contato@mar.com.br",
  "",
].join("\n");

describe("markdown research adapter", () => {
  it("parses sections into canonical properties + contacts", async () => {
    const file = path.join(dir, "research.md");
    await writeFile(file, RESEARCH_MD, "utf8");

    const adapter = makeMarkdownAdapter({
      key: "test-md",
      description: "test",
      parserName: "legacy-md-test",
      parserVersion: "1.0.0",
      defaultCountryCode: "BR",
      defaultDestination: "Florianópolis",
    });
    const sheets = await adapter.parse(file);

    expect(sheets.properties).toHaveLength(2);
    const staged = stageRawSheets(sheets);
    const contacts = staged.rows
      .filter((r) => r.rowKind === "contact")
      .map((r) => r.normalized as unknown as ContactRecord);
    expect(contacts.some((c) => c.email === "ana@sol.com.br")).toBe(true);
    expect(contacts.some((c) => c.email === "contato@mar.com.br")).toBe(true);

    // Default geography applied so rows are not needlessly unresolved.
    const props = staged.rows
      .filter((r) => r.rowKind === "property")
      .map((r) => r.normalized as unknown as PropertyRecord);
    expect(props.every((p) => p.countryCode === "BR")).toBe(true);
  });
});
