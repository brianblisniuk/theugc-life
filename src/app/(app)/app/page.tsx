import Link from "next/link";

import { HomeScreen } from "@/components/home/home-screen";
import { DismissChecklistButton } from "@/components/onboarding/dismiss-checklist";
import { requireUser } from "@/lib/auth/guards";
import { buildHomeDashboard, upcomingTrip } from "@/lib/home/dashboard";
import { loadHomeNextActions } from "@/lib/home/queries";
import { loadHomeSignals } from "@/lib/home/signals";
import { getPublicCardSignals, searchHotels } from "@/lib/hotels/queries";
import { buildDiscoverHref, parseDiscoverQuery } from "@/lib/hotels/filters";
import { HOME_NEXT_COPY, recommendationDestination } from "@/lib/home/next-actions";
import { greeting, homeView } from "@/lib/onboarding/first-run";
import { loadHomeProgress } from "@/lib/onboarding/queries";
import { getPersonalCounts } from "@/lib/profile/queries";
import { readOwnTimeZone } from "@/lib/time/zone.server";
import { listTrips } from "@/lib/trips/queries";

const outline =
  "inline-flex rounded-md border border-border px-4 py-2 text-sm font-semibold text-text";

/**
 * Home (V2-S4). Next actions, trip nights, and recorded counts. Figures that
 * were not read stay insufficient. This page does not send mail.
 */
export default async function AppHomePage() {
  const session = await requireUser("/app");
  const asOf = new Date().toISOString();
  const [progress, counts, trips, actions, timeZone] = await Promise.all([
    loadHomeProgress(session.userId),
    getPersonalCounts(),
    listTrips(),
    loadHomeNextActions(session.userId),
    readOwnTimeZone(session.userId),
  ]);
  const view = homeView(progress.facts);
  const next = trips.status === "ok" ? upcomingTrip(trips.trips, asOf, timeZone) : null;
  const signals = await loadHomeSignals(session.userId, next?.id ?? null);

  const recommendation = recommendationDestination(next?.destinationSlug, progress.destinationSlug);
  let recommended: { id: string; name: string; line: string }[] = [];
  if (recommendation.slug) {
    try {
      const found = await searchHotels(
        parseDiscoverQuery({ destination: recommendation.slug, pageSize: "2" }),
      );
      const cardSignals = await getPublicCardSignals(found.hotels.map((hotel) => hotel.id));
      recommended = found.hotels.slice(0, 2).map((hotel) => {
        const signal = cardSignals?.get(hotel.id) ?? null;
        const line = [hotel.destination?.name, hotel.countryCode, signal?.activity]
          .filter(Boolean)
          .join(" · ");
        return { id: hotel.id, name: hotel.name, line };
      });
    } catch {
      recommended = [];
    }
  }

  const dashboard = buildHomeDashboard({
    actions,
    counts,
    trips,
    coverage: next ? signals.coverage : { status: "none" },
    outreach: signals.outreach,
    asOf,
    timeZone,
    gmail: signals.gmail,
    campaignHotelIds: signals.campaignHotelIds,
  });

  const remaining = view.kind === "checklist" ? view.remaining : 0;

  return (
    <div className="space-y-8">
      {view.kind === "blocked" ? <p className="text-sm text-muted">{view.body}</p> : null}
      {view.kind === "checklist" ? (
        <section>
          <h2 className="text-xl font-semibold">{greeting(progress.displayName, remaining)}</h2>
          <ol className="mt-4">
            {view.steps.map((step, index) => (
              <li key={step.id} className="flex items-center gap-3.5 border-b border-border py-3.5">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border-2 border-text text-[13px] font-bold">
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
        </section>
      ) : null}

      <HomeScreen
        dashboard={dashboard}
        mailbox={signals.mailbox}
        credits={
          actions.credits ? { title: actions.credits.title, detail: actions.credits.detail } : null
        }
        continueExplore={
          recommendation.slug
            ? {
                title: `Continue exploring ${next?.destinationName ?? "hotels"}`,
                href: buildDiscoverHref({ destination: recommendation.slug }),
                detail:
                  "Return to that destination. This is the destination already on your trip or onboarding, not a sample city.",
              }
            : {
                title: "Explore hotels",
                href: "/app/discover",
                detail:
                  "No destination is stored yet. Discover opens the catalog you can actually search.",
              }
        }
      />

      {recommended.length > 0 ? (
        <section className="v12-panel v12-panel-pad">
          <h2>Continue where you left off</h2>
          <p>
            {recommendation.source === "trip"
              ? HOME_NEXT_COPY.catalogTrip
              : HOME_NEXT_COPY.catalogOnboarding}
          </p>
          <p>{HOME_NEXT_COPY.catalogNote}</p>
          <ul>
            {recommended.map((hotel) => (
              <li key={hotel.id}>
                <Link href={`/app/hotels/${hotel.id}`}>
                  <strong>{hotel.name}</strong>
                  <span>{hotel.line}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
