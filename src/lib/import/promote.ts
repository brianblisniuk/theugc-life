/**
 * Canonical promotion engine (CANONICAL_PROMOTION_SPEC.md).
 *
 * Reviewer-gated, transactional per property bundle, idempotent, and
 * conservative about overwrites. Default mode is PREVIEW (zero mutations);
 * actual writes require `apply: true`. There is no blind promote-all. Promotion
 * NEVER creates outreach_events or any creator/hotel/destination intelligence.
 */
import type { Client, PoolClient } from "pg";

import type { ContactRecord, EvidenceRecord, PropertyRecord } from "./contract";
import { computeBatchApprovalState } from "./review";
import { finalContactInclusion, finalEvidenceInclusion, type ChildDecision } from "./childPolicy";
import { acquireBatchLock, loadBatchData, releaseBatchLock, type BatchRow } from "./db";
import { generateSlug, slugifyName } from "../canonical/slug";

type Db = Client | PoolClient;

export interface BundlePlan {
  sourcePropertyKey: string;
  decision: string;
  action: "create" | "match" | "skip";
  hotelId: string | null;
  hotelSlug: string | null;
  hotelAlreadyPromoted: boolean;
  contactsCreated: number;
  contactsReused: number;
  contactsSkipped: number;
  evidenceCreated: number;
  filledHotelFields: string[];
  conflicts: string[];
  notes: string[];
  error?: string;
}

export interface PromotionResult {
  batchId: string;
  apply: boolean;
  reviewComplete: boolean;
  batchStatus: string;
  bundles: BundlePlan[];
  totals: {
    hotelsCreated: number;
    hotelsMatched: number;
    contactsCreated: number;
    contactsReused: number;
    evidenceCreated: number;
  };
}

interface PropertyReviewRow {
  source_property_key: string;
  decision: string;
  target_hotel_id: string | null;
  destination_id: string | null;
}

function toDateOrNull(s: string | null): string | null {
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s : null;
}

async function existingLinkEntity(
  db: Db,
  importRowId: string,
  linkTypes: string[],
): Promise<string | null> {
  const r = await db.query<{ entity_id: string }>(
    `select entity_id from public.import_row_links
       where import_row_id = $1 and link_type = any($2) limit 1`,
    [importRowId, linkTypes],
  );
  return r.rows[0]?.entity_id ?? null;
}

async function hasEvidenceLink(db: Db, importRowId: string): Promise<boolean> {
  const r = await db.query(
    "select 1 from public.import_row_links where import_row_id = $1 and link_type = 'evidence_for' limit 1",
    [importRowId],
  );
  return r.rows.length > 0;
}

async function addLink(
  db: Db,
  importRowId: string,
  entityType: string,
  entityId: string,
  linkType: string,
): Promise<void> {
  await db.query(
    `insert into public.import_row_links (import_row_id, entity_type, entity_id, link_type)
       values ($1,$2,$3,$4)
     on conflict (import_row_id, entity_type, entity_id, link_type) do nothing`,
    [importRowId, entityType, entityId, linkType],
  );
}

async function destinationInfoById(
  db: Db,
  destinationId: string,
): Promise<{ slug: string | null; countryCode: string | null }> {
  const r = await db.query<{ slug: string; country_code: string | null }>(
    "select slug, country_code from public.destinations where id = $1",
    [destinationId],
  );
  return { slug: r.rows[0]?.slug ?? null, countryCode: r.rows[0]?.country_code ?? null };
}

