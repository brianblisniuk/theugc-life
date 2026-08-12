/**
 * Import pipeline DB integration (IMPORT_SPEC.md §2, §11; D032). Synthetic
 * fixtures only. Proves staging + dry-run + idempotency, and — critically — that
 * seed import creates NO creator intelligence and promotes NOTHING to canonical
 * hotel/contact tables (Sprint 1A stop condition).
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dryRunFile } from "@/lib/import/pipeline";

import { hasTestDb, setupDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const PROPERTIES_CSV = [
  "source_property_id,property_name,hotel_type,star_rating,country_code,city,destination_name,website_url,source_url",
  "sp1,Pipe Alila,resort,5,ID,Ubud,PipeUbud,https://pipe-alila.com/ubud,https://pipe-alila.com",
  "sp2,Unknown Place Hotel,hotel,,ID,,ZzNowhereDest,,https://src.example",
  "sp3,No Contact Hotel,hotel,,ID,,PipeUbud,,https://src.example",
].join("\n");

const CONTACTS_CSV = [
  "source_property_id,contact_name,job_title,department,email,contact_scope,verification_status,source_url,verified_at",
  "sp1,Jane Doe,Marketing Manager,marketing,jane.doe@pipe-alila.com,property,verified,https://pipe-alila.com,2026-01-01",
  "sp1,,,,info [at] pipe-alila [dot] com,property,unverified,,",
  "sp2,,,general,info@unknown.com,property,unverified,,",
].join("\n");

const EVIDENCE_CSV = [
  "source_property_id,claim_type,source_type,source_url,verification_status,observed_at",
  "sp1,creator_collaboration_evidence,reputable_third_party,https://blog.example,probable,",
].join("\n");

let client: Client;
let dir: string;
let files: { properties: string; contacts: string; evidence: string };

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();
  client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();

  // Seed one existing canonical destination + hotel so a deterministic match exists.
  await client.query(
    `insert into public.destinations (id, name, slug, type, country_code)
       values ('c1000000-0000-0000-0000-000000000001','PipeUbud','pipe-ubud','area','ID')`,
  );
  await client.query(
    `insert into public.hotels (id, name, slug, destination_id, website_url)
       values ('c2000000-0000-0000-0000-000000000001','Pipe Alila','pipe-alila',
               'c1000000-0000-0000-0000-000000000001','https://pipe-alila.com/ubud')`,
  );

  dir = await mkdtemp(path.join(os.tmpdir(), "theugc-pipe-"));
  files = {
    properties: path.join(dir, "properties.csv"),
    contacts: path.join(dir, "contacts.csv"),
    evidence: path.join(dir, "evidence.csv"),
  };
  await writeFile(files.properties, PROPERTIES_CSV, "utf8");
  await writeFile(files.contacts, CONTACTS_CSV, "utf8");
  await writeFile(files.evidence, EVIDENCE_CSV, "utf8");
});

afterAll(async () => {
  if (client) await client.end();
});

d("standard importer dry-run", () => {
  it("stages, resolves, and reports the canonical workbook", async () => {
    const result = await dryRunFile(client, {
      file: files.properties,
      contacts: files.contacts,
      evidence: files.evidence,
      sourceName: "synthetic-canonical",
    });
    const s = result.report.summary;

    expect(s.properties).toBe(3);
    expect(s.contacts).toBe(3);
    expect(s.evidence).toBe(1);
    // jane valid + info@unknown valid = 2; masked one contributes to masked count.
    expect(s.validEmails).toBe(2);
    expect(s.maskedEmails).toBe(1);
    // sp1 matches the seeded hotel deterministically.
    expect(s.deterministicSafeMatches).toBeGreaterThanOrEqual(1);
    // sp2's destination is unknown.
    expect(s.unresolvedDestinations).toBe(1);
    // sp3 has no contact.
    expect(s.noContactProperties).toBe(1);

    // Report files were written under the gitignored reports dir.
    expect(result.paths.json).toContain("data/imports/reports");
    expect(result.paths.md).toContain("data/imports/reports");
  });

  it("is idempotent: re-running the same file reuses the batch (no duplication)", async () => {
    const first = await dryRunFile(client, {
      file: files.properties,
      contacts: files.contacts,
      evidence: files.evidence,
      sourceName: "synthetic-canonical",
    });
    const second = await dryRunFile(client, {
      file: files.properties,
      contacts: files.contacts,
      evidence: files.evidence,
      sourceName: "synthetic-canonical",
    });
    expect(second.reused).toBe(true);
    expect(second.batchId).toBe(first.batchId);

    const batchCount = await client.query<{ n: string }>(
      "select count(*)::text as n from public.import_batches where source_name = 'synthetic-canonical'",
    );
    expect(Number(batchCount.rows[0]!.n)).toBe(1);
  });

  it("promotes NOTHING to canonical hotel/contact tables", async () => {
    // Only the single seeded hotel exists; import created no new hotels/contacts.
    const hotels = await client.query<{ n: string }>("select count(*)::text n from public.hotels");
    const contacts = await client.query<{ n: string }>(
      "select count(*)::text n from public.hotel_contacts",
    );
    expect(Number(hotels.rows[0]!.n)).toBe(1);
    expect(Number(contacts.rows[0]!.n)).toBe(0);
  });

  it("seeds NO creator intelligence (D027): events/metrics remain empty", async () => {
    for (const table of ["outreach_events", "hotel_intelligence", "destination_intelligence"]) {
      const res = await client.query<{ n: string }>(`select count(*)::text n from public.${table}`);
      expect(Number(res.rows[0]!.n)).toBe(0);
    }
  });
});
