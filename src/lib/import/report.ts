/**
 * Dry-run report generator (IMPORT_SPEC.md §14, §15). Produces JSON + Markdown
 * with every required section. Match candidates always explain their method.
 *
 * Pure: given staged rows + resolution + batch metadata it computes the report,
 * so both `import:dry-run` (in-memory) and `import:report` (rebuilt from DB) use
 * the same logic.
 */
import type { ContactRecord, PropertyRecord } from "./contract";
import type { ResolutionResult } from "./resolve";
import type { StagedRow } from "./stage";

export interface ReportBatchMeta {
  id: string;
  sourceName: string;
  sourceFileName: string | null;
  sourceKind: string;
  parserName: string;
  parserVersion: string;
  fileSha256: string | null;
  status: string;
  createdAt: string;
}

export interface ReportInput {
  batch: ReportBatchMeta;
  rows: StagedRow[];
  resolution: ResolutionResult;
}

export interface ReportSummary {
  totalRows: number;
  properties: number;
  contacts: number;
  evidence: number;
  validRows: number;
  warningRows: number;
  reviewRows: number;
  rejectedRows: number;
  validEmails: number;
  maskedEmails: number;
  noContactProperties: number;
  deterministicSafeMatches: number;
  fuzzyReviewCandidates: number;
  unresolvedDestinations: number;
  ambiguousMultiPropertyRows: number;
  organizationCandidates: number;
}

function isMarketingOrPr(c: ContactRecord): boolean {
  return (
    c.department === "marketing" ||
    c.department === "pr" ||
    c.department === "communications" ||
    c.department === "partnerships"
  );
}

export interface BuiltReport {
  json: Record<string, unknown>;
  markdown: string;
  summary: ReportSummary;
}