/** Create canonical editorial_evidence for one import row (idempotent per row). */
async function createEvidenceForRow(
  db: Db,
  opts: {
    importRowId: string;
    batchId: string;
    subjectType: "hotel" | "hotel_contact";
    subjectId: string;
    claimType: string;
    sourceType: string;
    sourceUrl: string | null;
    verificationStatus: string;
    observedAt: string | null;
    verifiedAt: string | null;
    notes: string | null;
  },
): Promise<number> {
  if (await hasEvidenceLink(db, opts.importRowId)) return 0;
  const ins = await db.query<{ id: string }>(
    `insert into public.editorial_evidence
       (subject_type, subject_id, import_batch_id, import_row_id, claim_type, source_type,
        source_url, verification_status, observed_at, verified_at, notes)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     returning id`,
    [
      opts.subjectType,
      opts.subjectId,
      opts.batchId,
      opts.importRowId,
      opts.claimType,
      opts.sourceType,
      opts.sourceUrl,
      opts.verificationStatus,
      toDateOrNull(opts.observedAt),
      toDateOrNull(opts.verifiedAt),
      opts.notes,
    ],
  );
  await addLink(db, opts.importRowId, "editorial_evidence", ins.rows[0]!.id, "evidence_for");
  return 1;
}

const ORG_CLAIM_BY_SCOPE: Record<string, string> = {
  agency: "agency_representation",
  operator: "operator_relationship",
  group: "brand_relationship",
  brand: "brand_relationship",
};

/** Find an existing hotel contact to reuse by endpoint (same hotel only). */
async function findContactByEndpoint(
  db: Db,
  hotelId: string,
  c: ContactRecord,
): Promise<string | null> {
  if (c.email) {
    const r = await db.query<{ id: string }>(
      "select id from public.hotel_contacts where hotel_id = $1 and lower(email) = lower($2) limit 1",
      [hotelId, c.email],
    );
    if (r.rows[0]) return r.rows[0].id;
  }
  if (c.linkedinUrl) {
    const r = await db.query<{ id: string }>(
      "select id from public.hotel_contacts where hotel_id = $1 and linkedin_url = $2 limit 1",
      [hotelId, c.linkedinUrl],
    );
    if (r.rows[0]) return r.rows[0].id;
  }
  if (c.phone) {
    const r = await db.query<{ id: string }>(
      "select id from public.hotel_contacts where hotel_id = $1 and phone = $2 limit 1",
      [hotelId, c.phone],
    );
    if (r.rows[0]) return r.rows[0].id;
  }
  return null;
}

// country_code is intentionally NOT here — it is handled specially in
// approve_match (review fix F10) so a hotel country can never be filled with a
// value that conflicts with its canonical destination.
const HOTEL_FILL_FIELDS: { col: string; get: (p: PropertyRecord) => unknown }[] = [
  { col: "address", get: (p) => p.address },
  { col: "latitude", get: (p) => p.latitude },
  { col: "longitude", get: (p) => p.longitude },
  { col: "website_url", get: (p) => p.websiteUrl },
  { col: "instagram_url", get: (p) => p.instagramUrl },
  { col: "hotel_type", get: (p) => p.hotelType },
  { col: "star_rating", get: (p) => p.starRating },
];

interface BundleContext {
  db: Db;
  batchId: string;
  propertyRow: BatchRow;
  property: PropertyRecord;
  contacts: BatchRow[];
  evidence: BatchRow[];
  childOverrides: Map<string, ChildDecision>;
}

