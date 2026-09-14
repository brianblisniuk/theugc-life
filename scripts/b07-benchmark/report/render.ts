/**
 * Human-readable report rendering.
 *
 * Two rules the renderer enforces:
 *
 *  1. a candidate that was never successfully called is listed as an ABSENCE
 *     (`not_run_missing_key` / `unavailable`), never as benchmark evidence;
 *  2. quality targets and hard gates are shown per candidate, so "least bad"
 *     can never look like "winner".
 */
import { QUALITY_TARGETS, evaluateQualityTargets } from "../scoring/targets";
import type { CandidateScore } from "../scoring/score";
import { MIN_RELIABLE_CLASS_SUPPORT } from "../scoring/metrics";
import { VENDOR_SCREEN, VENDOR_SCREEN_STANDING_CONCLUSION } from "../privacy/vendor-screen";
import type { CorpusStats } from "../corpus/load";
import type { FinalistProvenance } from "../run/types";

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function n(value: number | null, digits = 4): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

function usd(value: number | null): string {
  return value === null ? "n/a" : `$${value.toFixed(6)}`;
}

export interface ReportInput {
  runId: string;
  stage: string;
  generatedAt: string;
  corpus: CorpusStats;
  scores: readonly CandidateScore[];
  /** Candidates that produced no usable evidence, with the honest reason. */
  absences: { candidate_id: string; model: string; reason: string }[];
  /** Auditable Stage-2 finalist selection, when this is a `final` run. */
  finalistProvenance?: FinalistProvenance | null;
}

function classLabel(cls: string, support: number): string {
  return support > 0 && support < MIN_RELIABLE_CLASS_SUPPORT ? `${cls} ⚠ low support` : cls;
}

