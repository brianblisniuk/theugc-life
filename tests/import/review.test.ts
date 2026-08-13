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

async function reviewCount(batchId: string): Promise<number> {
  const r = await client.query<{ n: string }>(
    "select count(*)::text n from public.import_property_reviews where import_batch_id=$1",
    [batchId],
  );
  return Number(r.rows[0]!.n);
}

d("F1 — manifest identifiers are strictly batch- and bundle-scoped", () => {
  it("a manifest for Batch A cannot mutate review state for Batch B", async () => {
    const a = await mkBatch("f1a");
    await addProperty(a, "f1-a-key", "A Hotel");
    const b = await mkBatch("f1b");
    await addProperty(b, "f1-b-key", "B Hotel");
    // Reviewer submits a manifest scoped to A but referencing B's property key.
    const manifest = {
      batchId: a,
      bundles: [
        { sourcePropertyKey: "f1-b-key", decision: "approve_create", destinationId: RDEST },
      ],
    };
    await expect(applyReview(client, a, manifest, "Brian")).rejects.toThrow(
      /reviewable property row/i,
    );
    // The entire transaction fails: neither batch gets review state.
    expect(await reviewCount(a)).toBe(0);
    expect(await reviewCount(b)).toBe(0);
  });

  it("a child override cannot attach a row from another property bundle", async () => {
    const b = await mkBatch("f1child");
    await addProperty(b, "k1", "K1 Hotel");
    await addProperty(b, "k2", "K2 Hotel");
    await addContact(b, "k1", { email: "k1@h.com" });
    const k2contact = await addContact(b, "k2", { email: "k2@h.com" });
    const manifest = {
      batchId: b,
      bundles: [
        {
          sourcePropertyKey: "k1",
          decision: "approve_create",
          destinationId: RDEST,
          childOverrides: [{ importRowId: k2contact, decision: "include" }],
        },
        { sourcePropertyKey: "k2", decision: "reject" },
      ],
    };
    await expect(applyReview(client, b, manifest, "Brian")).rejects.toThrow(/bundle/i);
    // No property or child review state was written.
    expect(await reviewCount(b)).toBe(0);
    const n = await client.query<{ n: string }>(
      "select count(*)::text n from public.import_row_reviews where import_row_id=$1",
      [k2contact],
    );
    expect(Number(n.rows[0]!.n)).toBe(0);
  });

  it("rejects duplicate property bundle keys", async () => {
    const b = await mkBatch("f1dup");
    await addProperty(b, "dupk", "Dup Hotel");
    const manifest = {
      batchId: b,
      bundles: [
        { sourcePropertyKey: "dupk", decision: "approve_create", destinationId: RDEST },
        { sourcePropertyKey: "dupk", decision: "reject" },
      ],
    };
    await expect(applyReview(client, b, manifest, "Brian")).rejects.toThrow(/duplicate/i);
  });

  it("rejects a child override that points at a property row", async () => {
    const b = await mkBatch("f1prop");
    const propRowId = await addProperty(b, "pk", "Prop Hotel");
    const manifest = {
      batchId: b,
      bundles: [
        {
          sourcePropertyKey: "pk",
          decision: "approve_create",
          destinationId: RDEST,
          childOverrides: [{ importRowId: propRowId, decision: "include" }],
        },
      ],
    };
    await expect(applyReview(client, b, manifest, "Brian")).rejects.toThrow(
      /not contact\/evidence/i,
    );
  });

  it("rejects a child override whose row belongs to another batch", async () => {
    const a = await mkBatch("f1xa");
    await addProperty(a, "xa", "XA Hotel");
    const other = await mkBatch("f1xb");
    const otherContact = await addContact(other, "xb", { email: "xb@h.com" });
    const manifest = {
      batchId: a,
      bundles: [
        {
          sourcePropertyKey: "xa",
          decision: "approve_create",
          destinationId: RDEST,
          childOverrides: [{ importRowId: otherContact, decision: "include" }],
        },
      ],
    };
    await expect(applyReview(client, a, manifest, "Brian")).rejects.toThrow(
      /does not belong to batch/i,
    );
  });
});