async function promoteContactsAndEvidence(
  ctx: BundleContext,
  hotelId: string,
  plan: BundlePlan,
): Promise<void> {
  const { db, batchId } = ctx;

  // Property provenance evidence.
  if (ctx.property.sourceUrl) {
    plan.evidenceCreated += await createEvidenceForRow(db, {
      importRowId: ctx.propertyRow.importRowId,
      batchId,
      subjectType: "hotel",
      subjectId: hotelId,
      claimType: "property_exists",
      sourceType: "research_compilation",
      sourceUrl: ctx.property.sourceUrl,
      verificationStatus: "unverified",
      observedAt: null,
      verifiedAt: null,
      notes: ctx.property.brandName ? `brand: ${ctx.property.brandName}` : null,
    });
  }

  // Contacts.
  for (const cr of ctx.contacts) {
    const c = cr.normalized as unknown as ContactRecord;
    const inclusion = finalContactInclusion(
      cr.validationStatus,
      c,
      ctx.childOverrides.get(cr.importRowId),
    );
    if (inclusion !== "include") {
      plan.contactsSkipped++;
      continue;
    }

    // Idempotency: already promoted this contact row?
    const existing = await existingLinkEntity(db, cr.importRowId, ["created", "matched"]);
    let contactId: string;
    if (existing) {
      contactId = existing;
      plan.contactsReused++;
    } else {
      const match = await findContactByEndpoint(db, hotelId, c);
      const operationalStatus = c.verificationStatus === "verified" ? "active" : "unverified";
      if (match) {
        contactId = match;
        // Safe fill-null only; never overwrite conflicting non-null identity.
        await db.query(
          `update public.hotel_contacts set
             display_name = coalesce(display_name, $2),
             job_title = coalesce(job_title, $3),
             department = coalesce(department, $4),
             organization_name = coalesce(organization_name, $5),
             linkedin_url = coalesce(linkedin_url, $6),
             phone = coalesce(phone, $7),
             source_reference = coalesce(source_reference, $8)
           where id = $1`,
          [
            contactId,
            c.contactName,
            c.jobTitle,
            c.department,
            c.organizationName,
            c.linkedinUrl,
            c.phone,
            c.sourceUrl,
          ],
        );
        await addLink(db, cr.importRowId, "hotel_contact", contactId, "matched");
        plan.contactsReused++;
      } else {
        const ins = await db.query<{ id: string }>(
          `insert into public.hotel_contacts
             (hotel_id, first_name, last_name, display_name, job_title, department, email, phone,
              linkedin_url, contact_type, status, source_type, source_reference,
              verification_status, organization_name, verified_at)
           values ($1, null, null, $2, $3, $4, $5, $6, $7, $8, $9, 'editorial', $10, $11, $12, $13)
           returning id`,
          [
            hotelId,
            c.contactName, // display_name: preserved exactly, never split (D039)
            c.jobTitle,
            c.department,
            c.email,
            c.phone,
            c.linkedinUrl,
            c.contactScope,
            operationalStatus,
            c.sourceUrl,
            c.verificationStatus,
            c.organizationName,
            toDateOrNull(c.verifiedAt),
          ],
        );
        contactId = ins.rows[0]!.id;
        await addLink(db, cr.importRowId, "hotel_contact", contactId, "created");
        plan.contactsCreated++;
      }
    }

    // Contact provenance + organization relationship evidence.
    if (c.sourceUrl || c.organizationName) {
      const orgClaim = c.contactScope ? ORG_CLAIM_BY_SCOPE[c.contactScope] : undefined;
      plan.evidenceCreated += await createEvidenceForRow(db, {
        importRowId: cr.importRowId,
        batchId,
        subjectType: "hotel_contact",
        subjectId: contactId,
        claimType: orgClaim ?? "contact_confirmation",
        sourceType: "research_compilation",
        sourceUrl: c.sourceUrl,
        verificationStatus: c.verificationStatus,
        observedAt: null,
        verifiedAt: toDateOrNull(c.verifiedAt),
        notes: c.organizationName ? `organization: ${c.organizationName}` : null,
      });
    }
  }

  // Evidence rows.
  for (const er of ctx.evidence) {
    const e = er.normalized as unknown as EvidenceRecord;
    const inclusion = finalEvidenceInclusion(
      er.validationStatus,
      e,
      ctx.childOverrides.get(er.importRowId),
    );
    if (inclusion !== "include") continue;
    plan.evidenceCreated += await createEvidenceForRow(db, {
      importRowId: er.importRowId,
      batchId,
      subjectType: "hotel",
      subjectId: hotelId,
      claimType: e.claimType,
      sourceType: e.sourceType,
      sourceUrl: e.sourceUrl,
      verificationStatus: e.verificationStatus,
      observedAt: e.observedAt,
      verifiedAt: null,
      notes: null,
    });
  }
}

/**
 * Promote a batch. Preview by default; `apply` performs canonical writes.
 *
 * F9: an apply-promotion serializes against concurrent review/promotion for the
 * SAME batch on a session advisory lock. The lock is acquired BEFORE the review
 * snapshot is read and held across every per-bundle transaction, so the whole
 * run operates on one stable snapshot; it is released in `finally`. Preview does
 * no writes and takes no lock. Per-bundle row locks are preserved.
 */
