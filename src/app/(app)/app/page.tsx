import Link from "next/link";

import { DismissChecklistButton } from "@/components/onboarding/dismiss-checklist";
import { requireUser } from "@/lib/auth/guards";
import { HOME_NEXT_COPY, recommendationDestination } from "@/lib/home/next-actions";
import { loadHomeNextActions } from "@/lib/home/queries";
import { getPublicCardSignals, searchHotels } from "@/lib/hotels/queries";
import { parseDiscoverQuery } from "@/lib/hotels/filters";
import { greeting, homeView } from "@/lib/onboarding/first-run";
import { loadHomeProgress } from "@/lib/onboarding/queries";
import { getPersonalCounts } from "@/lib/profile/queries";
import { listTrips } from "@/lib/trips/queries";

const primary =
  "inline-flex rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast";
const outline =
  "inline-flex rounded-md border border-border px-4 py-2 text-sm font-semibold text-text";

function daysUntil(start: string): number | null {
  const date = new Date(`${start}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date();
  const utc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((date.getTime() - utc) / 86_400_000);
}

/**
 * Inicio. Direction A layout over the creator's own rows (D095).
 * Counts are creator-recorded. A missing profile is not a zero.
 */
export default async function AppHomePage() {
  const session = await requireUser("/app");
  const [progress, counts, trips, actions] = await Promise.all([
    loadHomeProgress(session.userId),
    getPersonalCounts(),
    listTrips(),
    loadHomeNextActions(session.userId),
  ]);
  const view = homeView(progress.facts);
  const next =
    trips.status === "ok"
      ? (trips.trips
          .filter(
            (trip) => daysUntil(trip.startDate) !== null && (daysUntil(trip.startDate) ?? -1) >= 0,
          )
          .sort((a, b) => a.startDate.localeCompare(b.startDate))[0] ?? null)
      : null;

  const recommendation = recommendationDestination(next?.destinationSlug, progress.destinationSlug);
  let recommended: { id: string; name: string; line: string }[] = [];
  if (recommendation.slug) {
    try {
      const found = await searchHotels(
        parseDiscoverQuery({ destination: recommendation.slug, pageSize: "2" }),
      );
      const signals = await getPublicCardSignals(found.hotels.map((hotel) => hotel.id));
      recommended = found.hotels.slice(0, 2).map((hotel) => {
        const signal = signals?.get(hotel.id) ?? null;
        const line = [hotel.destination?.name, hotel.countryCode, signal?.activity]
          .filter(Boolean)
          .join(" · ");
        return { id: hotel.id, name: hotel.name, line };
      });
    } catch {
      recommended = [];
    }
  }

  const remaining = view.kind === "checklist" ? view.remaining : 0;

  return (
    <div className="space-y-8">
      {next ? (
        <section className="flex h-[220px] items-end overflow-hidden rounded-md bg-[#111918] md:h-[300px]">
          <div className="w-full bg-gradient-to-t from-black/55 to-transparent p-7 text-white">
            <p className="text-xs font-bold uppercase tracking-[0.1em] text-accent">
              Next trip
              {daysUntil(next.startDate) !== null ? ` · in ${daysUntil(next.startDate)} days` : ""}
            </p>
            <h1 className="text-[44px] font-extrabold leading-none tracking-tight text-white md:text-[64px]">
              {next.destinationName}
            </h1>
            <p>
              {next.startDate} – {next.endDate}
              {next.name ? ` · ${next.name}` : ""}
            </p>
          </div>
        </section>
      ) : null}

      <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr]">
        <section>
          <p className="text-xs font-bold uppercase tracking-[0.1em] text-muted">Do this now</p>
          <h2 className="mt-1 text-3xl font-extrabold tracking-tight">
            {view.kind === "blocked" ? view.title : greeting(progress.displayName, remaining)}
          </h2>

          {view.kind === "blocked" ? (
            <p className="mt-4 max-w-prose text-sm text-muted">{view.body}</p>
          ) : null}

          {view.kind === "checklist" ? (
            <>
              <ol className="mt-4">
                {view.steps.map((step, index) => (
                  <li
                    key={step.id}
                    className="flex items-center gap-3.5 border-b border-border py-3.5"
                  >
                    <span
                      className={
                        "grid h-7 w-7 shrink-0 place-items-center rounded-full border-2 border-text text-[13px] font-bold " +
                        (step.done ? "border-accent bg-accent text-accent-contrast" : "")
                      }
                    >
                      {step.done ? "✓" : index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <b className={step.done ? "text-muted line-through" : ""}>
                        {step.optional ? `(Optional) ${step.title}` : step.title}
                      </b>
                      <small className="block text-[13px] text-muted">{step.detail}</small>
                    </div>
                    {step.done ? null : (
                      <Link href={step.href} className={outline}>
                        Start
                      </Link>
                    )}
                  </li>
                ))}
              </ol>
              <DismissChecklistButton />
            </>
          ) : null}

          <div className="mt-8" data-testid="home-next-actions">
            <h3 className="text-xs font-bold uppercase tracking-[0.1em] text-muted">
              Next actions
            </h3>
            {actions.followUpsDue !== null && actions.followUpsDue > 0 ? (
              <p className="mt-2 text-sm font-semibold">
                {HOME_NEXT_COPY.followUpCount(actions.followUpsDue)}
              </p>
            ) : null}
            {actions.notices.map((notice) => (
              <p key={notice.id} className="mt-3 text-sm text-muted">
                {notice.text}
              </p>
            ))}
            {actions.empty ? <p className="mt-3 text-sm text-muted">{actions.empty}</p> : null}
            {actions.actions.length > 0 ? (
              <ol className="mt-2">
                {actions.actions.map((action) => (
                  <li
                    key={action.id}
                    className="grid items-center gap-2 border-b border-border py-3.5 sm:grid-cols-[1fr_auto]"
                  >
                    <div>
                      <b>{action.title}</b>
                      <small className="block text-[13px] text-muted">{action.detail}</small>
                    </div>
                    {action.href ? (
                      <Link href={action.href} className={primary}>
                        {HOME_NEXT_COPY.open}
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : null}
            {actions.hiddenCount > 0 ? (
              <p className="mt-3 text-sm text-muted">
                {HOME_NEXT_COPY.hidden(actions.hiddenCount)}
              </p>
            ) : null}
            {actions.credits ? (
              <p className="mt-4 text-sm" data-testid="home-credits">
                <b>{actions.credits.title}</b>
                <small className="block text-[13px] text-muted">{actions.credits.detail}</small>
              </p>
            ) : null}
          </div>
        </section>

        <aside>
          <p className="text-xs font-bold uppercase tracking-[0.1em] text-muted">
            Your progress (your data only)
          </p>
          {counts.status === "ok" ? (
            <div className="mt-3 grid grid-cols-2 border-t-2 border-border">
              {[
                [counts.counts.outreach, "pitches sent"],
                [counts.counts.replies, "replies"],
                [counts.counts.agreements, "agreements"],
                [counts.counts.completedCollaborations, "collaborations done"],
              ].map(([value, label]) => (
                <div key={String(label)} className="border-b border-border py-4">
                  <strong className="block text-4xl font-extrabold tracking-tight">{value}</strong>
                  <span className="text-[13px] text-muted">{label}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">
              {counts.status === "not_found"
                ? "There is no profile to count. This is not zero."
                : "We could not load your counts. This is not zero."}
            </p>
          )}

          {recommended.length > 0 ? (
            <div className="mt-8">
              <p className="text-xs font-bold uppercase tracking-[0.1em] text-muted">
                {recommendation.source === "trip"
                  ? HOME_NEXT_COPY.catalogTrip
                  : HOME_NEXT_COPY.catalogOnboarding}
              </p>
              <p className="mt-1 text-[13px] text-muted">{HOME_NEXT_COPY.catalogNote}</p>
              {recommended.map((hotel) => (
                <Link key={hotel.id} href={`/app/hotels/${hotel.id}`} className="mt-3 flex gap-3.5">
                  <span
                    className="h-16 w-24 shrink-0 rounded bg-[var(--placeholder)]"
                    aria-hidden="true"
                  />
                  <span>
                    <b>{hotel.name}</b>
                    <small className="block text-[13px] text-muted">{hotel.line}</small>
                  </span>
                </Link>
              ))}
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
