/**
 * Scoring-v2 report rendering.
 *
 * A v2 report is a SEPARATE artifact (`report-v2.md`) from the v1 report
 * (`report.md`) — never the same file with a second section swapped in —
 * so a v1 report can never be mistaken for v2 evidence by filename alone.
 * Every table here prints exactly what the round's "print" requirement asks
 * for: strict n, per-class strict support, excluded multi-answer case count,
 * strict macro F1, and acceptable-answer accuracy over all cases.
 */
import { MIN_RELIABLE_CLASS_SUPPORT } from "../scoring/metrics";
import type {
  CandidateScoreV2,
  SingleLabelFieldScoreV2,
  SignalFieldScoreV2,
} from "../scoring/score-v2";
import { evaluateCandidateV2 } from "../scoring/targets-v2";
import { QUALITY_TARGETS } from "../scoring/targets";
import { SCORING_VERSION_V2 } from "../scoring/scoring-version";
import type { CorpusStats } from "../corpus/load";

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function n(value: number | null, digits = 4): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

export interface ReportV2Input {
  runId: string;
  stage: string;
  generatedAt: string;
  corpus: CorpusStats;
  scores: readonly CandidateScoreV2[];
  absences: { candidate_id: string; model: string; reason: string }[];
}

function renderSingleLabelFieldV2(fieldName: string, field: SingleLabelFieldScoreV2): string[] {
  const lines: string[] = [];
  lines.push(
    `**${fieldName}**`,
    "",
    `- acceptable-answer accuracy (ALL ${field.acceptable_answer.n} cases, candidate-independent support): ${pct(field.acceptable_answer.accuracy)} (${field.acceptable_answer.correct}/${field.acceptable_answer.n})`,
    `- strict n: ${field.strict.n} · excluded multi-answer cases: ${field.strict.excluded_multi_answer_cases}`,
    `- strict macro F1: ${n(field.strict.macro_f1)}`,
    "",
    "| class | strict support | P | R | F1 |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const [cls, metrics] of Object.entries(field.strict.per_class)) {
    const flag =
      metrics.support > 0 && metrics.support < MIN_RELIABLE_CLASS_SUPPORT ? " ⚠ low support" : "";
    lines.push(
      `| ${cls}${flag} | ${metrics.support} | ${n(metrics.precision, 3)} | ${n(metrics.recall, 3)} | ${n(metrics.f1, 3)} |`,
    );
  }
  lines.push(
    "",
    `_⚠ low support: fewer than ${MIN_RELIABLE_CLASS_SUPPORT} STRICT gold cases — this class's contribution to strict macro F1 is not a hard-evaluable signal on its own; see the quality-target verdict below for whether the whole target is \`insufficient_support\`._`,
    "",
  );
  return lines;
}

function renderSignalFieldV2(field: SignalFieldScoreV2): string[] {
  const lines: string[] = [];
  lines.push(
    "**signals**",
    "",
    `- acceptable-set (exact-match) accuracy (ALL ${field.acceptable_set.n} cases): ${pct(field.acceptable_set.accuracy)} (${field.acceptable_set.correct}/${field.acceptable_set.n})`,
    `- strict n: ${field.strict.n} · excluded multi-answer cases: ${field.strict.excluded_multi_answer_cases}`,
    `- strict micro F1: ${n(field.strict.micro.f1)} · strict macro F1: ${n(field.strict.macro_f1)}`,
    "",
    "| label | strict support | P | R | F1 |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const [label, metrics] of Object.entries(field.strict.per_label)) {
    const flag =
      metrics.support > 0 && metrics.support < MIN_RELIABLE_CLASS_SUPPORT ? " ⚠ low support" : "";
    lines.push(
      `| ${label}${flag} | ${metrics.support} | ${n(metrics.precision, 3)} | ${n(metrics.recall, 3)} | ${n(metrics.f1, 3)} |`,
    );
  }
  lines.push("");
  return lines;
}