export async function promoteBatch(
  client: Client,
  batchId: string,
  opts: { apply: boolean },
): Promise<PromotionResult> {
  if (!opts.apply) return promoteBatchInner(client, batchId, opts);
  await acquireBatchLock(client, batchId);
  try {
    return await promoteBatchInner(client, batchId, opts);
  } finally {
    await releaseBatchLock(client, batchId);
  }
}

async function promoteBatchInner(
  client: Client,
  batchId: string,
  opts: { apply: boolean },
): Promise<PromotionResult> {
  const data = await loadBatchData(client, batchId);
  const reviewState = await computeBatchApprovalState(client, batchId);

  const reviews = await client.query<PropertyReviewRow>(
    "select source_property_key, decision, target_hotel_id, destination_id from public.import_property_reviews where import_batch_id = $1",
    [batchId],
  );
  const reviewByKey = new Map(reviews.rows.map((r) => [r.source_property_key, r]));

  // Child overrides.
  const overrideRes = await client.query<{ import_row_id: string; decision: string }>(
    `select r.import_row_id, r.decision from public.import_row_reviews r
       join public.import_rows ir on ir.id = r.import_row_id
       where ir.import_batch_id = $1`,
    [batchId],
  );
  const overridesByRow = new Map<string, ChildDecision>(
    overrideRes.rows.map((r) => [r.import_row_id, r.decision as ChildDecision]),
  );

  // Group child rows by property key.
  const contactsByKey = new Map<string, BatchRow[]>();
  const evidenceByKey = new Map<string, BatchRow[]>();
  const propertyRowByKey = new Map<string, BatchRow>();
  for (const row of data.rows) {
    if (!row.sourcePropertyKey || !row.normalized) continue;
    if (row.rowKind === "property") {
      // Structurally rejected property rows are never promotable (review fix
      // F2): they are not rendered as bundles and can never create/match a
      // canonical hotel.
      if (row.validationStatus === "rejected") continue;
      propertyRowByKey.set(row.sourcePropertyKey, row);
    } else if (row.rowKind === "contact")
      contactsByKey.set(row.sourcePropertyKey, [
        ...(contactsByKey.get(row.sourcePropertyKey) ?? []),
        row,
      ]);
    else if (row.rowKind === "evidence")
      evidenceByKey.set(row.sourcePropertyKey, [
        ...(evidenceByKey.get(row.sourcePropertyKey) ?? []),
        row,
      ]);
  }

  if (opts.apply && !reviewState.complete) {
    throw new Error(
      `Cannot --apply: batch review is incomplete (deferred=${reviewState.deferred}, missing=${reviewState.missing}). All property bundles must be approve_create/approve_match/reject.`,
    );
  }

  const totals = {
    hotelsCreated: 0,
    hotelsMatched: 0,
    contactsCreated: 0,
    contactsReused: 0,
    evidenceCreated: 0,
  };
  const bundles: BundlePlan[] = [];
  let allPromoted = true;

  for (const [key, propertyRow] of propertyRowByKey) {
    const review = reviewByKey.get(key);
    const decision = review?.decision ?? "(none)";
    const plan: BundlePlan = {
      sourcePropertyKey: key,
      decision,
      action: "skip",
      hotelId: null,
      hotelSlug: null,
      hotelAlreadyPromoted: false,
      contactsCreated: 0,
      contactsReused: 0,
      contactsSkipped: 0,
      evidenceCreated: 0,
      filledHotelFields: [],
      conflicts: [],
      notes: [],
    };

    if (!review || (decision !== "approve_create" && decision !== "approve_match")) {
      plan.action = "skip";
      plan.notes.push(
        decision === "reject" || decision === "defer" || decision === "(none)"
          ? `no promotion (decision=${decision})`
          : decision,
      );
      bundles.push(plan);
      continue;
    }
    plan.action = decision === "approve_create" ? "create" : "match";

    const property = propertyRow.normalized as unknown as PropertyRecord;
    const contacts = contactsByKey.get(key) ?? [];
    const evidence = evidenceByKey.get(key) ?? [];

    if (!opts.apply) {
      // Preview: describe the plan without any mutation.
      if (decision === "approve_create") {
        plan.hotelSlug = slugifyName(property.propertyName);
        plan.notes.push(`would create hotel in destination ${review.destination_id}`);
      } else {
        plan.hotelId = review.target_hotel_id;
        plan.notes.push(`would match hotel ${review.target_hotel_id}`);
      }
      for (const cr of contacts) {
        const inc = finalContactInclusion(
          cr.validationStatus,
          cr.normalized as unknown as ContactRecord,
          overridesByRow.get(cr.importRowId),
        );
        if (inc === "include") plan.contactsCreated++;
        else plan.contactsSkipped++;
      }
      bundles.push(plan);
      continue;
    }

    // Apply: transaction per bundle. Mutation counters are committed-only
    // (review fix F6): a hotel create/match, contact create/reuse, evidence
    // create, or filled hotel field counts toward the plan/totals ONLY after a
    // successful COMMIT. A rolled-back bundle reports zero canonical mutations.
    let hotelCreated = false;
    let hotelMatched = false;
    let committed = false;
    try {
      await client.query("begin");
      // Lock the property review row to serialize concurrent promotion.
      await client.query(
        "select id from public.import_property_reviews where import_batch_id=$1 and source_property_key=$2 for update",
        [batchId, key],
      );

      // Idempotency: has this property already been promoted to a hotel?
      const existingHotel = await existingLinkEntity(client, propertyRow.importRowId, [
        "created",
        "matched",
      ]);
      let hotelId: string;

      if (existingHotel) {
        hotelId = existingHotel;
        plan.hotelAlreadyPromoted = true;
      } else if (decision === "approve_create") {
        if (!review.destination_id) throw new Error("approve_create missing destination");
        const destInfo = await destinationInfoById(client, review.destination_id);
        const slug = await generateSlug(client, property.propertyName, destInfo.slug, key);
        // F10: a new hotel's country must be consistent with its canonical
        // destination. When both the staged country and the destination country
        // are known and differ, fail with ZERO canonical mutation. When the
        // staged country is null, inherit the destination country.
        const destCountry = destInfo.countryCode;
        const stagedCountry = property.countryCode;
        if (stagedCountry !== null && destCountry !== null && stagedCountry !== destCountry) {
          throw new Error(
            `country conflict: staged country ${stagedCountry} conflicts with destination country ${destCountry}`,
          );
        }
        const effectiveCountry = stagedCountry ?? destCountry;
        // F4: a new canonical hotel may be upgraded to `verified` ONLY by an
        // evidence row that (a) claims property_exists, (b) is itself verified,
        // AND (c) resolves to final child inclusion = include (default policy +
        // reviewer override). Deferred/excluded/rejected/invalid evidence must
        // never upgrade hotel verification.
        const verified = evidence.some((er) => {
          const e = er.normalized as unknown as EvidenceRecord;
          return (
            e.claimType === "property_exists" &&
            e.verificationStatus === "verified" &&
            finalEvidenceInclusion(er.validationStatus, e, overridesByRow.get(er.importRowId)) ===
              "include"
          );
        });
        const ins = await client.query<{ id: string }>(
          `insert into public.hotels
             (name, slug, destination_id, country_code, address, latitude, longitude,
              website_url, instagram_url, hotel_type, star_rating, active_status,
              editorial_verification_status)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'unknown',$12)
           returning id`,
          [
            property.propertyName,
            slug,
            review.destination_id,
            effectiveCountry,
            property.address,
            property.latitude,
            property.longitude,
            property.websiteUrl,
            property.instagramUrl,
            property.hotelType,
            property.starRating,
            verified ? "verified" : "unverified",
          ],
        );
        hotelId = ins.rows[0]!.id;
        plan.hotelSlug = slug;
        await addLink(client, propertyRow.importRowId, "hotel", hotelId, "created");
        hotelCreated = true;
      } else {
        // approve_match
        hotelId = review.target_hotel_id!;
        const canonical = await client.query(
          `select h.country_code, h.address, h.latitude, h.longitude, h.website_url,
                  h.instagram_url, h.hotel_type, h.star_rating, d.country_code as dest_country
             from public.hotels h
             left join public.destinations d on d.id = h.destination_id
             where h.id = $1`,
          [hotelId],
        );
        if (canonical.rows.length === 0) throw new Error("target hotel disappeared");
        const current = canonical.rows[0] as Record<string, unknown>;
        const fills: string[] = [];
        for (const f of HOTEL_FILL_FIELDS) {
          const staged = f.get(property);
          if (current[f.col] === null && staged !== null && staged !== undefined) {
            await client.query(`update public.hotels set ${f.col} = $2 where id = $1`, [
              hotelId,
              staged,
            ]);
            fills.push(f.col);
          } else if (
            current[f.col] !== null &&
            staged !== null &&
            staged !== undefined &&
            String(current[f.col]) !== String(staged)
          ) {
            plan.conflicts.push(f.col);
          }
        }

        // F10: country_code is special — the hotel country must never conflict
        // with its canonical destination. Only a NULL hotel country may be
        // filled, preferring the destination country; a staged country that
        // conflicts with the destination (or an already-set hotel country) is
        // reported as a conflict and never written.
        const stagedCountry = property.countryCode;
        const currentCountry = (current.country_code as string | null) ?? null;
        const destCountry = (current.dest_country as string | null) ?? null;
        if (currentCountry === null) {
          if (destCountry !== null) {
            await client.query("update public.hotels set country_code = $2 where id = $1", [
              hotelId,
              destCountry,
            ]);
            fills.push("country_code");
            if (stagedCountry !== null && stagedCountry !== destCountry) {
              plan.conflicts.push("country_code");
            }
          } else if (stagedCountry !== null) {
            await client.query("update public.hotels set country_code = $2 where id = $1", [
              hotelId,
              stagedCountry,
            ]);
            fills.push("country_code");
          }
        } else if (stagedCountry !== null && stagedCountry !== currentCountry) {
          plan.conflicts.push("country_code");
        }
        plan.filledHotelFields = fills;
        await addLink(client, propertyRow.importRowId, "hotel", hotelId, "matched");
        if (fills.length > 0)
          await addLink(client, propertyRow.importRowId, "hotel", hotelId, "updated");
        hotelMatched = true;
      }

      plan.hotelId = hotelId;

      await promoteContactsAndEvidence(
        {
          db: client,
          batchId,
          propertyRow,
          property,
          contacts,
          evidence,
          childOverrides: overridesByRow,
        },
        hotelId,
        plan,
      );

      await client.query("commit");
      committed = true;
    } catch (err) {
      await client.query("rollback");
      plan.error = err instanceof Error ? err.message : String(err);
      allPromoted = false;
    }

    if (committed) {
      if (hotelCreated) totals.hotelsCreated++;
      if (hotelMatched) totals.hotelsMatched++;
      totals.contactsCreated += plan.contactsCreated;
      totals.contactsReused += plan.contactsReused;
      totals.evidenceCreated += plan.evidenceCreated;
    } else {
      // Rolled back: no canonical row was created/matched/updated in this
      // transaction, so every mutation counter must reflect committed DB state
      // (review fix F6). Diagnostics (conflicts/notes/error) are retained.
      plan.hotelId = null;
      plan.hotelSlug = null;
      plan.hotelAlreadyPromoted = false;
      plan.contactsCreated = 0;
      plan.contactsReused = 0;
      plan.evidenceCreated = 0;
      plan.filledHotelFields = [];
    }
    bundles.push(plan);
  }

  // Batch state: promoted only when applying, review complete, and every
  // approved bundle promoted without error.
  let batchStatus = data.batch.status;
  if (opts.apply && reviewState.complete && allPromoted) {
    await client.query("update public.import_batches set status='promoted' where id=$1", [batchId]);
    batchStatus = "promoted";
  }

  return {
    batchId,
    apply: opts.apply,
    reviewComplete: reviewState.complete,
    batchStatus,
    bundles,
    totals,
  };
}
