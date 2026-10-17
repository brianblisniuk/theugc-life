/**
 * Pipeline — the creator's private opportunities (D182, D187, V2-S3).
 *
 * The list is paginated. Counts are exact database counts. A failed count is
 * not shown as zero. Rows are creator-owned by RLS. Deal cards name the hotel
 * and the opportunity. Unlocked email stays on Hotel Detail.
 */
import Link from "next/link";
import type { Metadata } from "next";

import { V12Icon } from "@/components/icons/v12-icons";
import { DeliverableReminders } from "@/components/collaboration/deliverable-reminders";
import { EmptyState } from "@/components/empty-state";
import { PipelinePagination } from "@/components/pipeline/pipeline-pagination";
import {
  PipelineAttentionList,
  PipelineCommand,
  PipelineDense,
  PipelineViewSwitch,
  attentionFromRows,
} from "@/components/pipeline/pipeline-workspace";
import { requireUser } from "@/lib/auth/guards";
import { loadDeliverableDeadlineBoard } from "@/lib/collaboration/deadline-queries";
import {
  LOCKED_METRIC_COPY,
  METRIC_TITLES,
  ORDER_BELOW_FLOOR_COPY,
  THRESHOLD_RULES,
} from "@/lib/metrics/contract";
import { parseMetricRank } from "@/lib/metrics/order";
import {
  countPipelineStatuses,
  listOpenPipelineForAttention,
  listPipelineItems,
  normalizePageParam,
  type PipelineListItem,
  type PipelinePage,
} from "@/lib/pipeline/queries";
import {
  PIPELINE_COPY,
  normalizePipelineView,
  normalizeStatusFilter,
  pipelineListState,
  pipelinePageHref,
} from "@/lib/pipeline/view";
import {
  normalizePipelineSurface,
  pipelineQueryStatus,
  pipelineSurfaceHeading,
} from "@/lib/shell/navigation";

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const surface = normalizePipelineSurface((await searchParams).surface);
  return { title: pipelineSurfaceHeading(surface).title };
}

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const session = await requireUser("/app/pipeline");
  const asOf = new Date().toISOString();
  const deadlines = await loadDeliverableDeadlineBoard(session.userId, asOf);
  const surface = normalizePipelineSurface(raw.surface);
  const status = pipelineQueryStatus(surface, normalizeStatusFilter(raw.status));
  const rank = parseMetricRank(raw.rank);
  const view = normalizePipelineView(raw.view);
  const requestedPage = normalizePageParam(raw.page);
  const heading = pipelineSurfaceHeading(surface);

  let loaded: PipelinePage | null = null;
  let failed = false;
  let rankHold: "locked" | "not_enough_data" | null = null;
  const [listResult, countsResult, attentionResult] = await Promise.all([
    listPipelineItems(status, requestedPage, undefined, rank).catch(() => ({
      status: "error" as const,
    })),
    countPipelineStatuses().catch(() => ({ status: "error" as const })),
    listOpenPipelineForAttention().catch(() => ({ status: "error" as const })),
  ]);

  if (listResult.status === "ok") loaded = listResult.page;
  else if (listResult.status === "locked") rankHold = "locked";
  else if (listResult.status === "not_enough_data") rankHold = "not_enough_data";
  else failed = true;

  const state = pipelineListState({ failed, page: loaded, status, surface, rank, view });
  const unrankedHref = pipelinePageHref(status, 1, surface, null, view);
  const items: PipelineListItem[] = loaded?.items ?? [];

  const attention = attentionFromRows({
    rows: attentionResult.status === "ok" ? attentionResult.items : [],
    rowsFailed: attentionResult.status !== "ok",
    rowsCapped: attentionResult.status === "ok" ? attentionResult.capped : false,
    deadlines:
      deadlines.kind === "ok"
        ? [...deadlines.reminders].map((item) => ({
            pipelineItemId: item.pipelineItemId,
            hotelId: item.hotelId,
            hotelName: item.hotelName,
            state: item.state,
            dueOn: item.dueOn,
            href: item.href,
          }))
        : [],
    deadlineRead: deadlines.kind === "ok" ? "ok" : "error",
    asOf,
  });

  const counts = countsResult.status === "ok" ? countsResult.counts : null;

  const eyebrow =
    surface === "inbox"
      ? "INBOX / CREATOR WORKSPACE"
      : surface === "collaborations"
        ? "COLLABORATIONS / CREATOR WORKSPACE"
        : "PIPELINE / CREATOR WORKSPACE";

  return (
    <div className="v12-stack">
      <header className="v12-pagehead">
        <div>
          <p className="v12-eyebrow">{eyebrow}</p>
          <h1>{heading.title}</h1>
          <p>
            {surface === "all"
              ? "A global view of your relationships, even when the same hotel appears in multiple commercial initiatives."
              : heading.description}
          </p>
          {surface === "inbox" ? (
            <p>
              Each open cycle can hold one Gmail thread. The reading is a suggestion beside your
              pipeline status. Connecting a mailbox is on <Link href="/app/account">Account</Link>.
              Opening this page does not start a sync.
            </p>
          ) : (
            <p>
              Only you can see this. Counts below are database totals, not the length of this page.
            </p>
          )}
        </div>
        <div className="v12-head-actions">
          <Link href="/app/outreach" className="v12-btn">
            <V12Icon name="arrow" size={15} />
            View Outreach
          </Link>
          <Link href="/app/discover" className="v12-btn v12-btn-primary">
            <V12Icon name="plus" size={15} />
            Find hotels
          </Link>
        </div>
      </header>

      <div className="v12-compact-strip">
        <DeliverableReminders board={deadlines} />
      </div>
      <PipelineCommand counts={counts} />
      <PipelineAttentionList board={attention} />

      {rank ? (
        <p className="max-w-prose text-sm text-muted">
          {METRIC_TITLES[rank]}. One metric, not a score. {THRESHOLD_RULES[rank]}
        </p>
      ) : null}

      {rankHold === "locked" ? (
        <EmptyState title={LOCKED_METRIC_COPY.title} description={LOCKED_METRIC_COPY.description}>
          <Link
            href={unrankedHref}
            className="inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
          >
            Show recent activity
          </Link>
        </EmptyState>
      ) : rankHold === "not_enough_data" ? (
        <EmptyState
          title="Not enough data"
          description={`${ORDER_BELOW_FLOOR_COPY} ${rank ? THRESHOLD_RULES[rank] : ""}`}
        >
          <Link
            href={unrankedHref}
            className="inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
          >
            Show recent activity
          </Link>
        </EmptyState>
      ) : state.kind === "error" ? (
        <EmptyState
          title={state.title}
          description="Something went wrong on our side. Reload the page to try again."
        />
      ) : state.kind === "items" ? (
        <div className="space-y-3">
          <p className="text-sm text-muted" role="status" aria-live="polite">
            {state.summary}
            {state.range ? <span className="ml-2">· {state.range}</span> : null}
            {" · "}
            The board shows this page. A Gmail reading is a suggestion. You confirm the status.
          </p>
          <PipelineViewSwitch view={view} status={status} surface={surface} rank={rank} />
          <PipelineDense items={items} view={view} counts={counts} />
          {state.pagination ? <PipelinePagination state={state.pagination} /> : null}
        </div>
      ) : state.kind === "empty_filtered" ? (
        <EmptyState title={state.title} description="Try a different status, or clear the filter.">
          <Link
            href={pipelinePageHref(null, 1, surface, null, view)}
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
