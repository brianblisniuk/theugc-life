/**
 * Reviewer manifest workflow (CANONICAL_PROMOTION_SPEC.md §14, D035).
 *
 * `buildReviewTemplate` produces a gitignored JSON manifest describing every
 * property bundle, its destination resolution, hotel match candidates, and the
 * default child inclusion status — with editable reviewer decision fields.
 *
 * `applyReview` validates a returned manifest and writes ONLY review state
 * (import_property_reviews / import_row_reviews). It never promotes canonical
 * data. It then recomputes the batch's review completeness.
 */
import type { Client } from "pg";
import { z } from "zod";

import type { ContactRecord, EvidenceRecord, PropertyRecord } from "./contract";
import { loadBatchData, type BatchRow } from "./db";
import { loadDestinationCatalog, resolveDestination } from "./destination";
import { defaultContactInclusion, defaultEvidenceInclusion, type Inclusion } from "./childPolicy";

// --- Manifest shapes -------------------------------------------------------

export interface ReviewChildContact {
  importRowId: string;
  validationStatus: string;
  defaultInclusion: Inclusion;
  contactName: string | null;
  email: string | null;
  department: string | null;
  contactScope: string | null;
  organizationName: string | null;
  verificationStatus: string;
}

export interface ReviewChildEvidence {
  importRowId: string;
  validationStatus: string;
  defaultInclusion: Inclusion;
  claimType: string;
  sourceType: string;
  verificationStatus: string;
}

export interface ReviewBundle {
  sourcePropertyKey: string;
  property: {
    propertyName: string;
    destinationName: string | null;
    destinationSlug: string | null;
    countryCode: string | null;
    validationStatus: string;
  };
  destinationResolution: { destinationId: string | null; method: string | null };
  hotelCandidates: {
    candidateHotelId: string | null;
    score: number;
    method: string;
    explanation: string;
    deterministicSafe: boolean;
  }[];
  contacts: ReviewChildContact[];
  evidence: ReviewChildEvidence[];
  // Editable reviewer decision fields (defaults below).
  decision: "approve_create" | "approve_match" | "reject" | "defer";
  targetHotelId: string | null;
  destinationId: string | null;
  reviewNote: string | null;
  childOverrides: { importRowId: string; decision: "include" | "exclude" | "defer" }[];
}

export interface ReviewManifest {
  batchId: string;
  sourceName: string;
  bundles: ReviewBundle[];
}

function asContact(row: BatchRow): ContactRecord {
  return row.normalized as unknown as ContactRecord;
}
function asEvidence(row: BatchRow): EvidenceRecord {
  return row.normalized as unknown as EvidenceRecord;
}
function asProperty(row: BatchRow): PropertyRecord {
  return row.normalized as unknown as PropertyRecord;
}

