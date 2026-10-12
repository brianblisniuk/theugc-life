import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { requireUser } from "@/lib/auth/guards";
import {
  ACTIVATION_COPY,
  ACTIVATION_HREFS,
  currentStepBody,
  homeView,
} from "@/lib/onboarding/activation";
import { loadHomeProgress } from "@/lib/onboarding/queries";

const ctaClass =
  "inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast";

/** Home. The first useful flow is derived from rows the creator already owns (D082). */
export default async function AppHomePage() {
  const session = await requireUser("/app");
  const progress = await loadHomeProgress(session.userId);
  const name = progress.displayName ?? session.email ?? "creator";
  const view = homeView(progress.facts);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-text">Welcome, {name}</h1>
        <p className="max-w-prose text-sm text-muted">
          Connect Gmail, plan a trip, save a hotel, then continue in your pipeline.
        </p>
      </header>

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
