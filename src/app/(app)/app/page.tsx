import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { requireUser } from "@/lib/auth/guards";
import {
  ACTIVATION_COPY,
  ACTIVATION_HREFS,
  currentStepBody,
  homeView,
} from "@/lib/onboarding/activation";
import { loadHomeProgress } from "@/lib/onboarding/queries";
import { WORKSPACES } from "@/lib/shell/navigation";

const ctaClass =
  "inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast";

/**
 * Home. The E02 shell (D081, Accepted) stays: one heading and the existing
 * workspace links. The first useful flow under it is derived (D082, Proposed).
 */
export default async function AppHomePage() {
  const session = await requireUser("/app");
  const progress = await loadHomeProgress(session.userId);
  const name = progress.displayName ?? session.email ?? "creator";
  const view = homeView(progress.facts);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Welcome, ${name}`}
        description="Discover hotels, plan a trip, and keep pipeline, inbox, and collaborations in one place."
      />
      <nav
        aria-label="Workspaces"
        className="-mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:grid md:grid-cols-2 md:overflow-visible md:px-0 lg:grid-cols-3"
      >
        {WORKSPACES.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="flex min-h-11 min-w-[12rem] shrink-0 flex-col justify-center rounded-[var(--radius-app)] border border-border bg-surface px-4 py-3 md:min-w-0"
          >
            <span className="text-sm font-semibold text-text">{item.label}</span>
            <span className="text-xs text-muted">{item.note}</span>
          </Link>
        ))}
      </nav>

      {view.kind === "blocked" ? (
        <EmptyState title={view.title} description={view.body}>
          <Link href="/app" className={ctaClass}>
            Try again
          </Link>
        </EmptyState>
      ) : (
        <>
          <ol aria-label="First steps" className="space-y-2">
            {view.steps.map((step) => (
              <li key={step.id} className="flex items-baseline gap-3 text-sm">
                <span className="w-16 shrink-0 text-xs font-medium text-muted">{step.marker}</span>
                <span className={step.done ? "text-muted" : "font-medium text-text"}>
                  {step.title}
                </span>
              </li>
            ))}
          </ol>

          {view.kind === "next" ? (
            <EmptyState title={view.current.title} description={currentStepBody(view.current.id)}>
              <Link href={view.current.href} className={ctaClass}>
                {view.current.cta}
              </Link>
            </EmptyState>
          ) : (
            <EmptyState title={view.title} description={view.body}>
              <Link href={view.href} className={ctaClass}>
                {view.cta}
              </Link>
            </EmptyState>
          )}

          {view.kind === "next" && view.followUp === "due" ? (
            <EmptyState
              title={ACTIVATION_COPY.noticeDueTitle}
              description={ACTIVATION_COPY.noticeDueBody}
            >
              <Link href={ACTIVATION_HREFS.pipeline} className={ctaClass}>
                {ACTIVATION_COPY.pipelineCta}
              </Link>
            </EmptyState>
          ) : null}

          {view.kind === "next" && view.followUp === "error" ? (
            <EmptyState
              title={ACTIVATION_COPY.noticeErrorTitle}
              description={ACTIVATION_COPY.noticeErrorBody}
            >
              <Link href="/app" className={ctaClass}>
                Try again
              </Link>
            </EmptyState>
          ) : null}
        </>
      )}
    </div>
  );
}
