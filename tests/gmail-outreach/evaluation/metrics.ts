/**
 * B05 SYNTHETIC EVALUATION HARNESS — generic metrics over a labeled corpus.
 *
 * This is explicitly NOT a production gold-label table (D070, contract §20):
 * fixtures and gold labels live only as TypeScript data under
 * `tests/gmail-outreach/`, never as a migration table, and every number this
 * module produces is a synthetic/evaluation-harness metric — never a claim
 * about real-world precision/recall.
 */

export interface LabeledResult<T extends string> {
  readonly id: string;
  readonly gold: T;
  readonly predicted: T;
}

export interface ClassMetrics {
  readonly label: string;
  readonly support: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly precision: number | null;
  readonly recall: number | null;
}

export interface CorpusReport<T extends string> {
  readonly total: number;
  readonly accuracy: number;
  readonly rateByPredictedLabel: Readonly<Record<string, number>>;
  readonly perClass: readonly ClassMetrics[];
  readonly misclassified: readonly LabeledResult<T>[];
}

/** Precision/recall/support per gold label, plus a predicted-label rate breakdown (needs-review rate, insufficient-evidence rate, etc). Never divides by zero — an undefined ratio is `null`, not `NaN`. */
export function evaluateCorpus<T extends string>(
  results: readonly LabeledResult<T>[],
): CorpusReport<T> {
  const labels = new Set<string>();
  for (const r of results) {
    labels.add(r.gold);
    labels.add(r.predicted);
  }

  const perClass: ClassMetrics[] = [...labels].sort().map((label) => {
    const truePositives = results.filter((r) => r.gold === label && r.predicted === label).length;
    const falsePositives = results.filter((r) => r.gold !== label && r.predicted === label).length;
    const falseNegatives = results.filter((r) => r.gold === label && r.predicted !== label).length;
    const support = results.filter((r) => r.gold === label).length;
    const predictedCount = truePositives + falsePositives;
    return {
      label,
      support,
      truePositives,
      falsePositives,
      falseNegatives,
      precision: predictedCount === 0 ? null : truePositives / predictedCount,
      recall: support === 0 ? null : truePositives / support,
    };
  });

  const rateByPredictedLabel: Record<string, number> = {};
  for (const label of labels) {
    rateByPredictedLabel[label] =
      results.length === 0
        ? 0
        : results.filter((r) => r.predicted === label).length / results.length;
  }

  const correct = results.filter((r) => r.gold === r.predicted).length;

  return {
    total: results.length,
    accuracy: results.length === 0 ? 0 : correct / results.length,
    rateByPredictedLabel,
    perClass,
    misclassified: results.filter((r) => r.gold !== r.predicted),
  };
}

/** A compact, human-readable report line for console output — this harness's report IS the deliverable, not a side effect. */
export function formatReport<T extends string>(name: string, report: CorpusReport<T>): string {
  const lines: string[] = [
    `${name}: n=${report.total} accuracy=${(report.accuracy * 100).toFixed(1)}%`,
  ];
  for (const c of report.perClass) {
    const p = c.precision === null ? "n/a" : (c.precision * 100).toFixed(1) + "%";
    const r = c.recall === null ? "n/a" : (c.recall * 100).toFixed(1) + "%";
    lines.push(`  ${c.label}: support=${c.support} precision=${p} recall=${r}`);
  }
  for (const [label, rate] of Object.entries(report.rateByPredictedLabel).sort()) {
    lines.push(`  predicted-rate[${label}]=${(rate * 100).toFixed(1)}%`);
  }
  return lines.join("\n");
}