async function overrideCount(importRowId: string): Promise<number> {
  const r = await client.query<{ n: string }>(
    "select count(*)::text n from public.import_row_reviews where import_row_id=$1",
    [importRowId],
  );
  return Number(r.rows[0]!.n);
}

d("F7 — a review manifest is a full snapshot of the batch's reviewable bundles", () => {
  it("a partial manifest is rejected and leaves prior approvals unchanged", async () => {
    const b = await mkBatch("f7");
    await addProperty(b, "f7a", "F7 A");
    await addProperty(b, "f7b", "F7 B");
    // Full manifest approves both bundles.
    const full = {
      batchId: b,
      bundles: [
        { sourcePropertyKey: "f7a", decision: "approve_create", destinationId: RDEST },
        { sourcePropertyKey: "f7b", decision: "approve_create", destinationId: RDEST },
      ],
    };
    const res1 = await applyReview(client, b, full, "Brian");
    expect(res1.complete).toBe(true);

    // A later manifest containing ONLY A must fail (B is missing).
    const partial = {
      batchId: b,
      bundles: [{ sourcePropertyKey: "f7a", decision: "reject" }],
    };
    await expect(applyReview(client, b, partial, "Brian")).rejects.toThrow(
      /full review snapshot|missing/i,
    );

    // Persisted decisions are unchanged: both bundles still approve_create.
    const rows = await client.query<{ decision: string }>(
      "select decision from public.import_property_reviews where import_batch_id=$1 order by source_property_key",
      [b],
    );
    expect(rows.rows.map((r) => r.decision)).toEqual(["approve_create", "approve_create"]);
  });
});

d("F8 — child overrides are a snapshot of the manifest", () => {
  it("re-applying without an override deletes it (default policy resumes); other batches untouched", async () => {
    // Batch under test: a property + an inferred contact (default = defer).
    const b = await mkBatch("f8");
    await addProperty(b, "f8k", "F8 Hotel");
    const contactRow = await addContact(b, "f8k", {
      email: "inf@h.com",
      verificationStatus: "inferred",
    });

    // Independent batch whose override must survive re-applies elsewhere.
    const other = await mkBatch("f8other");
    await addProperty(other, "f8ok", "F8 Other");
    const otherContact = await addContact(other, "f8ok", {
      email: "o@h.com",
      verificationStatus: "inferred",
    });
    await applyReview(
      client,
      other,
      {
        batchId: other,
        bundles: [
          {
            sourcePropertyKey: "f8ok",
            decision: "approve_create",
            destinationId: RDEST,
            childOverrides: [{ importRowId: otherContact, decision: "include" }],
          },
        ],
      },
      "Brian",
    );

    // First apply for b: explicitly include the inferred contact.
    await applyReview(
      client,
      b,
      {
        batchId: b,
        bundles: [
          {
            sourcePropertyKey: "f8k",
            decision: "approve_create",
            destinationId: RDEST,
            childOverrides: [{ importRowId: contactRow, decision: "include" }],
          },
        ],
      },
      "Brian",
    );
    expect(await overrideCount(contactRow)).toBe(1);

    // Re-apply the FULL manifest with the override removed → it is deleted.
    await applyReview(
      client,
      b,
      {
        batchId: b,
        bundles: [{ sourcePropertyKey: "f8k", decision: "approve_create", destinationId: RDEST }],
      },
      "Brian",
    );
    expect(await overrideCount(contactRow)).toBe(0);
    // The other batch's override is untouched.
    expect(await overrideCount(otherContact)).toBe(1);

    // With the override gone, deterministic default policy defers the contact.
    const manifest = await buildReviewTemplate(client, b);
    const c = manifest.bundles[0]!.contacts.find((x) => x.importRowId === contactRow)!;
    expect(c.defaultInclusion).toBe("defer");
  });
});
