/**
 * Pipeline — the creator's private CRM list (PRD §7.4).
 *
 * The list is paginated server-side: the page states how many relationships the
 * creator actually has (an exact database count) and how many of them are on
 * screen, so a large pipeline is never silently truncated. Rows are
 * creator-owned by RLS (`pipeline_items_all`), and contacts are deliberately
 * never queried here.
 */
import Link from "next/link";
import type { Metadata } from "next";

import { EmptyState } from "@/components/empty-state";
import { PipelinePagination } from "@/components/pipeline/pipeline-pagination";
import { PipelineStatusFilter } from "@/components/pipeline/pipeline-status-filter";
import {
  listPipelineItems,
  normalizePageParam,
  type PipelineListItem,
  type PipelinePage,
} from "@/lib/pipeline/queries";
import { pipelineStatusLabel } from "@/lib/pipeline/types";
import { PIPELINE_COPY, normalizeStatusFilter, pipelineListState } from "@/lib/pipeline/view";

export const metadata: Metadata = { title: "Pipeline" };

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function Row({ item }: { item: PipelineListItem }) {
  const location = [item.hotel?.destinationName, item.hotel?.countryCode]
    .filter(Boolean)
    .join(" · ");
  const saved = formatDate(item.savedAt);
  const followUp = formatDate(item.nextFollowupAt);

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 rounded-[var(--radius-app)] border border-border bg-surface p-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold text-text">{item.hotel?.name ?? "Unknown hotel"}</h3>
        {location ? <p className="text-sm text-muted">{location}</p> : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span className="rounded-[var(--radius-app)] border border-border px-2 py-0.5 font-medium text-text">
            {pipelineStatusLabel(item.status)}
          </span>
          {saved ? <span>Saved {saved}</span> : null}
          {followUp ? <span>Follow-up due {followUp}</span> : null}
        </div>
      </div>

      {item.hotel ? (
        <Link
          href={`/app/hotels/${item.hotel.id}`}
          aria-label={`Manage ${item.hotel.name}`}
          className="inline-flex rounded-[var(--radius-app)] border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-background"
        >
          Manage
        </Link>
      ) : null}
    </li>
  );
}

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const status = normalizeStatusFilter(raw.status);
  const requestedPage = normalizePageParam(raw.page);

  let loaded: PipelinePage | null = null;
  let failed = false;
  try {
    const result = await listPipelineItems(status, requestedPage);
    if (result.status === "ok") loaded = result.page;
    else failed = true;
  } catch {
    failed = true;
  }

  const state = pipelineListState({ failed, page: loaded, status });
  const items: PipelineListItem[] = loaded?.items ?? [];

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-text">Pipeline</h1>
        <p className="max-w-prose text-sm text-muted">
          Every hotel you are tracking, most recent activity first. Only you can see this.
        </p>
      </header>

      <PipelineStatusFilter status={status} />

      {state.kind === "error" ? (
        <EmptyState
          title={state.title}
          description="Something went wrong on our side. Reload the page to try again."
        />
      ) : state.kind === "items" ? (
        <div className="space-y-3">
          <p className="text-sm text-muted" role="status" aria-live="polite">
            {state.summary}
            {state.range ? <span className="ml-2">· {state.range}</span> : null}
          </p>
          <ul className="space-y-3">
            {items.map((item) => (
              <Row key={item.id} item={item} />
            ))}
          </ul>
          {state.pagination ? <PipelinePagination state={state.pagination} /> : null}
        </div>
      ) : state.kind === "empty_filtered" ? (
        <EmptyState title={state.title} description="Try a different status, or clear the filter.">
          <Link
            href="/app/pipeline"
            className="inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
          >
            Clear filter
          </Link>
        </EmptyState>
      ) : (
        <EmptyState title={PIPELINE_COPY.emptyTitle} description={PIPELINE_COPY.emptyBody}>
          <Link
            href="/app/discover"
            className="inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
          >
            {PIPELINE_COPY.emptyCta}
          </Link>
        </EmptyState>
      )}
    </div>
  );
}
