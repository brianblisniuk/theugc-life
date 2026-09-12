/**
 * Deterministic, inspectable metric primitives.
 *
 * Nothing here is weighted or blended. A single headline number is exactly how
 * a benchmark hides a dominant class or a fatal error mode, so the scorer emits
 * the components and the decision method reads them separately.
 */

export interface ClassMetrics {
  support: number;
  predicted: number;
  true_positives: number;
  false_positives: number;
  false_negatives: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface SingleLabelReport {
  n: number;
  correct: number;
  accuracy: number;
  macro_f1: number;
  /** Macro F1 over classes with non-zero gold support only. */
  macro_f1_supported_classes: number;
  per_class: Record<string, ClassMetrics>;
  /** confusion[gold][predicted] = count. */
  confusion: Record<string, Record<string, number>>;
}

export const INVALID_PREDICTION_COLUMN = "(invalid)";

function safeDiv(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function f1From(precision: number, recall: number): number {
  return safeDiv(2 * precision * recall, precision + recall);
}

function emptyMetrics(): ClassMetrics {
  return {
    support: 0,
    predicted: 0,
    true_positives: 0,
    false_positives: 0,
    false_negatives: 0,
    precision: 0,
    recall: 0,
    f1: 0,
  };
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Single-label scoring over a fixed class list.
 *
 * `pairs` carries the EFFECTIVE gold, which is already resolved for
 * acceptable-answer sets by the caller: when a prediction is inside the
 * case's acceptable set, the caller passes it as its own gold so that the
 * confusion matrix is not polluted by an answer the gold set says is fine.
 */
export function scoreSingleLabel(
  classes: readonly string[],
  pairs: readonly { gold: string; predicted: string | null }[],
): SingleLabelReport {
  const columns = [...classes, INVALID_PREDICTION_COLUMN];
  const counts = new Map<string, Map<string, number>>();
  const blankRow = (): Map<string, number> => new Map(columns.map((c) => [c, 0]));
  for (const gold of classes) counts.set(gold, blankRow());

  for (const { gold, predicted } of pairs) {
    const column =
      predicted !== null && classes.includes(predicted) ? predicted : INVALID_PREDICTION_COLUMN;
    let row = counts.get(gold);
    if (!row) {
      row = blankRow();
      counts.set(gold, row);
    }
    row.set(column, (row.get(column) ?? 0) + 1);
  }

  const at = (gold: string, predicted: string): number => counts.get(gold)?.get(predicted) ?? 0;

  const perClass: Record<string, ClassMetrics> = {};
  for (const cls of classes) {
    const tp = at(cls, cls);
    let fn = 0;
    for (const column of columns) if (column !== cls) fn += at(cls, column);
    let fp = 0;
    for (const gold of classes) if (gold !== cls) fp += at(gold, cls);
    const precision = safeDiv(tp, tp + fp);
    const recall = safeDiv(tp, tp + fn);
    perClass[cls] = {
      support: tp + fn,
      predicted: tp + fp,
      true_positives: tp,
      false_positives: fp,
      false_negatives: fn,
      precision: round(precision),
      recall: round(recall),
      f1: round(f1From(precision, recall)),
    };
  }

  const confusion: Record<string, Record<string, number>> = {};
  for (const [gold, row] of counts) {
    confusion[gold] = Object.fromEntries(columns.map((c) => [c, row.get(c) ?? 0]));
  }

  const correct = pairs.filter((p) => p.predicted === p.gold).length;
  const f1Of = (cls: string): number => perClass[cls]?.f1 ?? 0;
  const supportOf = (cls: string): number => perClass[cls]?.support ?? 0;

  return {
    n: pairs.length,
    correct,
    accuracy: round(safeDiv(correct, pairs.length)),
    macro_f1: round(mean(classes.map(f1Of))),
    macro_f1_supported_classes: round(mean(classes.filter((c) => supportOf(c) > 0).map(f1Of))),
    per_class: perClass,
    confusion,
  };
}

export interface MultiLabelReport {
  n: number;
  /** Cases whose predicted SET exactly equals an acceptable gold set. */
  exact_set_matches: number;
  exact_set_accuracy: number;
  /** Cases where gold is the empty set. */
  empty_set_gold: number;
  /** Of those, how many were correctly predicted as empty. */
  empty_set_correct: number;
  micro: { tp: number; fp: number; fn: number; precision: number; recall: number; f1: number };
  macro_f1: number;
  macro_f1_supported_classes: number;
  per_label: Record<string, ClassMetrics>;
  /** Sum of false-positive labels / sum of gold labels. */
  over_prediction_rate: number;
  /** Sum of false-negative labels / sum of gold labels. */
  under_prediction_rate: number;
  /** Cases with no valid output (provider/parse failure). */
  invalid_predictions: number;
}

/**
 * Multi-label scoring for the commercial-signal SET.
 *
 * The empty set is a legitimate gold answer (a reply with no commercial act),
 * so exact-set accuracy counts an empty/empty match as correct. It cannot be
 * gamed the other way: an empty prediction against a non-empty gold produces
 * pure false negatives in the micro/macro figures and shows up in
 * `under_prediction_rate`.
 */
export function scoreMultiLabel(
  labels: readonly string[],
  pairs: readonly { gold: string[]; predicted: string[] | null }[],
): MultiLabelReport {
  const tally = new Map<string, ClassMetrics>();
  for (const label of labels) tally.set(label, emptyMetrics());

  let exact = 0;
  let emptyGold = 0;
  let emptyCorrect = 0;
  let invalid = 0;

  for (const { gold, predicted } of pairs) {
    const goldSet = new Set(gold);
    const predictedSet = new Set(predicted ?? []);
    if (predicted === null) invalid += 1;

    if (goldSet.size === 0) {
      emptyGold += 1;
      if (predicted !== null && predictedSet.size === 0) emptyCorrect += 1;
    }

    if (
      predicted !== null &&
      goldSet.size === predictedSet.size &&
      [...goldSet].every((g) => predictedSet.has(g))
    ) {
      exact += 1;
    }

    for (const label of labels) {
      const metrics = tally.get(label);
      if (!metrics) continue;
      const inGold = goldSet.has(label);
      const inPredicted = predictedSet.has(label);
      if (inGold) metrics.support += 1;
      if (inPredicted) metrics.predicted += 1;
      if (inGold && inPredicted) metrics.true_positives += 1;
      else if (!inGold && inPredicted) metrics.false_positives += 1;
      else if (inGold && !inPredicted) metrics.false_negatives += 1;
    }
  }

  let tp = 0;
  let fp = 0;
  let fn = 0;
  const perLabel: Record<string, ClassMetrics> = {};
  for (const label of labels) {
    const metrics = tally.get(label) ?? emptyMetrics();
    tp += metrics.true_positives;
    fp += metrics.false_positives;
    fn += metrics.false_negatives;
    const precision = safeDiv(
      metrics.true_positives,
      metrics.true_positives + metrics.false_positives,
    );
    const recall = safeDiv(
      metrics.true_positives,
      metrics.true_positives + metrics.false_negatives,
    );
    metrics.precision = round(precision);
    metrics.recall = round(recall);
    metrics.f1 = round(f1From(precision, recall));
    perLabel[label] = metrics;
  }

  const microPrecision = safeDiv(tp, tp + fp);
  const microRecall = safeDiv(tp, tp + fn);
  const f1Of = (label: string): number => perLabel[label]?.f1 ?? 0;
  const supportOf = (label: string): number => perLabel[label]?.support ?? 0;
  const goldLabelCount = tp + fn;

  return {
    n: pairs.length,
    exact_set_matches: exact,
    exact_set_accuracy: round(safeDiv(exact, pairs.length)),
    empty_set_gold: emptyGold,
    empty_set_correct: emptyCorrect,
    micro: {
      tp,
      fp,
      fn,
      precision: round(microPrecision),
      recall: round(microRecall),
      f1: round(f1From(microPrecision, microRecall)),
    },
    macro_f1: round(mean(labels.map(f1Of))),
    macro_f1_supported_classes: round(mean(labels.filter((l) => supportOf(l) > 0).map(f1Of))),
    per_label: perLabel,
    over_prediction_rate: round(safeDiv(fp, goldLabelCount)),
    under_prediction_rate: round(safeDiv(fn, goldLabelCount)),
    invalid_predictions: invalid,
  };
}

export interface LatencySummary {
  n: number;
  median_ms: number | null;
  p95_ms: number | null;
  min_ms: number | null;
  max_ms: number | null;
}

/**
 * Latency over SUCCESSFUL calls only, with `n` stated so a candidate that
 * succeeded on 4 of 60 cases cannot present a flattering median as if it were
 * comparable to one that succeeded on 60.
 */
export function summariseLatency(samples: readonly number[]): LatencySummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (sorted.length === 0 || first === undefined || last === undefined) {
    return { n: 0, median_ms: null, p95_ms: null, min_ms: null, max_ms: null };
  }
  const quantile = (q: number): number => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[index] ?? first;
  };
  return {
    n: sorted.length,
    median_ms: quantile(0.5),
    p95_ms: quantile(0.95),
    min_ms: first,
    max_ms: last,
  };
}