export function buildReport(input: ReportInput): BuiltReport {
  const { rows, resolution, batch } = input;

  const propertyRows = rows.filter((r) => r.rowKind === "property");
  const contactRows = rows.filter((r) => r.rowKind === "contact");
  const evidenceRows = rows.filter((r) => r.rowKind === "evidence");

  const byStatus = (s: string) => rows.filter((r) => r.status === s).length;

  // Contacts grouped by property key (non-rejected only).
  const contactsByKey = new Map<string, ContactRecord[]>();
  for (const r of contactRows) {
    if (r.status === "rejected" || !r.normalized) continue;
    const c = r.normalized as unknown as ContactRecord;
    const list = contactsByKey.get(c.sourcePropertyKey) ?? [];
    list.push(c);
    contactsByKey.set(c.sourcePropertyKey, list);
  }

  // Emails.
  let validEmails = 0;
  let maskedEmails = 0;
  const verificationDistribution: Record<string, number> = {};
  for (const r of contactRows) {
    if (r.warnings.some((w) => w.includes("masked"))) maskedEmails++;
    if (r.normalized) {
      const c = r.normalized as unknown as ContactRecord;
      if (c.email) validEmails++;
      verificationDistribution[c.verificationStatus] =
        (verificationDistribution[c.verificationStatus] ?? 0) + 1;
    }
  }

  // Properties with no contact.
  const noContactProperties = propertyRows
    .filter((r) => r.status !== "rejected" && r.normalized)
    .map((r) => r.normalized as unknown as PropertyRecord)
    .filter((p) => (contactsByKey.get(p.sourcePropertyKey) ?? []).length === 0)
    .map((p) => ({ sourcePropertyKey: p.sourcePropertyKey, propertyName: p.propertyName }));

  // Matches.
  const deterministicSafe = resolution.properties.flatMap((pr) =>
    pr.hotelCandidates
      .filter((c) => c.deterministicSafe)
      .map((c) => ({
        propertyName: pr.property.propertyName,
        sourcePropertyKey: pr.property.sourcePropertyKey,
        candidateHotelId: c.candidateEntityId,
        score: c.score,
        method: c.matchMethod,
        explanation: c.explanation,
      })),
  );
  const fuzzyReview = resolution.properties.flatMap((pr) =>
    pr.hotelCandidates
      .filter((c) => !c.deterministicSafe)
      .map((c) => ({
        propertyName: pr.property.propertyName,
        sourcePropertyKey: pr.property.sourcePropertyKey,
        candidateHotelId: c.candidateEntityId,
        score: c.score,
        method: c.matchMethod,
        explanation: c.explanation,
      })),
  );

  const unresolvedDestinations = resolution.properties
    .filter((pr) => pr.destinationUnresolved)
    .map((pr) => ({
      propertyName: pr.property.propertyName,
      destinationName: pr.property.destinationName,
      countryCode: pr.property.countryCode,
    }));

  const ambiguousMultiProperty = rows
    .filter((r) => r.warnings.some((w) => w.toLowerCase().includes("multi-property")))
    .map((r) => ({
      sheet: r.sheetName,
      row: r.sourceRowNumber,
      warnings: r.warnings,
    }));

  const rejected = rows
    .filter((r) => r.status === "rejected")
    .map((r) => ({
      sheet: r.sheetName,
      row: r.sourceRowNumber,
      kind: r.rowKind,
      errors: r.errors,
    }));
  const reviewRequired = rows
    .filter((r) => r.status === "review")
    .map((r) => ({
      sheet: r.sheetName,
      row: r.sourceRowNumber,
      kind: r.rowKind,
      warnings: r.warnings,
    }));

  // Transparent completeness dimensions per property (IMPORT_SPEC §15).
  const completeness = propertyRows
    .filter((r) => r.status !== "rejected" && r.normalized)
    .map((r) => {
      const p = r.normalized as unknown as PropertyRecord;
      const pr = resolution.properties.find(
        (x) =>
          x.stagedRow.sourceRowNumber === r.sourceRowNumber &&
          x.stagedRow.sheetName === r.sheetName,
      );
      const propContacts = contactsByKey.get(p.sourcePropertyKey) ?? [];
      return {
        sourcePropertyKey: p.sourcePropertyKey,
        propertyName: p.propertyName,
        destinationResolved: pr ? !pr.destinationUnresolved : false,
        websiteOrSourcePresent: Boolean(p.websiteUrl || p.sourceUrl),
        anyContact: propContacts.length > 0,
        marketingOrPrContact: propContacts.some(isMarketingOrPr),
        namedContact: propContacts.some((c) => c.contactName !== null),
        provenancePresent: Boolean(p.sourceUrl),
        verificationKnown: propContacts.some((c) => c.verificationStatus !== "unverified"),
        needsReview: r.status === "review",
      };
    });

  const completenessAgg = (key: keyof (typeof completeness)[number]) =>
    completeness.length === 0
      ? 0
      : Number(
          (
            (completeness.filter((c) => c[key] === true).length / completeness.length) *
            100
          ).toFixed(1),
        );

  const summary: ReportSummary = {
    totalRows: rows.length,
    properties: propertyRows.length,
    contacts: contactRows.length,
    evidence: evidenceRows.length,
    validRows: byStatus("valid"),
    warningRows: byStatus("warning"),
    reviewRows: byStatus("review"),
    rejectedRows: byStatus("rejected"),
    validEmails,
    maskedEmails,
    noContactProperties: noContactProperties.length,
    deterministicSafeMatches: deterministicSafe.length,
    fuzzyReviewCandidates: fuzzyReview.length,
    unresolvedDestinations: unresolvedDestinations.length,
    ambiguousMultiPropertyRows: ambiguousMultiProperty.length,
    organizationCandidates: resolution.organizationCandidates.length,
  };

  const json: Record<string, unknown> = {
    batch,
    summary,
    sourceRowCounts: {
      properties: propertyRows.length,
      contacts: contactRows.length,
      evidence: evidenceRows.length,
    },
    propertyCandidates: propertyRows
      .filter((r) => r.normalized)
      .map((r) => {
        const p = r.normalized as unknown as PropertyRecord;
        return {
          sourcePropertyKey: p.sourcePropertyKey,
          propertyName: p.propertyName,
          status: r.status,
        };
      }),
    contactCandidates: contactRows
      .filter((r) => r.normalized)
      .map((r) => {
        const c = r.normalized as unknown as ContactRecord;
        return {
          sourcePropertyKey: c.sourcePropertyKey,
          contactName: c.contactName,
          department: c.department,
          hasEmail: c.email !== null,
          generic: c.isGenericMailbox,
          verificationStatus: c.verificationStatus,
          status: r.status,
        };
      }),
    organizationCandidates: resolution.organizationCandidates,
    emails: { valid: validEmails, masked: maskedEmails },
    noContactProperties,
    deterministicSafeMatches: deterministicSafe,
    fuzzyReviewCandidates: fuzzyReview,
    unresolvedDestinations,
    ambiguousMultiPropertyRows: ambiguousMultiProperty,
    verificationDistribution,
    rejectedRows: rejected,
    reviewRequiredRows: reviewRequired,
    completenessPerProperty: completeness,
    completenessSummaryPct: {
      destinationResolved: completenessAgg("destinationResolved"),
      websiteOrSourcePresent: completenessAgg("websiteOrSourcePresent"),
      anyContact: completenessAgg("anyContact"),
      marketingOrPrContact: completenessAgg("marketingOrPrContact"),
      namedContact: completenessAgg("namedContact"),
      provenancePresent: completenessAgg("provenancePresent"),
      verificationKnown: completenessAgg("verificationKnown"),
      needsReview: completenessAgg("needsReview"),
    },
  };

  return { json, markdown: renderMarkdown(batch, summary, json), summary };
}

