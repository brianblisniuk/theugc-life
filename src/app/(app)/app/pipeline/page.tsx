/**
 * Pipeline — the creator's private CRM list (PRD §7.4).
 *
 * The list is paginated server-side: the page states how many relationships the
 * creator actually has (an exact database count) and how many of them are on
 * screen, so a large pipeline is never silently truncated. Rows are
 * creator-owned by RLS (`pipeline_items_all`). An unlocked contact email is
 * read for this caller only and shown on the card (D108).
 */
import Link from "next/link";
import type { Metadata } from "next";

import { DeliverableReminders } from "@/components/collaboration/deliverable-reminders";
import { EmptyState } from "@/components/empty-state";
import { PipelinePagination } from "@/components/pipeline/pipeline-pagination";
import { PipelineBoard } from "@/components/pipeline/pipeline-board";
import { PipelineStatusFilter } from "@/components/pipeline/pipeline-status-filter";
import { PageHeader } from "@/components/shell/page-header";
import { PipelineSurfaceNav } from "@/components/shell/pipeline-surface-nav";
import { PrivateNotesEditor } from "@/components/pipeline/private-notes-editor";
import { requireUser } from "@/lib/auth/guards";
import { DEADLINE_COPY } from "@/lib/collaboration/deadlines";
import { loadDeliverableDeadlineBoard } from "@/lib/collaboration/deadline-queries";
import { readUnlockedContactEmails } from "@/lib/credits/queries";
import {
  LOCKED_METRIC_COPY,
  METRIC_TITLES,
  ORDER_BELOW_FLOOR_COPY,
  THRESHOLD_RULES,
} from "@/lib/metrics/contract";
import { parseMetricRank } from "@/lib/metrics/order";
import {
  listPipelineItems,
  normalizePageParam,
  type PipelineListItem,
  type PipelinePage,
} from "@/lib/pipeline/queries";
import { pipelineStatusLabel } from "@/lib/pipeline/types";
import {
  PIPELINE_COPY,
  normalizeStatusFilter,
  pipelineContactEmail,
  pipelineListState,
  pipelinePageHref,
} from "@/lib/pipeline/view";
import {
  listCrumbs,
  normalizePipelineSurface,
  pipelineQueryStatus,
  pipelineRowLinks,
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

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function Row({
  item,
  surface,
}: {
  item: PipelineListItem;
  surface: ReturnType<typeof normalizePipelineSurface>;
}) {
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
          {item.deadlineLabel ? (
            <span className="font-medium text-text" data-testid="pipeline-deadline">
              {item.deadlineLabel}
            </span>
          ) : null}
          {item.metricValue ? (
            <span className="text-text" data-testid="pipeline-rank">
              {item.metricRank}. {item.metricValue}
              {item.metricSample ? (
                <span className="text-muted"> · {item.metricSample}</span>
              ) : null}
            </span>
          ) : null}
          {item.contactEmail ? (
            <a
              className="text-text underline"
              href={`mailto:${item.contactEmail}`}
              data-testid="pipeline-contact"
            >
              {item.contactEmail}
            </a>
          ) : null}
        </div>
        <PrivateNotesEditor pipelineItemId={item.id} />
      </div>

      <div className="flex flex-wrap gap-2">
        {pipelineRowLinks(
          { status: item.status, hotelId: item.hotel?.id ?? null, hotelName: item.hotel?.name },
          surface,
        ).map((link) => (
          <Link
            key={link.href}
            href={link.href}
            aria-label={link.ariaLabel}
            className="inline-flex min-h-11 items-center rounded-[var(--radius-app)] border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-background"
          >
            {link.label}
          </Link>
        ))}
      </div>
    </li>
  );
}

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const session = await requireUser("/app/pipeline");
  const deadlines = await loadDeliverableDeadlineBoard(session.userId, new Date().toISOString());
  const surface = normalizePipelineSurface(raw.surface);
  const status = pipelineQueryStatus(surface, normalizeStatusFilter(raw.status));
  const rank = parseMetricRank(raw.rank);
  const requestedPage = normalizePageParam(raw.page);
  const heading = pipelineSurfaceHeading(surface);
  const crumbs =
    surface === "inbox"
      ? listCrumbs("Inbox", { href: "/app/pipeline", label: "Pipeline" })
      : surface === "collaborations"
        ? listCrumbs("Collaborations", { href: "/app/pipeline", label: "Pipeline" })
        : listCrumbs("Pipeline");

  let loaded: PipelinePage | null = null;
  let failed = false;
  let rankHold: "locked" | "not_enough_data" | null = null;
  try {
    const result = await listPipelineItems(status, requestedPage, undefined, rank);
    if (result.status === "ok") loaded = result.page;
    else if (result.status === "locked") rankHold = "locked";
    else if (result.status === "not_enough_data") rankHold = "not_enough_data";
    else failed = true;
  } catch {
    failed = true;
  }

  const state = pipelineListState({ failed, page: loaded, status, surface, rank });
  const unrankedHref = pipelinePageHref(status, 1, surface);
  const loadedItems: PipelineListItem[] = loaded?.items ?? [];
  const contactEmails =
    loadedItems.length > 0
      ? await readUnlockedContactEmails(
          loadedItems.flatMap((item) => (item.hotel?.id ? [item.hotel.id] : [])),
        )
      : new Map<string, string>();
  const items: PipelineListItem[] = loadedItems.map((item) => ({
    ...item,
    contactEmail: pipelineContactEmail(item.hotel?.id, contactEmails),
    deadlineLabel:
      deadlines.kind === "ok" && deadlines.indicators[item.id]
        ? DEADLINE_COPY[deadlines.indicators[item.id]!]
        : null,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title={heading.title}
        description={
          surface === "inbox" ? (
            <>
              Each open cycle can hold one Gmail thread. The reading is a suggestion beside your
              pipeline status. Connecting a mailbox is on{" "}
              <Link href="/app/account" className="text-text underline hover:no-underline">
                Account
              </Link>
              . Opening this page does not start a sync.
            </>
          ) : (
            heading.description
          )
        }
        crumbs={crumbs}
      />

      <PipelineSurfaceNav surface={surface} />

      <DeliverableReminders board={deadlines} />

      <PipelineStatusFilter
        status={status}
        surface={surface}
        rank={rank}
        showStatus={surface !== "collaborations"}
      />

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
      ) : state.kind === "items" && surface === "all" && !status && !rank ? (
        <div className="space-y-3">
          <p className="text-sm text-[#555]">
            {state.summary}
            {loaded ? ` · ${loaded.total} ciclos` : ""}
          </p>
          <p className="text-sm text-[#555]">
            Lo que se lee de Gmail es una sugerencia; vos confirmás el estado.
          </p>
          <PipelineBoard items={items} surface={surface} />
          {state.pagination ? <PipelinePagination state={state.pagination} /> : null}
        </div>
      ) : state.kind === "items" ? (
        <div className="space-y-3">
          <p className="text-sm text-muted" role="status" aria-live="polite">
            {state.summary}
            {state.range ? <span className="ml-2">· {state.range}</span> : null}
          </p>
          <ul className="space-y-3">
            {items.map((item) => (
              <Row key={item.id} item={item} surface={surface} />
            ))}
          </ul>
          {state.pagination ? <PipelinePagination state={state.pagination} /> : null}
        </div>
      ) : state.kind === "empty_filtered" ? (
        <EmptyState title={state.title} description="Try a different status, or clear the filter.">
          <Link
            href={surface === "inbox" ? "/app/pipeline?surface=inbox" : "/app/pipeline"}
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
