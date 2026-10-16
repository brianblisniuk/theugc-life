import Link from "next/link";

import { DestinationQuestion } from "@/components/onboarding/destination-question";
import { ButtonLink } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/states";
import { requireUser } from "@/lib/auth/guards";
import { ONBOARDING_GOALS } from "@/lib/onboarding/goals";
import { homeView } from "@/lib/onboarding/first-run";
import { loadHomeProgress } from "@/lib/onboarding/queries";
import { listDestinations } from "@/lib/trips/queries";

export const metadata = { title: "Getting Started" };

/**
 * First useful step (D095). Goals are links to existing screens. The stored
 * step is still a catalog destination, then a saved hotel.
 */
export default async function OnboardingDestinationPage() {
  const session = await requireUser("/app/onboarding");
  const [catalog, progress] = await Promise.all([
    listDestinations(),
    loadHomeProgress(session.userId),
  ]);
  const view = homeView(progress.facts);

  return (
    <div className="s6-page">
      <header className="s6-head">
        <div>
          <p className="s6-eyebrow">Getting Started</p>
          <h1>Your first opportunity, not a long setup.</h1>
          <p>One useful action is enough. The rest of the profile can wait.</p>
        </div>
        <ButtonLink href="/app/discover">Skip to Discover</ButtonLink>
      </header>

      <div className="s6-goals">
        {ONBOARDING_GOALS.map((goal) => (
          <Link key={goal.id} href={goal.href} className="v12-card v12-card-pad s6-goal">
            <strong>{goal.title}</strong>
            <span>{goal.detail}</span>
          </Link>
        ))}
      </div>

      {view.kind === "blocked" ? (
        <ErrorState title={view.title} description={view.body} />
      ) : view.kind === "checklist" ? (
        <ol className="s6-steps">
          {view.steps.map((step, index) => (
            <li key={step.id}>
              <span>{index + 1}</span>
              <div>
                <strong>{step.title}</strong>
                <p>{step.detail}</p>
                <Link href={step.href}>{step.done ? "Done" : "Continue"}</Link>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="s6-muted">The checklist is hidden. Your saved work is still on Pipeline.</p>
      )}

      <section id="destination" className="v12-card v12-card-pad">
        <h2>Choose a destination</h2>
        {catalog.status !== "ok" ? (
          <ErrorState
            title="Destinations"
            description="We could not load destinations. Reload the page. This is not an empty catalog."
          />
        ) : (
          <DestinationQuestion
            destinations={catalog.destinations.map((destination) => ({
              id: destination.id,
              name: destination.name,
              slug: destination.slug,
              countryCode: null,
            }))}
          />
        )}
      </section>
    </div>
  );
}