export function renderReportV2(input: ReportV2Input): string {
  const lines: string[] = [];
  const push = (...parts: string[]): void => {
    lines.push(...parts);
  };

  push(
    "# B07 inference benchmark — SCORING V2 run report",
    "",
    `Scoring version: \`${SCORING_VERSION_V2}\``,
    `Run id: \`${input.runId}\``,
    `Stage: \`${input.stage}\``,
    `Generated: ${input.generatedAt}`,
    "",
    "> This report is a SCORING-V2 INTERPRETATION of the same raw inference",
    "> evidence as `report.md` (scoring v1). It is a DIFFERENT artifact and must",
    "> never be conflated with a v1 report — see `scoring/scoring-version.ts`.",
    "> Nothing here is B07 production code, and no result here authorizes",
    "> sending real Gmail-derived data to any provider.",
    "",
    "## Metric-family legend",
    "",
    "- **acceptable-answer accuracy** (Family A): correct iff prediction ==",
    "  primary gold OR prediction is in the case's declared acceptable set.",
    "  Uses ALL cases. Support is simply case count — never rewritten to match",
    "  a candidate's own prediction.",
    "- **strict** (Family B): ordinary precision/recall/F1, computed ONLY over",
    "  cases whose gold is single-valued for that field (no genuine acceptable",
    "  alternative exists), always against the untouched PRIMARY gold value.",
    "  Class/label support here is 100% corpus-derived and IDENTICAL for every",
    "  candidate scored against the same corpus selection.",
    "",
  );

  if (input.scores.length === 0) {
    push("_No candidate produced any scored result in this run._", "");
  } else {
    for (const s of input.scores) {
      push(`## \`${s.candidate_id}\``, "");
      push(
        `- critical invariant hard gate: ${s.critical_suite.passes_hard_gate ? "PASS" : "FAIL"} (${s.critical_suite.violations} violation(s), ${s.critical_suite.cases_evaluated}/${s.critical_suite.cases} evaluated)`,
        "",
      );
      if (s.message_task) {
        push("### Task M (message)", "");
        push(...renderSingleLabelFieldV2("disposition", s.message_task.disposition));
        push(...renderSignalFieldV2(s.message_task.signals));
        push(...renderSingleLabelFieldV2("evidence_strength", s.message_task.evidence_strength));
      }
      if (s.thread_task) {
        push("### Task T (thread)", "");
        push(...renderSingleLabelFieldV2("thread_state", s.thread_task.thread_state));
        push(
          ...renderSingleLabelFieldV2(
            "compensation_structure",
            s.thread_task.compensation_structure,
          ),
        );
        push(...renderSingleLabelFieldV2("evidence_strength", s.thread_task.evidence_strength));
        push(
          `**unknown predicted as unpaid: ${s.thread_task.unknown_predicted_as_unpaid}** (D072 §8 — must be 0, unaffected by this correction)`,
          `unpaid predicted as unknown: ${s.thread_task.unpaid_predicted_as_unknown}`,
          "",
        );
      }

      const evaluation = evaluateCandidateV2(s);
      push(
        "### Quality-target verdicts (tri-state: PASS / FAIL / INSUFFICIENT_SUPPORT)",
        "",
        "| target | state | threshold | value | detail |",
        "| --- | --- | --- | --- | --- |",
      );
      for (const t of evaluation.targets) {
        push(
          `| ${t.label} | **${t.state.toUpperCase()}** | ${t.threshold ?? "n/a"} | ${t.value ?? "n/a"} | ${t.detail} |`,
        );
      }
      push(
        "",
        `**Stage-1 status: \`${evaluation.status}\`**${evaluation.eliminationReasons.length > 0 ? ` — ${evaluation.eliminationReasons.join("; ")}` : ""}`,
        "",
        evaluation.status === "stage1_finalist_with_unresolved_quality_target"
          ? "> A Stage-1 finalist with an unresolved quality target is NOT a production/vendor winner. The unresolved target MUST be resolved in Stage 2 (against the frozen holdout corpus) before any final implementation/provider recommendation."
          : "",
        "",
      );
    }
  }

  if (input.absences.length > 0) {
    push("## Not run", "", "| candidate | model | reason |", "| --- | --- | --- |");
    for (const a of input.absences)
      push(`| \`${a.candidate_id}\` | \`${a.model}\` | \`${a.reason}\` |`);
    push("");
  }

  push(
    "## Quality-target thresholds (UNCHANGED from scoring v1)",
    "",
    `| target | threshold |`,
    `| --- | --- |`,
    `| first-pass structured output | >= ${pct(QUALITY_TARGETS.firstPassSchemaValidRate)} |`,
    `| final structured output | = ${pct(QUALITY_TARGETS.finalSchemaValidRate)} |`,
    `| disposition macro F1 (strict) | >= ${QUALITY_TARGETS.dispositionMacroF1} |`,
    `| signal micro F1 (strict) | >= ${QUALITY_TARGETS.signalMicroF1} |`,
    `| thread-state accuracy (acceptable-answer) | >= ${QUALITY_TARGETS.threadStateAccuracy} |`,
    `| compensation accuracy (acceptable-answer) | >= ${QUALITY_TARGETS.compensationAccuracy} |`,
    "| critical invariant violations | = 0 |",
    "",
    `Minimum reliable strict class/label support: ${MIN_RELIABLE_CLASS_SUPPORT}. No threshold above is lowered by this correction — only the metric fed into the comparison, and whether the comparison may be hard-evaluated at all, changed.`,
    "",
  );

  return `${lines.join("\n")}\n`;
}
