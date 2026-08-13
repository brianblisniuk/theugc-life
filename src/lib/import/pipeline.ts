/**
 * Import pipeline orchestration (IMPORT_SPEC.md §2). Ties parsing → staging →
 * persistence → resolution → dry-run reporting. STOPS before canonical
 * promotion — Sprint 1A never writes canonical hotels/contacts (D032).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Client } from "pg";

import {
  createBatch,
  findReusableBatch,
  getBatchReportInput,
  insertStagedRows,
  loadExistingData,
  persistResolution,
  updateBatchCounters,
  type BatchMeta,
  type RowCounters,
} from "./db";
import { sha256Hex } from "./fingerprint";
import type { LegacyAdapter } from "./legacy";
import { readCanonicalSource } from "./parse";
import { buildReport, type BuiltReport } from "./report";
import { resolveEntities } from "./resolve";
import { stageRawSheets, type StagedRow } from "./stage";

export const STANDARD_PARSER = { name: "canonical-standard", version: "1.0.0" } as const;
export const REPORTS_DIR = path.resolve(process.cwd(), "data", "imports", "reports");

function counters(rows: StagedRow[]): RowCounters {
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  return {
    total: rows.length,
    valid: count("valid"),
    warning: count("warning"),
    review: count("review"),
    rejected: count("rejected"),
  };
}

function statusFor(c: RowCounters): "parsed" | "review_required" {
  return c.review > 0 || c.rejected > 0 ? "review_required" : "parsed";
}

export interface StageOptions {
  file: string;
  contacts?: string;
  evidence?: string;
  sourceName?: string;
  adapter?: LegacyAdapter;
  /** Re-stage even if a batch for this file+parser already exists. */
  force?: boolean;
}

export interface StageResult {
  batchId: string;
  reused: boolean;
  counters: RowCounters;
}

/** Parse + stage a file into import_batches/import_rows. Idempotent by default. */
export async function stageFile(client: Client, opts: StageOptions): Promise<StageResult> {
  const buffer = await readFile(opts.file);
  const fileSha256 = sha256Hex(buffer);
  const fileName = path.basename(opts.file);

  const meta: BatchMeta = {
    sourceName: opts.sourceName ?? fileName,
    sourceFileName: fileName,
    sourceKind: opts.adapter ? "legacy" : "canonical",
    parserName: opts.adapter?.parserName ?? STANDARD_PARSER.name,
    parserVersion: opts.adapter?.parserVersion ?? STANDARD_PARSER.version,
    fileSha256,
  };

  if (!opts.force) {
    const reusable = await findReusableBatch(client, meta);
    if (reusable && reusable.status !== "failed") {
      // Repeat import detected — do not duplicate (IMPORT_SPEC §11).
      const existing = await getBatchReportInput(client, reusable.id);
      return { batchId: reusable.id, reused: true, counters: counters(existing.rows) };
    }
  }

  const rawSheets = opts.adapter
    ? await opts.adapter.parse(opts.file)
    : await readCanonicalSource({
        file: opts.file,
        contacts: opts.contacts,
        evidence: opts.evidence,
      });

  const staged = stageRawSheets(rawSheets).rows;
  const c = counters(staged);

  let batchId: string;
  try {
    batchId = await createBatch(client, meta);
  } catch (err) {
    // DB idempotency backstop (review F3): a concurrent process already staged
    // this file+parser as a non-failed batch. Treat as reused, not an error.
    if ((err as { code?: string }).code === "23505") {
      const raced = await findReusableBatch(client, meta);
      if (raced && raced.status !== "failed") {
        const existing = await getBatchReportInput(client, raced.id);
        return { batchId: raced.id, reused: true, counters: counters(existing.rows) };
      }
    }
    throw err;
  }
  const rowIdMap = await insertStagedRows(client, batchId, staged);
  await updateBatchCounters(client, batchId, c, statusFor(c));

  // Resolution is computed + persisted here so a subsequent dry-run/report is a
  // pure read. (Resolution touches only import_match_candidates.)
  const existing = await loadExistingData(client);
  const resolution = resolveEntities(staged, existing);
  await persistResolution(client, resolution, rowIdMap);

  return { batchId, reused: false, counters: c };
}

async function writeReportFiles(
  batchId: string,
  report: BuiltReport,
): Promise<{ json: string; md: string }> {
  await mkdir(REPORTS_DIR, { recursive: true });
  const jsonPath = path.join(REPORTS_DIR, `${batchId}.json`);
  const mdPath = path.join(REPORTS_DIR, `${batchId}.md`);
  await writeFile(jsonPath, JSON.stringify(report.json, null, 2), "utf8");
  await writeFile(mdPath, report.markdown, "utf8");
  return { json: jsonPath, md: mdPath };
}

export interface DryRunResult {
  batchId: string;
  reused: boolean;
  report: BuiltReport;
  paths: { json: string; md: string };
}

/** Full dry-run: stage (if needed), resolve, and write JSON + Markdown reports. */
export async function dryRunFile(client: Client, opts: StageOptions): Promise<DryRunResult> {
  const staged = await stageFile(client, opts);
  const input = await getBatchReportInput(client, staged.batchId);
  const report = buildReport(input);
  const paths = await writeReportFiles(staged.batchId, report);
  return { batchId: staged.batchId, reused: staged.reused, report, paths };
}

/** Regenerate reports for an already-staged batch (import:report). */
export async function reportBatch(
  client: Client,
  batchId: string,
): Promise<{ report: BuiltReport; paths: { json: string; md: string } }> {
  const input = await getBatchReportInput(client, batchId);
  const report = buildReport(input);
  const paths = await writeReportFiles(batchId, report);
  return { report, paths };
}
