/**
 * Canonical promotion + review tests (CANONICAL_PROMOTION_SPEC.md §17 + Sprint
 * 1B prompt extras). Synthetic invented data only. DB-gated.
 *
 * import_rows are crafted directly (normalized_data JSON) to exercise the
 * promotion/review logic precisely. Property reviews are written via
 * import_property_reviews. Every test isolates its own batch + keys.
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { acquireBatchLock, releaseBatchLock } from "@/lib/import/db";
import { promoteBatch } from "@/lib/import/promote";
import { applyReview } from "@/lib/import/review";

import { hasTestDb, setupDatabase } from "../db/harness";

function newClient(): Client {
  return new Client({ connectionString: process.env.TEST_DATABASE_URL });
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const d = describe.skipIf(!hasTestDb);

const DEST_ID = "b0000000-0000-0000-0000-0000000000d1";

let client: Client;
const rowCounters = new Map<string, number>();

function nextRow(batchId: string): number {
  const n = (rowCounters.get(batchId) ?? 0) + 1;
  rowCounters.set(batchId, n);
  return n;
}

async function mkBatch(name: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    `insert into public.import_batches (source_name, source_kind, parser_name, parser_version, status)
       values ($1,'canonical','canonical-standard','1.0.0','review_required') returning id`,
    [name],
  );
  return r.rows[0]!.id;
}

function propRecord(o: Record<string, unknown> & { key: string; propertyName: string }) {
  return {
    sourcePropertyKey: o.key,
    propertyName: o.propertyName,
    brandName: o.brandName ?? null,
    hotelType: o.hotelType ?? "hotel",
    starRating: o.starRating ?? null,
    countryCode: o.countryCode ?? "ID",
    region: null,
    city: null,
    destinationName: o.destinationName ?? null,
    destinationSlug: o.destinationSlug ?? null,
    parentDestinationName: null,
    address: o.address ?? null,
    latitude: o.latitude ?? null,
    longitude: o.longitude ?? null,
    websiteUrl: o.websiteUrl ?? null,
    websiteHost: o.websiteHost ?? null,
    instagramUrl: o.instagramUrl ?? null,
    sourceUrl: o.sourceUrl ?? "https://src.example",
    nameMatchKey: "",
    notes: null,
  };
}

function contactRecord(o: Record<string, unknown> & { key: string }) {
  return {
    sourcePropertyKey: o.key,
    contactName: o.contactName ?? null,
    jobTitle: o.jobTitle ?? null,
    department: o.department ?? null,
    email: o.email ?? null,
    isGenericMailbox: o.generic ?? false,
    phone: o.phone ?? null,
    linkedinUrl: o.linkedinUrl ?? null,
    contactScope: o.contactScope ?? null,
    organizationName: o.organizationName ?? null,
    verificationStatus: o.verificationStatus ?? "unverified",
    sourceUrl: o.sourceUrl ?? null,
    verifiedAt: o.verifiedAt ?? null,
    notes: null,
  };
}

function evidenceRecord(o: Record<string, unknown> & { key: string }) {
  return {
    sourcePropertyKey: o.key,
    claimType: o.claimType ?? "property_exists",
    sourceType: o.sourceType ?? "research_compilation",
    sourceUrl: o.sourceUrl ?? "https://e.example",
    verificationStatus: o.verificationStatus ?? "probable",
    observedAt: o.observedAt ?? null,
    notes: null,
  };
}

async function addRow(
  batchId: string,
  kind: "property" | "contact" | "evidence",
  key: string,
  normalized: object,
  status = "valid",
): Promise<string> {
  const n = nextRow(batchId);
  const r = await client.query<{ id: string }>(
    `insert into public.import_rows
       (import_batch_id, sheet_name, source_row_number, row_kind, source_property_key,
        raw_data, raw_fingerprint, normalized_data, validation_status)
     values ($1,$2,$3,$4,$5,'{}',$6,$7,$8) returning id`,
    [batchId, `${kind}s`, n, kind, key, `fp-${batchId}-${n}`, JSON.stringify(normalized), status],
  );
  return r.rows[0]!.id;
}

async function review(
  batchId: string,
  key: string,
  decision: string,
  opts: { targetHotelId?: string; destinationId?: string } = {},
) {
  await client.query(
    `insert into public.import_property_reviews
       (import_batch_id, source_property_key, decision, target_hotel_id, destination_id, reviewer_label)
     values ($1,$2,$3,$4,$5,'tester')`,
    [batchId, key, decision, opts.targetHotelId ?? null, opts.destinationId ?? null],
  );
}

async function childReview(importRowId: string, decision: string) {
  await client.query(
    `insert into public.import_row_reviews (import_row_id, decision, reviewer_label)
       values ($1,$2,'tester')`,
    [importRowId, decision],
  );
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const r = await client.query<{ n: string }>(`select count(*)::text n from ${sql}`, params);
  return Number(r.rows[0]!.n);
}

async function mkHotel(
  name: string,
  slug: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const cols = ["name", "slug", "destination_id", ...Object.keys(extra)];
  const vals = [name, slug, DEST_ID, ...Object.values(extra)];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
  const r = await client.query<{ id: string }>(
    `insert into public.hotels (${cols.join(",")}) values (${placeholders}) returning id`,
    vals,
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();
  client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  await client.query(
    `insert into public.destinations (id, name, slug, type, country_code)
       values ($1,'ZZP Dest','zzp-dest','city','ID')`,
    [DEST_ID],
  );
});

afterAll(async () => {
  if (client) await client.end();
});

d("promotion — create & match", () => {
  it("creates a new hotel after explicit approve_create review", async () => {
    const b = await mkBatch("create1");
    await addRow(b, "property", "c1", propRecord({ key: "c1", propertyName: "Sunset Villa" }));
    await review(b, "c1", "approve_create", { destinationId: DEST_ID });

    const res = await promoteBatch(client, b, { apply: true });
    expect(res.totals.hotelsCreated).toBe(1);
    expect(res.batchStatus).toBe("promoted");
    const n = await count("public.hotels where name = 'Sunset Villa'");
    expect(n).toBe(1);
  });

  it("matches an existing hotel after explicit approve_match review", async () => {
    const hotelId = await mkHotel("Existing Hotel", "existing-hotel-1");
    const b = await mkBatch("match1");
    await addRow(b, "property", "m1", propRecord({ key: "m1", propertyName: "Existing Hotel" }));
    await review(b, "m1", "approve_match", { targetHotelId: hotelId });

    const before = await count("public.hotels");
    const res = await promoteBatch(client, b, { apply: true });
    expect(res.totals.hotelsMatched).toBe(1);
    expect(res.totals.hotelsCreated).toBe(0);
    expect(await count("public.hotels")).toBe(before);
    const link = await count(
      "public.import_row_links where entity_id = $1 and link_type = 'matched'",
      [hotelId],
    );
    expect(link).toBe(1);
  });

  it("missing destination cannot be stored for approve_create (blocks create)", async () => {
    const b = await mkBatch("nodest");
    await addRow(b, "property", "nd1", propRecord({ key: "nd1", propertyName: "No Dest Hotel" }));
    // DB check constraint forbids approve_create without a destination.
    await expect(review(b, "nd1", "approve_create", {})).rejects.toBeTruthy();
  });

  it("no review blocks promotion (--apply fails safely)", async () => {
    const b = await mkBatch("noreview");
    await addRow(b, "property", "nr1", propRecord({ key: "nr1", propertyName: "Unreviewed" }));
    await expect(promoteBatch(client, b, { apply: true })).rejects.toThrow(/incomplete/i);
    expect(await count("public.hotels where name = 'Unreviewed'")).toBe(0);
  });

  it("rejected property produces no canonical mutation", async () => {
    const b = await mkBatch("reject1");
    await addRow(b, "property", "r1", propRecord({ key: "r1", propertyName: "Rejected Hotel" }));
    await review(b, "r1", "reject");
    const res = await promoteBatch(client, b, { apply: true });
    expect(res.totals.hotelsCreated).toBe(0);
    expect(await count("public.hotels where name = 'Rejected Hotel'")).toBe(0);
  });

  it("preview mode performs zero canonical mutations", async () => {
    const b = await mkBatch("preview1");
    await addRow(b, "property", "pv1", propRecord({ key: "pv1", propertyName: "Preview Hotel" }));
    await review(b, "pv1", "approve_create", { destinationId: DEST_ID });
    const res = await promoteBatch(client, b, { apply: false });
    expect(res.apply).toBe(false);
    expect(await count("public.hotels where name = 'Preview Hotel'")).toBe(0);
    expect(res.bundles[0]!.action).toBe("create");
  });
});

d("promotion — child inclusion policy", () => {
  it("review/deferred child contact is not promoted by default", async () => {
    const b = await mkBatch("defer1");
    await addRow(b, "property", "d1", propRecord({ key: "d1", propertyName: "Defer Hotel" }));
    // validation 'review' → default defer
    await addRow(
      b,
      "contact",
      "d1",
      contactRecord({ key: "d1", email: "x@defer.com", verificationStatus: "unverified" }),
      "review",
    );
    await review(b, "d1", "approve_create", { destinationId: DEST_ID });
    await promoteBatch(client, b, { apply: true });
    const hotel = await client.query<{ id: string }>(
      "select id from public.hotels where name='Defer Hotel'",
    );
    expect(await count("public.hotel_contacts where hotel_id=$1", [hotel.rows[0]!.id])).toBe(0);
  });

  it("inferred contact is deferred by default, includable by explicit review", async () => {
    // Default: not promoted.
    const b1 = await mkBatch("inf1");
    await addRow(b1, "property", "i1", propRecord({ key: "i1", propertyName: "Inf Hotel A" }));
    await addRow(
      b1,
      "contact",
      "i1",
      contactRecord({ key: "i1", email: "a@inf.com", verificationStatus: "inferred" }),
    );
    await review(b1, "i1", "approve_create", { destinationId: DEST_ID });
    await promoteBatch(client, b1, { apply: true });
    const hA = await client.query<{ id: string }>(
      "select id from public.hotels where name='Inf Hotel A'",
    );
    expect(await count("public.hotel_contacts where hotel_id=$1", [hA.rows[0]!.id])).toBe(0);

    // Explicit include override: promoted.
    const b2 = await mkBatch("inf2");
    await addRow(b2, "property", "i2", propRecord({ key: "i2", propertyName: "Inf Hotel B" }));
    const rowId = await addRow(
      b2,
      "contact",
      "i2",
      contactRecord({ key: "i2", email: "b@inf.com", verificationStatus: "inferred" }),
    );
    await review(b2, "i2", "approve_create", { destinationId: DEST_ID });
    await childReview(rowId, "include");
    await promoteBatch(client, b2, { apply: true });
    const hB = await client.query<{ id: string }>(
      "select id from public.hotels where name='Inf Hotel B'",
    );
    expect(await count("public.hotel_contacts where hotel_id=$1", [hB.rows[0]!.id])).toBe(1);
  });

  it("invalid contact cannot be force-included", async () => {
    const b = await mkBatch("invalid1");
    await addRow(b, "property", "v1", propRecord({ key: "v1", propertyName: "Invalid Hotel" }));
    const rowId = await addRow(
      b,
      "contact",
      "v1",
      contactRecord({ key: "v1", email: "z@invalid.com", verificationStatus: "invalid" }),
    );
    await review(b, "v1", "approve_create", { destinationId: DEST_ID });
    await childReview(rowId, "include"); // attempt to force
    await promoteBatch(client, b, { apply: true });
    const h = await client.query<{ id: string }>(
      "select id from public.hotels where name='Invalid Hotel'",
    );
    expect(await count("public.hotel_contacts where hotel_id=$1", [h.rows[0]!.id])).toBe(0);
  });
});

d("promotion — contacts, dedup, fields", () => {
  it("same email on same hotel is reused (deduped)", async () => {
    const b = await mkBatch("dedup1");
    await addRow(b, "property", "dd1", propRecord({ key: "dd1", propertyName: "Dedup Hotel" }));
    await addRow(
      b,
      "contact",
      "dd1",
      contactRecord({
        key: "dd1",
        email: "shared@h.com",
        contactName: "First",
        verificationStatus: "verified",
      }),
    );
    await addRow(
      b,
      "contact",
      "dd1",
      contactRecord({
        key: "dd1",
        email: "SHARED@h.com",
        jobTitle: "Manager",
        verificationStatus: "verified",
      }),
    );
    await review(b, "dd1", "approve_create", { destinationId: DEST_ID });
    await promoteBatch(client, b, { apply: true });
    const h = await client.query<{ id: string }>(
      "select id from public.hotels where name='Dedup Hotel'",
    );
    expect(await count("public.hotel_contacts where hotel_id=$1", [h.rows[0]!.id])).toBe(1);
  });

  it("same email on two different hotels is allowed", async () => {
    const b = await mkBatch("multi1");
    await addRow(b, "property", "p1", propRecord({ key: "p1", propertyName: "Multi Hotel A" }));
    await addRow(b, "property", "p2", propRecord({ key: "p2", propertyName: "Multi Hotel B" }));
    await addRow(
      b,
      "contact",
      "p1",
      contactRecord({ key: "p1", email: "corp@chain.com", verificationStatus: "verified" }),
    );
    await addRow(
      b,
      "contact",
      "p2",
      contactRecord({ key: "p2", email: "corp@chain.com", verificationStatus: "verified" }),
    );
    await review(b, "p1", "approve_create", { destinationId: DEST_ID });
    await review(b, "p2", "approve_create", { destinationId: DEST_ID });
    await promoteBatch(client, b, { apply: true });
    expect(await count("public.hotel_contacts where lower(email)='corp@chain.com'")).toBe(2);
  });

  it("preserves full display_name without splitting; organization_name survives", async () => {
    const b = await mkBatch("name1");
    await addRow(b, "property", "n1", propRecord({ key: "n1", propertyName: "Name Hotel" }));
    await addRow(
      b,
      "contact",
      "n1",
      contactRecord({
        key: "n1",
        contactName: "María José García-López",
        email: "mj@agency.com",
        contactScope: "agency",
        organizationName: "Acme PR",
        verificationStatus: "verified",
      }),
    );
    await review(b, "n1", "approve_create", { destinationId: DEST_ID });
    await promoteBatch(client, b, { apply: true });
    const c = await client.query<{
      display_name: string;
      first_name: string | null;
      last_name: string | null;
      organization_name: string | null;
    }>(
      "select display_name, first_name, last_name, organization_name from public.hotel_contacts where email='mj@agency.com'",
    );
    expect(c.rows[0]!.display_name).toBe("María José García-López");
    expect(c.rows[0]!.first_name).toBeNull();
    expect(c.rows[0]!.last_name).toBeNull();
    expect(c.rows[0]!.organization_name).toBe("Acme PR");
  });

  it("approve_match fills a NULL hotel field but never overwrites a conflicting non-null one", async () => {
    const fillHotel = await mkHotel("Fill Hotel", "fill-hotel-1"); // website null
    const conflictHotel = await mkHotel("Conflict Hotel", "conflict-hotel-1", {
      website_url: "https://canonical.example",
    });

    const b = await mkBatch("fields1");
    await addRow(
      b,
      "property",
      "f1",
      propRecord({
        key: "f1",
        propertyName: "Fill Hotel",
        websiteUrl: "https://staged-fill.example",
      }),
    );
    await addRow(
      b,
      "property",
      "f2",
      propRecord({
        key: "f2",
        propertyName: "Conflict Hotel",
        websiteUrl: "https://staged-conflict.example",
      }),
    );
    await review(b, "f1", "approve_match", { targetHotelId: fillHotel });
    await review(b, "f2", "approve_match", { targetHotelId: conflictHotel });
    const res = await promoteBatch(client, b, { apply: true });

    const filled = await client.query<{ website_url: string | null }>(
      "select website_url from public.hotels where id=$1",
      [fillHotel],
    );
    expect(filled.rows[0]!.website_url).toBe("https://staged-fill.example");

    const conflicted = await client.query<{ website_url: string | null }>(
      "select website_url from public.hotels where id=$1",
      [conflictHotel],
    );
    expect(conflicted.rows[0]!.website_url).toBe("https://canonical.example");
    const conflictBundle = res.bundles.find((x) => x.sourcePropertyKey === "f2");
    expect(conflictBundle?.conflicts).toContain("website_url");
  });
});

d("promotion — evidence, idempotency, no intelligence", () => {
  it("creates editorial evidence with import batch/row lineage", async () => {
    const b = await mkBatch("ev1");
    await addRow(b, "property", "e1", propRecord({ key: "e1", propertyName: "Evidence Hotel" }));
    const evRow = await addRow(
      b,
      "evidence",
      "e1",
      evidenceRecord({
        key: "e1",
        claimType: "creator_collaboration_evidence",
        verificationStatus: "probable",
      }),
    );
    await review(b, "e1", "approve_create", { destinationId: DEST_ID });
    await promoteBatch(client, b, { apply: true });
    const ev = await client.query<{ import_batch_id: string; import_row_id: string }>(
      "select import_batch_id, import_row_id from public.editorial_evidence where import_row_id=$1",
      [evRow],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]!.import_batch_id).toBe(b);
    expect(ev.rows[0]!.import_row_id).toBe(evRow);
  });

  it("repeated promotion is idempotent (no duplicate hotels/contacts/evidence)", async () => {
    const b = await mkBatch("idem1");
    await addRow(b, "property", "id1", propRecord({ key: "id1", propertyName: "Idem Hotel" }));
    await addRow(
      b,
      "contact",
      "id1",
      contactRecord({
        key: "id1",
        email: "idem@h.com",
        verificationStatus: "verified",
        sourceUrl: "https://s",
      }),
    );
    await addRow(b, "evidence", "id1", evidenceRecord({ key: "id1" }));
    await review(b, "id1", "approve_create", { destinationId: DEST_ID });

    await promoteBatch(client, b, { apply: true });
    const hotels1 = await count("public.hotels where name='Idem Hotel'");
    const contacts1 = await count("public.hotel_contacts where email='idem@h.com'");
    const ev1 = await count("public.editorial_evidence where import_batch_id=$1", [b]);

    await promoteBatch(client, b, { apply: true }); // repeat
    expect(await count("public.hotels where name='Idem Hotel'")).toBe(hotels1);
    expect(await count("public.hotel_contacts where email='idem@h.com'")).toBe(contacts1);
    expect(await count("public.editorial_evidence where import_batch_id=$1", [b])).toBe(ev1);
  });

  it("promotion creates ZERO outreach/creator/hotel/destination intelligence", async () => {
    const b = await mkBatch("nointel1");
    await addRow(b, "property", "ni1", propRecord({ key: "ni1", propertyName: "NoIntel Hotel" }));
    await addRow(
      b,
      "contact",
      "ni1",
      contactRecord({ key: "ni1", email: "ni@h.com", verificationStatus: "verified" }),
    );
    await addRow(
      b,
      "evidence",
      "ni1",
      evidenceRecord({ key: "ni1", claimType: "creator_collaboration_evidence" }),
    );
    await review(b, "ni1", "approve_create", { destinationId: DEST_ID });
    await promoteBatch(client, b, { apply: true });
    for (const table of ["outreach_events", "hotel_intelligence", "destination_intelligence"]) {
      expect(await count(`public.${table}`)).toBe(0);
    }
  });
});

d("F2 — reviewable property bundles", () => {
  it("a rejected structural property row is staging-only; a sibling valid bundle still promotes", async () => {
    const b = await mkBatch("f2mix");
    // One structurally rejected property row + one valid property row.
    await addRow(
      b,
      "property",
      "f2-rej",
      propRecord({ key: "f2-rej", propertyName: "F2 Rejected Hotel" }),
      "rejected",
    );
    await addRow(
      b,
      "property",
      "f2-ok",
      propRecord({ key: "f2-ok", propertyName: "F2 Valid Hotel" }),
    );
    // Only the valid bundle is reviewed; the rejected row is not reviewable.
    await review(b, "f2-ok", "approve_create", { destinationId: DEST_ID });

    const res = await promoteBatch(client, b, { apply: true });
    // The valid bundle completes and the batch is promoted despite the reject.
    expect(res.batchStatus).toBe("promoted");
    expect(res.totals.hotelsCreated).toBe(1);
    expect(await count("public.hotels where name='F2 Valid Hotel'")).toBe(1);
    // The rejected row never becomes a canonical hotel; it stays staging-only.
    expect(await count("public.hotels where name='F2 Rejected Hotel'")).toBe(0);
    expect(
      await count(
        "public.import_rows where import_batch_id=$1 and source_property_key='f2-rej' and validation_status='rejected'",
        [b],
      ),
    ).toBe(1);
  });

  it("a batch with zero reviewable property bundles cannot complete or promote", async () => {
    const b = await mkBatch("f2none");
    await addRow(
      b,
      "property",
      "f2-only-rej",
      propRecord({ key: "f2-only-rej", propertyName: "F2 Only Rejected" }),
      "rejected",
    );
    // --apply must fail safely: review is incomplete (no reviewable bundles).
    await expect(promoteBatch(client, b, { apply: true })).rejects.toThrow(/incomplete/i);
    expect(await count("public.hotels where name='F2 Only Rejected'")).toBe(0);
  });

  it("the DB rejects a second property row sharing a source_property_key in a batch", async () => {
    const b = await mkBatch("f2dup");
    await addRow(b, "property", "f2-dup", propRecord({ key: "f2-dup", propertyName: "Dup A" }));
    let code: string | null = null;
    try {
      await addRow(b, "property", "f2-dup", propRecord({ key: "f2-dup", propertyName: "Dup B" }));
    } catch (e) {
      code = (e as { code?: string }).code ?? "error";
    }
    expect(code).toBe("23505");
  });
});

d("F4 — only included verified evidence upgrades hotel verification", () => {
  it("included verified property_exists evidence upgrades the hotel to verified", async () => {
    const b = await mkBatch("f4a");
    await addRow(
      b,
      "property",
      "f4a",
      propRecord({ key: "f4a", propertyName: "F4 Verified Hotel" }),
    );
    await addRow(
      b,
      "evidence",
      "f4a",
      evidenceRecord({ key: "f4a", claimType: "property_exists", verificationStatus: "verified" }),
    );
    await review(b, "f4a", "approve_create", { destinationId: DEST_ID });
    await promoteBatch(client, b, { apply: true });
    const h = await client.query<{ editorial_verification_status: string }>(
      "select editorial_verification_status from public.hotels where name='F4 Verified Hotel'",
    );
    expect(h.rows[0]!.editorial_verification_status).toBe("verified");
  });

  it("explicitly excluded verified evidence does NOT upgrade the hotel", async () => {
    const b = await mkBatch("f4b");
    await addRow(
      b,
      "property",
      "f4b",
      propRecord({ key: "f4b", propertyName: "F4 Excluded Hotel" }),
    );
    const ev = await addRow(
      b,
      "evidence",
      "f4b",
      evidenceRecord({ key: "f4b", claimType: "property_exists", verificationStatus: "verified" }),
    );
    await review(b, "f4b", "approve_create", { destinationId: DEST_ID });
    await childReview(ev, "exclude");
    await promoteBatch(client, b, { apply: true });
    const h = await client.query<{ editorial_verification_status: string }>(
      "select editorial_verification_status from public.hotels where name='F4 Excluded Hotel'",
    );
    expect(h.rows[0]!.editorial_verification_status).toBe("unverified");
  });

  it("deferred verified evidence (validation review) does NOT upgrade the hotel", async () => {
    const b = await mkBatch("f4c");
    await addRow(
      b,
      "property",
      "f4c",
      propRecord({ key: "f4c", propertyName: "F4 Deferred Hotel" }),
    );
    await addRow(
      b,
      "evidence",
      "f4c",
      evidenceRecord({ key: "f4c", claimType: "property_exists", verificationStatus: "verified" }),
      "review", // default defer, no override → not finally included
    );
    await review(b, "f4c", "approve_create", { destinationId: DEST_ID });
    await promoteBatch(client, b, { apply: true });
    const h = await client.query<{ editorial_verification_status: string }>(
      "select editorial_verification_status from public.hotels where name='F4 Deferred Hotel'",
    );
    expect(h.rows[0]!.editorial_verification_status).toBe("unverified");
  });
});

d("F5 — review state immutable after promotion", () => {
  it("rejects review mutation once the batch is promoted", async () => {
    const b = await mkBatch("f5a");
    await addRow(
      b,
      "property",
      "f5a",
      propRecord({ key: "f5a", propertyName: "F5 Promoted Hotel" }),
    );
    await review(b, "f5a", "approve_create", { destinationId: DEST_ID });
    const res = await promoteBatch(client, b, { apply: true });
    expect(res.batchStatus).toBe("promoted");

    const manifest = { batchId: b, bundles: [{ sourcePropertyKey: "f5a", decision: "reject" }] };
    await expect(applyReview(client, b, manifest, "Brian")).rejects.toThrow(/immutable|promoted/i);
    // The original approved decision is unchanged.
    const dec = await client.query<{ decision: string }>(
      "select decision from public.import_property_reviews where import_batch_id=$1",
      [b],
    );
    expect(dec.rows[0]!.decision).toBe("approve_create");
  });

  it("repeat promotion with the unchanged promoted review stays idempotent", async () => {
    const b = await mkBatch("f5b");
    await addRow(b, "property", "f5b", propRecord({ key: "f5b", propertyName: "F5 Repeat Hotel" }));
    await review(b, "f5b", "approve_create", { destinationId: DEST_ID });
    await promoteBatch(client, b, { apply: true });
    const n1 = await count("public.hotels where name='F5 Repeat Hotel'");
    const res2 = await promoteBatch(client, b, { apply: true });
    expect(res2.batchStatus).toBe("promoted");
    expect(await count("public.hotels where name='F5 Repeat Hotel'")).toBe(n1);
  });
});

d("F6 — rolled-back bundles report zero canonical mutations", () => {
  it("a failure mid-transaction rolls back and zeroes bundle + total counters", async () => {
    const b = await mkBatch("f6a");
    await addRow(
      b,
      "property",
      "f6a",
      propRecord({ key: "f6a", propertyName: "F6 Rollback Hotel" }),
    );
    // Contact department violates the DB check → INSERT fails AFTER the hotel
    // and property-provenance evidence were created in the same transaction.
    await addRow(
      b,
      "contact",
      "f6a",
      contactRecord({
        key: "f6a",
        email: "f6@h.com",
        department: "not_a_real_department",
        verificationStatus: "verified",
      }),
    );
    await review(b, "f6a", "approve_create", { destinationId: DEST_ID });

    const res = await promoteBatch(client, b, { apply: true });

    // Canonical DB state is fully rolled back.
    expect(await count("public.hotels where name='F6 Rollback Hotel'")).toBe(0);
    expect(await count("public.hotel_contacts where email='f6@h.com'")).toBe(0);
    expect(await count("public.editorial_evidence where import_batch_id=$1", [b])).toBe(0);

    // Bundle counters are zero for the rolled-back work; diagnostics retained.
    const bundle = res.bundles.find((x) => x.sourcePropertyKey === "f6a")!;
    expect(bundle.error).toBeTruthy();
    expect(bundle.hotelId).toBeNull();
    expect(bundle.contactsCreated).toBe(0);
    expect(bundle.contactsReused).toBe(0);
    expect(bundle.evidenceCreated).toBe(0);
    expect(bundle.filledHotelFields).toEqual([]);

    // Aggregate totals reflect committed state only (nothing committed).
    expect(res.totals.hotelsCreated).toBe(0);
    expect(res.totals.contactsCreated).toBe(0);
    expect(res.totals.evidenceCreated).toBe(0);

    // A batch with a failed bundle is never marked promoted.
    expect(res.batchStatus).not.toBe("promoted");
  });
});

d("F10 — country/destination consistency", () => {
  // DEST_ID (zzp-dest) is a known ID destination.
  it("approve_create fails on a known cross-country conflict with zero mutation", async () => {
    const b = await mkBatch("f10x");
    await addRow(
      b,
      "property",
      "f10x",
      propRecord({ key: "f10x", propertyName: "F10 Conflict Hotel", countryCode: "AR" }),
    );
    await review(b, "f10x", "approve_create", { destinationId: DEST_ID });
    const res = await promoteBatch(client, b, { apply: true });
    expect(await count("public.hotels where name='F10 Conflict Hotel'")).toBe(0);
    const bundle = res.bundles.find((x) => x.sourcePropertyKey === "f10x")!;
    expect(bundle.error).toMatch(/country conflict/i);
    expect(res.totals.hotelsCreated).toBe(0);
    expect(res.batchStatus).not.toBe("promoted");
  });

  it("approve_create with a null staged country inherits the destination country", async () => {
    const b = await mkBatch("f10n");
    // Explicit null staged country (propRecord defaults to "ID").
    const rec = {
      ...propRecord({ key: "f10n", propertyName: "F10 Null Country Hotel" }),
      countryCode: null,
    };
    await addRow(b, "property", "f10n", rec);
    await review(b, "f10n", "approve_create", { destinationId: DEST_ID });
    await promoteBatch(client, b, { apply: true });
    const h = await client.query<{ country_code: string | null }>(
      "select country_code from public.hotels where name='F10 Null Country Hotel'",
    );
    expect(h.rows[0]!.country_code).toBe("ID");
  });

  it("approve_create with a compatible staged country succeeds", async () => {
    const b = await mkBatch("f10ok");
    await addRow(
      b,
      "property",
      "f10ok",
      propRecord({ key: "f10ok", propertyName: "F10 Compatible Hotel", countryCode: "ID" }),
    );
    await review(b, "f10ok", "approve_create", { destinationId: DEST_ID });
    await promoteBatch(client, b, { apply: true });
    const h = await client.query<{ country_code: string | null }>(
      "select country_code from public.hotels where name='F10 Compatible Hotel'",
    );
    expect(h.rows[0]!.country_code).toBe("ID");
  });

  it("approve_match never fills a country conflicting with the destination", async () => {
    const hotelId = await mkHotel("F10 Match Hotel", "f10-match-1"); // ID destination, country null
    const b = await mkBatch("f10m");
    await addRow(
      b,
      "property",
      "f10m",
      propRecord({ key: "f10m", propertyName: "F10 Match Hotel", countryCode: "AR" }),
    );
    await review(b, "f10m", "approve_match", { targetHotelId: hotelId });
    const res = await promoteBatch(client, b, { apply: true });
    // Hotel takes the destination country (ID), never the conflicting staged AR.
    const h = await client.query<{ country_code: string | null }>(
      "select country_code from public.hotels where id=$1",
      [hotelId],
    );
    expect(h.rows[0]!.country_code).toBe("ID");
    const bundle = res.bundles.find((x) => x.sourcePropertyKey === "f10m")!;
    expect(bundle.conflicts).toContain("country_code");
  });

  it("approve_match fills the destination country for a null-compatible staged country", async () => {
    const hotelId = await mkHotel("F10 Match Fill Hotel", "f10-matchfill-1"); // country null
    const b = await mkBatch("f10mf");
    const rec = {
      ...propRecord({ key: "f10mf", propertyName: "F10 Match Fill Hotel" }),
      countryCode: null,
    };
    await addRow(b, "property", "f10mf", rec);
    await review(b, "f10mf", "approve_match", { targetHotelId: hotelId });
    const res = await promoteBatch(client, b, { apply: true });
    const h = await client.query<{ country_code: string | null }>(
      "select country_code from public.hotels where id=$1",
      [hotelId],
    );
    expect(h.rows[0]!.country_code).toBe("ID");
    const bundle = res.bundles.find((x) => x.sourcePropertyKey === "f10mf")!;
    expect(bundle.conflicts).not.toContain("country_code");
  });
});

d("F9 — review and apply-promotion serialize per batch", () => {
  it("apply-promotion blocks while another session holds the batch lock; a different batch is unaffected", async () => {
    const holder = newClient();
    const worker = newClient();
    await holder.connect();
    await worker.connect();
    try {
      const b = await mkBatch("f9a");
      await addRow(
        b,
        "property",
        "f9a",
        propRecord({ key: "f9a", propertyName: "F9 Serialize Hotel" }),
      );
      await review(b, "f9a", "approve_create", { destinationId: DEST_ID });

      const c = await mkBatch("f9c");
      await addRow(
        c,
        "property",
        "f9c",
        propRecord({ key: "f9c", propertyName: "F9 Other Hotel" }),
      );
      await review(c, "f9c", "approve_create", { destinationId: DEST_ID });

      // A holder session takes batch B's advisory lock (exactly as the code does).
      await acquireBatchLock(holder, b);

      // Promotion of B on the worker session must block on that lock.
      let settled = false;
      const pB = promoteBatch(worker, b, { apply: true });
      pB.then(
        () => (settled = true),
        () => (settled = true),
      );
      await delay(300);
      expect(settled).toBe(false);
      expect(await count("public.hotels where name='F9 Serialize Hotel'")).toBe(0);

      // A DIFFERENT batch C is not blocked by B's lock (own connection).
      const other = newClient();
      await other.connect();
      try {
        const resC = await promoteBatch(other, c, { apply: true });
        expect(resC.batchStatus).toBe("promoted");
      } finally {
        await other.end();
      }

      // Release B's lock; the blocked promotion now proceeds and completes.
      await releaseBatchLock(holder, b);
      const resB = await pB;
      expect(resB.batchStatus).toBe("promoted");
      expect(await count("public.hotels where name='F9 Serialize Hotel'")).toBe(1);
    } finally {
      await holder.end();
      await worker.end();
    }
  });

  it("applyReview blocks while another session holds the batch lock", async () => {
    const holder = newClient();
    const worker = newClient();
    await holder.connect();
    await worker.connect();
    try {
      const b = await mkBatch("f9r");
      await addRow(
        b,
        "property",
        "f9r",
        propRecord({ key: "f9r", propertyName: "F9 Review Hotel" }),
      );
      await acquireBatchLock(holder, b);

      let settled = false;
      const manifest = {
        batchId: b,
        bundles: [{ sourcePropertyKey: "f9r", decision: "approve_create", destinationId: DEST_ID }],
      };
      const p = applyReview(worker, b, manifest, "Brian");
      p.then(
        () => (settled = true),
        () => (settled = true),
      );
      await delay(300);
      expect(settled).toBe(false);

      await releaseBatchLock(holder, b);
      const res = await p;
      expect(res.batchStatus).toBe("approved");
    } finally {
      await holder.end();
      await worker.end();
    }
  });
});
