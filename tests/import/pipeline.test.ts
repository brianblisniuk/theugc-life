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

import { loadExistingData } from "@/lib/import/db";
import { readCanonicalSource } from "@/lib/import/parse";
import { dryRunFile } from "@/lib/import/pipeline";
import { resolveEntities } from "@/lib/import/resolve";
import { stageRawSheets } from "@/lib/import/stage";

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

async function errorCode(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await client.query(sql, params);
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? "error";
  }
}

d("import DB backstops (review F3 / F4)", () => {
  it("F3: a second non-failed batch with the same file+parser identity is rejected", async () => {
    await client.query(
      `insert into public.import_batches (source_name, source_kind, parser_name, parser_version, file_sha256, status)
         values ('race','canonical','pX','1','SHA_F3_A','parsing')`,
    );
    const code = await errorCode(
      `insert into public.import_batches (source_name, source_kind, parser_name, parser_version, file_sha256, status)
         values ('race2','canonical','pX','1','SHA_F3_A','parsing')`,
    );
    expect(code).toBe("23505");
  });

  it("F3: a FAILED batch does not block a legitimate retry", async () => {
    await client.query(
      "update public.import_batches set status='failed' where file_sha256='SHA_F3_A'",
    );
    // Same identity can now be staged again because the prior one is failed.
    const code = await errorCode(
      `insert into public.import_batches (source_name, source_kind, parser_name, parser_version, file_sha256, status)
         values ('retry','canonical','pX','1','SHA_F3_A','parsing')`,
    );
    expect(code).toBeNull();
  });

  it("F4: duplicate NULL-sheet rows in the same batch are rejected", async () => {
    const b = await client.query<{ id: string }>(
      `insert into public.import_batches (source_name, source_kind, parser_name, parser_version)
         values ('nosheet','legacy','md','1') returning id`,
    );
    const batchId = b.rows[0]!.id;
    await client.query(
      `insert into public.import_rows (import_batch_id, sheet_name, source_row_number, row_kind, raw_fingerprint, validation_status)
         values ($1, null, 1, 'property', 'fp-a', 'valid')`,
      [batchId],
    );
    const code = await errorCode(
      `insert into public.import_rows (import_batch_id, sheet_name, source_row_number, row_kind, raw_fingerprint, validation_status)
         values ($1, null, 1, 'property', 'fp-b', 'valid')`,
      [batchId],
    );
    expect(code).toBe("23505");
  });
});

d("organization identity round-trip (review F5)", () => {
  const PERSON = "Jane Roe";
  const EMAIL = "jane.roe@prfirm.com";
  const PROP_KEY = "pf5";
  const ORG_NAME = "Example PR Agency";

  const F5_PROPERTIES = [
    "source_property_id,property_name,country_code,destination_name,source_url",
    `${PROP_KEY},Seaside Resort,ID,Bali,https://a.com`,
  ].join("\n");
  const F5_CONTACTS = [
    "source_property_id,contact_name,email,contact_scope,organization_name",
    `${PROP_KEY},${PERSON},${EMAIL},agency,${ORG_NAME}`,
  ].join("\n");

  let f5: { properties: string; contacts: string };

  beforeAll(async () => {
    if (!hasTestDb) return;
    const d5 = await mkdtemp(path.join(os.tmpdir(), "theugc-f5-"));
    f5 = { properties: path.join(d5, "properties.csv"), contacts: path.join(d5, "contacts.csv") };
    await writeFile(f5.properties, F5_PROPERTIES, "utf8");
    await writeFile(f5.contacts, F5_CONTACTS, "utf8");
  });

  it("preserves the exact explicit organizationName across persist → reload → report", async () => {
    // In-memory resolution (immediately after staging).
    const sheets = await readCanonicalSource({ file: f5.properties, contacts: f5.contacts });
    const staged = stageRawSheets(sheets);
    const inMemory = resolveEntities(staged.rows, await loadExistingData(client));
    expect(inMemory.organizationCandidates).toHaveLength(1);
    expect(inMemory.organizationCandidates[0]!.name).toBe(ORG_NAME);

    // Persisted → reloaded via getBatchReportInput (inside dryRunFile).
    const dry = await dryRunFile(client, {
      file: f5.properties,
      contacts: f5.contacts,
      sourceName: "f5-roundtrip",
    });
    const reloaded = dry.report.json.organizationCandidates as {
      name: string;
      inferredType: string;
      scope: string;
      reason: string;
    }[];

    expect(reloaded).toHaveLength(1);
    const org = reloaded[0]!;

    // Exact explicit identity preserved.
    expect(org.name).toBe(ORG_NAME);

    // Identity is NOT any of the forbidden sources.
    expect(org.name).not.toBe(PERSON);
    expect(org.name).not.toBe(EMAIL);
    expect(org.name).not.toBe(PROP_KEY);
    expect(org.name).not.toBe(org.inferredType); // not "pr_agency"
    expect(org.name).not.toBe(org.reason); // review_note is explanation only

    // In-memory and persisted/reloaded identities agree.
    expect(org.name).toBe(inMemory.organizationCandidates[0]!.name);

    // review_note remains explanation, and does not contain the org name.
    expect(org.reason).not.toContain(ORG_NAME);
  });
});