export async function buildReviewTemplate(
  client: Client,
  batchId: string,
): Promise<ReviewManifest> {
  const data = await loadBatchData(client, batchId);
  const catalog = await loadDestinationCatalog(client);

  const contactsByKey = new Map<string, BatchRow[]>();
  const evidenceByKey = new Map<string, BatchRow[]>();
  for (const row of data.rows) {
    if (!row.sourcePropertyKey || !row.normalized) continue;
    if (row.rowKind === "contact") {
      const list = contactsByKey.get(row.sourcePropertyKey) ?? [];
      list.push(row);
      contactsByKey.set(row.sourcePropertyKey, list);
    } else if (row.rowKind === "evidence") {
      const list = evidenceByKey.get(row.sourcePropertyKey) ?? [];
      list.push(row);
      evidenceByKey.set(row.sourcePropertyKey, list);
    }
  }

  const bundles: ReviewBundle[] = [];
  for (const row of data.rows) {
    if (row.rowKind !== "property" || !row.normalized || !row.sourcePropertyKey) continue;
    const p = asProperty(row);
    const dest = resolveDestination(
      { slug: p.destinationSlug, name: p.destinationName, countryCode: p.countryCode },
      catalog,
    );

    const contacts: ReviewChildContact[] = (contactsByKey.get(row.sourcePropertyKey) ?? []).map(
      (cr) => {
        const c = asContact(cr);
        return {
          importRowId: cr.importRowId,
          validationStatus: cr.validationStatus,
          defaultInclusion: defaultContactInclusion(cr.validationStatus, c),
          contactName: c.contactName,
          email: c.email,
          department: c.department,
          contactScope: c.contactScope,
          organizationName: c.organizationName,
          verificationStatus: c.verificationStatus,
        };
      },
    );
    const evidence: ReviewChildEvidence[] = (evidenceByKey.get(row.sourcePropertyKey) ?? []).map(
      (er) => {
        const e = asEvidence(er);
        return {
          importRowId: er.importRowId,
          validationStatus: er.validationStatus,
          defaultInclusion: defaultEvidenceInclusion(er.validationStatus, e),
          claimType: e.claimType,
          sourceType: e.sourceType,
          verificationStatus: e.verificationStatus,
        };
      },
    );

    bundles.push({
      sourcePropertyKey: row.sourcePropertyKey,
      property: {
        propertyName: p.propertyName,
        destinationName: p.destinationName,
        destinationSlug: p.destinationSlug,
        countryCode: p.countryCode,
        validationStatus: row.validationStatus,
      },
      destinationResolution: { destinationId: dest.destinationId, method: dest.method },
      hotelCandidates: (data.hotelCandidatesByPropertyKey.get(row.sourcePropertyKey) ?? []).map(
        (hc) => ({
          candidateHotelId: hc.entityId,
          score: hc.score,
          method: hc.method,
          explanation: hc.explanation,
          deterministicSafe: hc.deterministicSafe,
        }),
      ),
      contacts,
      evidence,
      // Defaults: nothing is approved until a reviewer edits the manifest.
      decision: "defer",
      targetHotelId: null,
      destinationId: dest.destinationId,
      reviewNote: null,
      childOverrides: [],
    });
  }

  return { batchId, sourceName: data.batch.sourceName, bundles };
}

// --- Apply -----------------------------------------------------------------

const decisionSchema = z.object({
  sourcePropertyKey: z.string().min(1),
  decision: z.enum(["approve_create", "approve_match", "reject", "defer"]),
  targetHotelId: z.string().uuid().nullable().optional(),
  destinationId: z.string().uuid().nullable().optional(),
  reviewNote: z.string().nullable().optional(),
  childOverrides: z
    .array(
      z.object({
        importRowId: z.string().uuid(),
        decision: z.enum(["include", "exclude", "defer"]),
        reviewNote: z.string().nullable().optional(),
      }),
    )
    .optional(),
});

const manifestSchema = z.object({
  batchId: z.string().uuid(),
  bundles: z.array(decisionSchema),
});

export interface ApplyReviewResult {
  bundlesWritten: number;
  childOverridesWritten: number;
  batchStatus: string;
  complete: boolean;
}

