/**
 * Pipeline status filter (PRD §7.4).
 *
 * A plain GET form so filtering is server-side, URL-backed, and fully usable
 * with the keyboard and without JavaScript (DESIGN_SYSTEM.md §7).
 */
import Link from "next/link";

import { METRIC_IDS, METRIC_TITLES, type MetricId } from "@/lib/metrics/contract";
import { pipelinePageHref, type PipelineSurface } from "@/lib/pipeline/view";
import { PIPELINE_STATUSES, pipelineStatusLabel } from "@/lib/pipeline/types";

export function PipelineStatusFilter({
  status,
  surface = "all",
  rank = null,
  showStatus = true,
}: {
  status: string | null;
  surface?: PipelineSurface;
  rank?: MetricId | null;
  showStatus?: boolean;
}) {
  const clearHref = pipelinePageHref(null, 1, surface);
  return (
    <form
      action="/app/pipeline"
      method="get"
      className="flex flex-wrap items-end gap-3 rounded-[var(--radius-app)] border border-border bg-surface p-4"
    >
      {surface === "inbox" || surface === "collaborations" ? (
        <input type="hidden" name="surface" value={surface} />
      ) : null}
      {showStatus ? (
        <div className="space-y-1">
          <label className="block text-xs font-medium text-muted" htmlFor="pipeline-status">
            Status
          </label>
          <select
            id="pipeline-status"
            name="status"
            defaultValue={status ?? ""}
            className="rounded-[var(--radius-app)] border border-border bg-background px-3 py-2 text-sm text-text"
          >
            <option value="">All statuses</option>
            {PIPELINE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {pipelineStatusLabel(s)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="space-y-1">
        <label className="block text-xs font-medium text-muted" htmlFor="pipeline-rank">
          Order
        </label>
        <select
          id="pipeline-rank"
          name="rank"
          defaultValue={rank ?? ""}
          className="rounded-[var(--radius-app)] border border-border bg-background px-3 py-2 text-sm text-text"
        >
          <option value="">Recent activity</option>
          {METRIC_IDS.map((metric) => (
            <option key={metric} value={metric}>
              {METRIC_TITLES[metric]}
            </option>
          ))}
        </select>
      </div>

      <button
        type="submit"
        className="rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
      >
        Apply
      </button>

      {status || rank ? (
        <Link href={clearHref} className="text-sm text-muted underline hover:text-text">
          Clear filter
        </Link>
      ) : null}
    </form>
  );
}
