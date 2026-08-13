/**
 * Pipeline status filter (PRD §7.4).
 *
 * A plain GET form so filtering is server-side, URL-backed, and fully usable
 * with the keyboard and without JavaScript (DESIGN_SYSTEM.md §7).
 */
import Link from "next/link";

import { PIPELINE_STATUSES, pipelineStatusLabel } from "@/lib/pipeline/types";

export function PipelineStatusFilter({ status }: { status: string | null }) {
  return (
    <form
      action="/app/pipeline"
      method="get"
      className="flex flex-wrap items-end gap-3 rounded-[var(--radius-app)] border border-border bg-surface p-4"
    >
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

      <button
        type="submit"
        className="rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
      >
        Apply
      </button>

      {status ? (
        <Link href="/app/pipeline" className="text-sm text-muted underline hover:text-text">
          Clear filter
        </Link>
      ) : null}
    </form>
  );
}