export async function applyReview(
  client: Client,
  batchId: string,
  manifestJson: unknown,
  reviewerLabel: string,
): Promise<ApplyReviewResult> {
  const parsed = manifestSchema.safeParse(manifestJson);
  if (!parsed.success) {
    throw new Error(
      `Invalid review manifest:\n${parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`,
    );
  }
  const manifest = parsed.data;
  if (manifest.batchId !== batchId) {
    throw new Error("manifest batchId does not match --batch");
  }
  if (!reviewerLabel || reviewerLabel.trim().length === 0) {
    throw new Error("--reviewer label is required");
  }

  let bundlesWritten = 0;
  let childOverridesWritten = 0;

  await client.query("begin");
  try {
    for (const b of manifest.bundles) {
      // Cross-field validation beyond the DB check constraint.
      if (b.decision === "approve_create") {
        if (!b.destinationId)
          throw new Error(`${b.sourcePropertyKey}: approve_create requires destinationId`);
        if (b.targetHotelId)
          throw new Error(`${b.sourcePropertyKey}: approve_create must not set targetHotelId`);
      }
      if (b.decision === "approve_match") {
        if (!b.targetHotelId)
          throw new Error(`${b.sourcePropertyKey}: approve_match requires targetHotelId`);
        const hotel = await client.query<{ destination_id: string }>(
          "select destination_id from public.hotels where id = $1",
          [b.targetHotelId],
        );
        if (hotel.rows.length === 0)
          throw new Error(`${b.sourcePropertyKey}: target hotel not found`);
        if (b.destinationId && b.destinationId !== hotel.rows[0]!.destination_id) {
          throw new Error(
            `${b.sourcePropertyKey}: destinationId must equal target hotel's destination`,
          );
        }
      }
      if ((b.decision === "reject" || b.decision === "defer") && b.targetHotelId) {
        throw new Error(`${b.sourcePropertyKey}: ${b.decision} must not set targetHotelId`);
      }

      const destinationId =
        b.decision === "approve_create"
          ? b.destinationId
          : b.decision === "approve_match"
            ? null
            : null;

      await client.query(
        `insert into public.import_property_reviews
           (import_batch_id, source_property_key, decision, target_hotel_id, destination_id,
            reviewer_label, review_note, reviewed_at)
         values ($1,$2,$3,$4,$5,$6,$7, now())
         on conflict (import_batch_id, source_property_key) do update set
           decision=excluded.decision, target_hotel_id=excluded.target_hotel_id,
           destination_id=excluded.destination_id, reviewer_label=excluded.reviewer_label,
           review_note=excluded.review_note, reviewed_at=now()`,
        [
          batchId,
          b.sourcePropertyKey,
          b.decision,
          b.decision === "approve_match" ? b.targetHotelId : null,
          destinationId ?? null,
          reviewerLabel,
          b.reviewNote ?? null,
        ],
      );
      bundlesWritten++;

      for (const override of b.childOverrides ?? []) {
        await client.query(
          `insert into public.import_row_reviews
             (import_row_id, decision, reviewer_label, review_note, reviewed_at)
           values ($1,$2,$3,$4, now())
           on conflict (import_row_id) do update set
             decision=excluded.decision, reviewer_label=excluded.reviewer_label,
             review_note=excluded.review_note, reviewed_at=now()`,
          [override.importRowId, override.decision, reviewerLabel, override.reviewNote ?? null],
        );
        childOverridesWritten++;
      }
    }

    const state = await computeBatchApprovalState(client, batchId);
    const newStatus = state.complete ? "approved" : "review_required";
    await client.query("update public.import_batches set status=$2 where id=$1", [
      batchId,
      newStatus,
    ]);

    await client.query("commit");
    return {
      bundlesWritten,
      childOverridesWritten,
      batchStatus: newStatus,
      complete: state.complete,
    };
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

export interface BatchApprovalState {
  complete: boolean;
  propertyBundles: number;
  reviewed: number;
  deferred: number;
  missing: number;
}

/**
 * A batch's review is complete only when EVERY property bundle has a final
 * decision of approve_create / approve_match / reject (no defer, none missing)
 * (CANONICAL_PROMOTION_SPEC.md §15).
 */
export async function computeBatchApprovalState(
  client: Client,
  batchId: string,
): Promise<BatchApprovalState> {
  const propKeys = await client.query<{ source_property_key: string }>(
    `select distinct source_property_key from public.import_rows
       where import_batch_id = $1 and row_kind = 'property' and source_property_key is not null`,
    [batchId],
  );
  const reviews = await client.query<{ source_property_key: string; decision: string }>(
    "select source_property_key, decision from public.import_property_reviews where import_batch_id = $1",
    [batchId],
  );
  const byKey = new Map(reviews.rows.map((r) => [r.source_property_key, r.decision]));

  let reviewed = 0;
  let deferred = 0;
  let missing = 0;
  for (const { source_property_key: key } of propKeys.rows) {
    const decision = byKey.get(key);
    if (!decision) missing++;
    else if (decision === "defer") deferred++;
    else reviewed++;
  }
  const total = propKeys.rows.length;
  return {
    complete: total > 0 && deferred === 0 && missing === 0,
    propertyBundles: total,
    reviewed,
    deferred,
    missing,
  };
}