function renderMarkdown(
  batch: ReportBatchMeta,
  s: ReportSummary,
  json: Record<string, unknown>,
): string {
  const pct = json.completenessSummaryPct as Record<string, number>;
  const vdist = json.verificationDistribution as Record<string, number>;
  const safe = json.deterministicSafeMatches as {
    propertyName: string;
    method: string;
    explanation: string;
    score: number;
  }[];
  const fuzzy = json.fuzzyReviewCandidates as {
    propertyName: string;
    method: string;
    explanation: string;
    score: number;
  }[];
  const unresolved = json.unresolvedDestinations as {
    propertyName: string;
    destinationName: string | null;
  }[];

  const lines: string[] = [];
  lines.push(`# Import dry-run report`);
  lines.push("");
  lines.push(`- **Batch**: ${batch.id}`);
  lines.push(`- **Source**: ${batch.sourceName} (${batch.sourceKind})`);
  lines.push(`- **File**: ${batch.sourceFileName ?? "—"}`);
  lines.push(`- **Parser**: ${batch.parserName} v${batch.parserVersion}`);
  lines.push(`- **SHA256**: ${batch.fileSha256 ?? "—"}`);
  lines.push(`- **Status**: ${batch.status}`);
  lines.push("");
  lines.push(`> Dry run only. No canonical promotion occurred.`);
  lines.push("");
  lines.push(`## Row summary`);
  lines.push("");
  lines.push(`| metric | count |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| source rows | ${s.totalRows} |`);
  lines.push(`| properties | ${s.properties} |`);
  lines.push(`| contacts | ${s.contacts} |`);
  lines.push(`| evidence | ${s.evidence} |`);
  lines.push(`| valid | ${s.validRows} |`);
  lines.push(`| warning | ${s.warningRows} |`);
  lines.push(`| review-required | ${s.reviewRows} |`);
  lines.push(`| rejected | ${s.rejectedRows} |`);
  lines.push(`| valid emails | ${s.validEmails} |`);
  lines.push(`| masked emails (rejected) | ${s.maskedEmails} |`);
  lines.push(`| properties with no contact | ${s.noContactProperties} |`);
  lines.push(`| organization candidates | ${s.organizationCandidates} |`);
  lines.push("");
  lines.push(`## Entity resolution`);
  lines.push("");
  lines.push(`- Deterministic safe matches: **${s.deterministicSafeMatches}**`);
  lines.push(`- Fuzzy review candidates: **${s.fuzzyReviewCandidates}**`);
  lines.push(`- Unresolved destinations: **${s.unresolvedDestinations}**`);
  lines.push(`- Ambiguous multi-property rows: **${s.ambiguousMultiPropertyRows}**`);
  lines.push("");
  if (safe.length) {
    lines.push(`### Deterministic safe matches`);
    for (const m of safe)
      lines.push(`- ${m.propertyName} — \`${m.method}\` (${m.score}): ${m.explanation}`);
    lines.push("");
  }
  if (fuzzy.length) {
    lines.push(`### Fuzzy / review candidates (never auto-merged)`);
    for (const m of fuzzy)
      lines.push(`- ${m.propertyName} — \`${m.method}\` (${m.score}): ${m.explanation}`);
    lines.push("");
  }
  if (unresolved.length) {
    lines.push(`### Unresolved destinations`);
    for (const u of unresolved) lines.push(`- ${u.propertyName} → "${u.destinationName ?? "—"}"`);
    lines.push("");
  }
  lines.push(`## Verification distribution (contacts)`);
  lines.push("");
  for (const [k, v] of Object.entries(vdist)) lines.push(`- ${k}: ${v}`);
  if (Object.keys(vdist).length === 0) lines.push(`- (none)`);
  lines.push("");
  lines.push(`## Completeness (% of staged properties)`);
  lines.push("");
  lines.push(`| dimension | % |`);
  lines.push(`| --- | ---: |`);
  for (const [k, v] of Object.entries(pct)) lines.push(`| ${k} | ${v}% |`);
  lines.push("");
  lines.push(`## Review & rejection`);
  lines.push("");
  lines.push(`- Rejected rows: ${s.rejectedRows}`);
  lines.push(`- Review-required rows: ${s.reviewRows}`);
  lines.push("");
  lines.push(`_Generated by the theugc.life import pipeline (Sprint 1A)._`);
  return lines.join("\n");
}