export function renderReport(input: ReportInput): string {
  const lines: string[] = [];
  const push = (...parts: string[]): void => {
    lines.push(...parts);
  };

  push(
    "# B07 inference benchmark — run report",
    "",
    `Run id: \`${input.runId}\``,
    `Stage: \`${input.stage}\``,
    `Generated: ${input.generatedAt}`,
    "",
    "> This is an EVALUATION artifact. Nothing here is B07 production code, and",
    "> no result here authorizes sending real Gmail-derived data to any provider.",
    "",
    "## 1. Corpus",
    "",
    `- corpus version: \`${input.corpus.corpus_version}\``,
    `- total cases: ${input.corpus.total}`,
    `- split: ${JSON.stringify(input.corpus.by_split)}`,
    `- task: ${JSON.stringify(input.corpus.by_task)}`,
    `- language: ${JSON.stringify(input.corpus.by_language)}`,
    `- critical-invariant suite: ${input.corpus.critical_suite_total} cases ${JSON.stringify(input.corpus.critical_suite_by_split)}`,
    `- few-shot exemplars (excluded from all scored sets): ${input.corpus.few_shot_case_ids.join(", ")}`,
    "",
  );

  push("## 2. Approaches actually run", "");
  if (input.scores.length === 0) {
    push("_No candidate produced any scored result in this run._", "");
  } else {
    push(
      "| candidate | provider | requested model | returned model(s) | attempted | schema-valid | reasoning effort | transport version |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const s of input.scores) {
      push(
        `| \`${s.candidate_id}\` | ${s.provider_id} | \`${s.requested_model}\` | ${
          s.reliability.returned_models.length > 0
            ? s.reliability.returned_models.map((m) => `\`${m}\``).join(", ")
            : "_not reported_"
        } | ${s.reliability.cases_attempted}/${s.reliability.cases_selected} | ${s.reliability.final_schema_valid} | \`${s.inference_config?.reasoning_effort ?? "n/a"}\` | \`${s.inference_config?.structured_output_transport_version ?? "n/a"}\` |`,
      );
    }
    push(
      "",
      `Inference policy version: \`${input.scores[0]?.inference_config?.policy_version ?? "n/a"}\` — every screening/ceiling candidate runs at its provider's stated normal-production reasoning effort (see \`config/inference-config.ts\`); this policy version participates in result identity, so a policy change never silently reuses an old result.`,
    );
    push("");
    const invalidated = input.scores.filter((s) => s.invalidated_reason);
    if (invalidated.length > 0) {
      push("### INVALIDATED — refused to score as one candidate", "");
      for (const s of invalidated) {
        push(`- \`${s.candidate_id}\`: ${s.invalidated_reason}`);
      }
      push("");
    }
  }

  if (input.finalistProvenance) {
    const fp = input.finalistProvenance;
    push(
      "### Stage-2 finalist provenance",
      "",
      `- originating Stage-1 (screening) run: ${fp.screen_run_id ? `\`${fp.screen_run_id}\`` : "_not stated_"}`,
      `- finalists and roles: ${
        Object.entries(fp.candidate_roles)
          .map(([id, role]) => `\`${id}\` (${role})`)
          .join(", ") || "_none_"
      }`,
      `- rationale: ${fp.finalist_reason ?? "_not stated_"}`,
      "",
    );
  }

  if (input.absences.length > 0) {
    push(
      "### Not run — recorded as absence of evidence, NOT as a result",
      "",
      "| candidate | model | reason |",
      "| --- | --- | --- |",
    );
    for (const a of input.absences) {
      push(`| \`${a.candidate_id}\` | \`${a.model}\` | \`${a.reason}\` |`);
    }
    push("");
  }

  push(
    "## 3. Hard gate — critical invariant suite",
    "",
    "Zero violations is required of any finalist.",
    "",
  );
  push(
    "| candidate | critical cases | evaluated | violations | gate |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const s of input.scores) {
    push(
      `| \`${s.candidate_id}\` | ${s.critical_suite.cases} | ${s.critical_suite.cases_evaluated} | ${s.critical_suite.violations} | ${s.critical_suite.passes_hard_gate ? "PASS" : "FAIL"} |`,
    );
  }
  push("");
  for (const s of input.scores) {
    if (s.critical_suite.violations === 0) continue;
    push(`#### \`${s.candidate_id}\` violations by invariant`, "");
    for (const [id, count] of Object.entries(s.critical_suite.violations_by_invariant).sort()) {
      push(`- \`${id}\`: ${count}`);
    }
    push("");
  }

  push("## 4. Semantic metrics", "");
  for (const s of input.scores) {
    push(`### \`${s.candidate_id}\``, "");
    if (s.message_task) {
      const m = s.message_task;
      push(
        `**Task M (message, n=${m.n})**`,
        "",
        `- disposition accuracy: ${pct(m.disposition.accuracy)}`,
        `- disposition macro F1 (all classes): ${n(m.disposition.macro_f1)}`,
        `- disposition macro F1 (supported classes only): ${n(m.disposition.macro_f1_supported_classes)}`,
        `- signal exact-set accuracy: ${pct(m.signals.exact_set_accuracy)} (${m.signals.exact_set_matches}/${m.signals.n})`,
        `- signal micro F1: ${n(m.signals.micro.f1)} · macro F1: ${n(m.signals.macro_f1)}`,
        `- signal over-prediction: ${n(m.signals.over_prediction_rate)} · under-prediction: ${n(m.signals.under_prediction_rate)}`,
        `- empty gold signal sets: ${m.signals.empty_set_gold} (correctly empty: ${m.signals.empty_set_correct})`,
        `- evidence-strength accuracy: ${pct(m.evidence_strength.accuracy)}`,
        "",
        "Disposition per-class:",
        "",
        "| class | support | P | R | F1 |",
        "| --- | --- | --- | --- | --- |",
      );
      for (const [cls, metrics] of Object.entries(m.disposition.per_class)) {
        push(
          `| ${classLabel(cls, metrics.support)} | ${metrics.support} | ${n(metrics.precision, 3)} | ${n(metrics.recall, 3)} | ${n(metrics.f1, 3)} |`,
        );
      }
      push(
        "",
        `_⚠ low support: fewer than ${MIN_RELIABLE_CLASS_SUPPORT} gold cases in this selection — read next to \`support\`, do not over-interpret (spec §14)._`,
        "",
        "Evidence-strength confusion (gold rows x predicted columns):",
        "",
        renderConfusion(m.evidence_strength.confusion),
        "",
      );
    }
    if (s.thread_task) {
      const t = s.thread_task;
      push(
        `**Task T (thread, n=${t.n})**`,
        "",
        `- thread-state accuracy: ${pct(t.thread_state.accuracy)}`,
        `- thread-state macro F1 (all classes): ${n(t.thread_state.macro_f1)}`,
        `- thread-state macro F1 (supported classes only): ${n(t.thread_state.macro_f1_supported_classes)}`,
        `- compensation accuracy: ${pct(t.compensation_structure.accuracy)}`,
        `- **unknown predicted as unpaid: ${t.unknown_predicted_as_unpaid}** (D072 §8 — must be 0)`,
        `- unpaid predicted as unknown: ${t.unpaid_predicted_as_unknown}`,
        `- evidence-strength accuracy: ${pct(t.evidence_strength.accuracy)}`,
        "",
        "Thread-state per-class:",
        "",
        "| class | support | P | R | F1 |",
        "| --- | --- | --- | --- | --- |",
      );
      for (const [cls, metrics] of Object.entries(t.thread_state.per_class)) {
        push(
          `| ${classLabel(cls, metrics.support)} | ${metrics.support} | ${n(metrics.precision, 3)} | ${n(metrics.recall, 3)} | ${n(metrics.f1, 3)} |`,
        );
      }
      push(
        "",
        "Evidence-strength confusion (gold rows x predicted columns):",
        "",
        renderConfusion(t.evidence_strength.confusion),
        "",
      );
    }
  }

  push(
    "## 5. Reliability",
    "",
    "| candidate | first-pass valid | retry rate | final valid | provider errors | timeouts |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const s of input.scores) {
    const r = s.reliability;
    push(
      `| \`${s.candidate_id}\` | ${pct(r.first_pass_schema_valid_rate)} | ${pct(r.retry_rate)} | ${pct(r.final_schema_valid_rate)} | ${r.provider_errors} | ${r.timeouts} |`,
    );
  }
  push("");

  push(
    "## 6. Performance and economics",
    "",
    "Latency covers SUCCESSFUL calls only; `n` and the excluded-call count are shown so a candidate that mostly failed cannot present a flattering median. Token totals and cost include every attempt, retries and failures included.",
    "",
    "**Latency measurement conditions.** Every candidate is run over the same case",
    "set at the same bounded concurrency, and each attempt is timed end to end,",
    "including connection setup. No candidate is warmed before measurement and no",
    "response cache is used, so the first attempt of each candidate carries its own",
    "cold-start cost — comparable across candidates, but not a warm steady-state",
    "figure. Latency here is an ordering signal for the Pareto comparison, not a",
    "production SLO.",
    "",
    "| candidate | latency n | median ms | p95 ms | excluded failed calls | in tok | cached in tok | out tok | reasoning tok (diagnostic) | est. cost | basis |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const s of input.scores) {
    const e = s.economics;
    push(
      `| \`${s.candidate_id}\` | ${s.latency.n} | ${s.latency.median_ms ?? "n/a"} | ${s.latency.p95_ms ?? "n/a"} | ${s.latency_excluded_failed_calls} | ${e.total_input_tokens} | ${e.total_cached_input_tokens} | ${e.total_output_tokens} | ${e.total_reasoning_tokens} | ${usd(e.estimated_total_cost_usd)} | ${e.pricing_basis} |`,
    );
  }
  push(
    "",
    '`unverified` means a price record exists but lacks a verified rate for a token dimension this candidate actually used — the cost is `n/a`, NEVER `$0.00`. `no_pricing_metadata` means no price record exists at all. Neither basis supports a Pareto "cheaper" claim.',
  );
  push("");
  push("Per-1,000 projections (ESTIMATED from published prices — not measured billing):", "");
  push(
    "| candidate | $/1k messages | $/1k threads | price source | accessed |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const s of input.scores) {
    const e = s.economics;
    push(
      `| \`${s.candidate_id}\` | ${usd(e.estimated_cost_per_1k_messages_usd)} | ${usd(e.estimated_cost_per_1k_threads_usd)} | ${e.price_source ?? "n/a"} | ${e.price_accessed_at ?? "n/a"} |`,
    );
  }
  push("");

  push(
    "## 7. Quality targets",
    "",
    "Targets are decision criteria, not a grading curve. A candidate that misses any of them is not a production winner.",
    "",
  );
  push(
    "| target | threshold |",
    "| --- | --- |",
    `| first-pass structured output | >= ${pct(QUALITY_TARGETS.firstPassSchemaValidRate)} |`,
    `| final structured output after bounded retry | = ${pct(QUALITY_TARGETS.finalSchemaValidRate)} |`,
    `| message disposition macro F1 | >= ${QUALITY_TARGETS.dispositionMacroF1} |`,
    `| signal micro F1 | >= ${QUALITY_TARGETS.signalMicroF1} |`,
    `| thread-state accuracy | >= ${QUALITY_TARGETS.threadStateAccuracy} |`,
    `| compensation accuracy | >= ${QUALITY_TARGETS.compensationAccuracy} |`,
    "| critical invariant violations | = 0 |",
    "",
  );
  for (const s of input.scores) {
    const evaluation = evaluateQualityTargets(s);
    push(
      `- \`${s.candidate_id}\`: ${evaluation.meetsAll ? "MEETS ALL TARGETS" : "MISSES TARGETS"}${
        evaluation.misses.length > 0 ? ` — ${evaluation.misses.join("; ")}` : ""
      }`,
    );
  }
  push("");

  push("## 8. Privacy / vendor screen", "");
  for (const note of VENDOR_SCREEN_STANDING_CONCLUSION) push(`> ${note}`);
  push("");
  push(
    "| provider | trains on API data by default | ZDR | synthetic benchmark | private-Gmail candidacy | verification | accessed |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const v of VENDOR_SCREEN) {
    push(
      `| ${v.display_name} | ${v.trains_on_api_data_by_default} | ${v.zero_data_retention_available} | \`${v.synthetic_suitability}\` | \`${v.private_gmail_candidacy}\` | \`${v.verification}\` | ${v.accessed_at} |`,
    );
  }
  push("");

  return `${lines.join("\n")}\n`;
}

function renderConfusion(confusion: Record<string, Record<string, number>>): string {
  const rows = Object.keys(confusion);
  const firstRow = rows[0];
  if (firstRow === undefined) return "_no data_";
  const columns = Object.keys(confusion[firstRow] ?? {});
  const lines = [
    `| gold \\ predicted | ${columns.join(" | ")} |`,
    `| --- | ${columns.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows) {
    const cells = confusion[row] ?? {};
    lines.push(`| ${row} | ${columns.map((c) => cells[c] ?? 0).join(" | ")} |`);
  }
  return lines.join("\n");
}
