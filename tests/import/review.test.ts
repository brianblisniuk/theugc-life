/**
 * Review manifest workflow tests (CANONICAL_PROMOTION_SPEC.md §14, §15).
 * DB-gated, synthetic data only.
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyReview, buildReviewTemplate, computeBatchApprovalState } from "@/lib/import/review";

import { hasTestDb, setupDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);
const RDEST = "b0000000-0000-0000-0000-0000000000e1";

let client: Client;
let counter = 0;

async function mkBatch(name: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    `insert into public.import_batches (source_name, source_kind, parser_name, parser_version, status)
       values ($1,'canonical','canonical-standard','1.0.0','review_required') returning id`,
    [name],
  );
  return r.rows[0]!.id;
}

async function addProperty(batchId: string, key: string, propertyName: string): Promise<string> {
  counter++;
  const normalized = {
    sourcePropertyKey: key,
    propertyName,
    brandName: null,
    hotelType: "hotel",
    starRating: null,
    countryCode: "ID",
    region: null,
    city: null,
    destinationName: "ZZR Dest",
    destinationSlug: "zzr-dest",
    parentDestinationName: null,
    address: null,
    latitude: null,
    longitude: null,
    websiteUrl: null,
    websiteHost: null,
    instagramUrl: null,
    sourceUrl: "https://src.example",
    nameMatchKey: "",
    notes: null,
  };
  const r = await client.query<{ id: string }>(
    `insert into public.import_rows
       (import_batch_id, sheet_name, source_row_number, row_kind, source_property_key,
        raw_data, raw_fingerprint, normalized_data, validation_status)
     values ($1,'properties',$2,'property',$3,'{}',$4,$5,'valid') returning id`,
    [batchId, counter, key, `fp-${counter}`, JSON.stringify(normalized)],
  );
  return r.rows[0]!.id;
}

async function addContact(
  batchId: string,
  key: string,
  o: Record<string, unknown>,
  status = "valid",
) {
  counter++;
  const normalized = {
    sourcePropertyKey: key,
    contactName: o.contactName ?? null,
    jobTitle: null,
    department: null,
    email: o.email ?? null,
    isGenericMailbox: false,
    phone: null,
    linkedinUrl: null,
    contactScope: o.contactScope ?? null,
    organizationName: o.organizationName ?? null,
    verificationStatus: o.verificationStatus ?? "unverified",
    sourceUrl: null,
    verifiedAt: null,
    notes: null,
  };
  const r = await client.query<{ id: string }>(
    `insert into public.import_rows
       (import_batch_id, sheet_name, source_row_number, row_kind, source_property_key,
        raw_data, raw_fingerprint, normalized_data, validation_status)
     values ($1,'contacts',$2,'contact',$3,'{}',$4,$5,$6) returning id`,
    [batchId, counter, key, `fp-${counter}`, JSON.stringify(normalized), status],
  );
  return r.rows[0]!.id;
}

async function batchStatus(batchId: string): Promise<string> {
  const r = await client.query<{ status: string }>(
    "select status from public.import_batches where id=$1",
    [batchId],
  );
  return r.rows[0]!.status;
}

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();
  client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  await client.query(
    `insert into public.destinations (id, name, slug, type, country_code)
       values ($1,'ZZR Dest','zzr-dest','city','ID')`,
    [RDEST],
  );
});

afterAll(async () => {
  if (client) await client.end();
});

d("review-template + review-apply", () => {
  it("builds a manifest with destination resolution + default child inclusion", async () => {
    const b = await mkBatch("rt1");
    await addProperty(b, "rk1", "Review Hotel");
    // valid contact with endpoint → default include
    await addContact(b, "rk1", { email: "ok@h.com", verificationStatus: "verified" });
    // inferred contact → default defer
    await addContact(b, "rk1", { email: "inf@h.com", verificationStatus: "inferred" });

    const manifest = await buildReviewTemplate(client, b);
    expect(manifest.bundles).toHaveLength(1);
    const bundle = manifest.bundles[0]!;
    expect(bundle.destinationResolution.destinationId).toBe(RDEST);
    expect(bundle.destinationResolution.method).toBe("destination_slug");
    expect(bundle.decision).toBe("defer"); // nothing approved by default
    const inclusions = bundle.contacts.map((c) => c.defaultInclusion).sort();
    expect(inclusions).toEqual(["defer", "include"]);
  });

  it("apply writes review state and marks the batch approved when complete", async () => {
    const b = await mkBatch("rt2");
    await addProperty(b, "rk2", "Approve Hotel");
    const manifest = {
      batchId: b,
      bundles: [{ sourcePropertyKey: "rk2", decision: "approve_create", destinationId: RDEST }],
    };
    const res = await applyReview(client, b, manifest, "Brian");
    expect(res.bundlesWritten).toBe(1);
    expect(res.complete).toBe(true);
    expect(res.batchStatus).toBe("approved");
    expect(await batchStatus(b)).toBe("approved");
  });

  it("a deferred bundle keeps the batch review-required (not approved)", async () => {
    const b = await mkBatch("rt3");
    await addProperty(b, "rk3a", "A");
    await addProperty(b, "rk3b", "B");
    const manifest = {
      batchId: b,
      bundles: [
        { sourcePropertyKey: "rk3a", decision: "approve_create", destinationId: RDEST },
        { sourcePropertyKey: "rk3b", decision: "defer" },
      ],
    };
    const res = await applyReview(client, b, manifest, "Brian");
    expect(res.complete).toBe(false);
    expect(res.batchStatus).toBe("review_required");
    const state = await computeBatchApprovalState(client, b);
    expect(state.deferred).toBe(1);
  });

  it("rejects an invalid manifest (approve_create without destination)", async () => {
    const b = await mkBatch("rt4");
    await addProperty(b, "rk4", "Bad");
    const manifest = {
      batchId: b,
      bundles: [{ sourcePropertyKey: "rk4", decision: "approve_create" }],
    };
    await expect(applyReview(client, b, manifest, "Brian")).rejects.toThrow(/destination/i);
  });

  it("rejects approve_match without a target hotel", async () => {
    const b = await mkBatch("rt5");
    await addProperty(b, "rk5", "Bad2");
    const manifest = {
      batchId: b,
      bundles: [{ sourcePropertyKey: "rk5", decision: "approve_match" }],
    };
    await expect(applyReview(client, b, manifest, "Brian")).rejects.toThrow(/targetHotelId/i);
  });

  it("rejects a manifest whose batchId does not match", async () => {
    const b = await mkBatch("rt6");
    await addProperty(b, "rk6", "X");
    const manifest = {
      batchId: "b0000000-0000-0000-0000-0000000000ff",
      bundles: [{ sourcePropertyKey: "rk6", decision: "reject" }],
    };
    await expect(applyReview(client, b, manifest, "Brian")).rejects.toThrow(/batchId/i);
  });
});
