/**
 * Pipeline pagination controls (PRD §7.4).
 *
 * Plain links, so paging is server-side, URL-backed, shareable and usable
 * without JavaScript (DESIGN_SYSTEM.md §7). The unavailable direction is
 * rendered as a disabled control rather than removed, so the control row does
 * not jump between pages.
 */
import Link from "next/link";

import type { PipelinePaginationState } from "@/lib/pipeline/view";

const BASE =
  "inline-flex rounded-[var(--radius-app)] border border-border px-3 py-1.5 text-sm font-medium";

export function PipelinePagination({ state }: { state: PipelinePaginationState }) {
  return (
    <nav aria-label="Pipeline pages" className="flex items-center justify-between gap-3">
      {state.previousHref ? (
        <Link href={state.previousHref} rel="prev" className={`${BASE} text-text hover:bg-surface`}>
          Previous
        </Link>
      ) : (
        <span aria-disabled="true" className={`${BASE} cursor-not-allowed text-muted opacity-60`}>
          Previous
        </span>
      )}

      <span className="text-sm text-muted">{state.label}</span>

      {state.nextHref ? (
        <Link href={state.nextHref} rel="next" className={`${BASE} text-text hover:bg-surface`}>
          Next
        </Link>
      ) : (
        <span aria-disabled="true" className={`${BASE} cursor-not-allowed text-muted opacity-60`}>
          Next
        </span>
      )}
    </nav>
  );
}
