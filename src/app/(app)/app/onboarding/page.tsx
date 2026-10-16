import Link from "next/link";

import { DestinationQuestion } from "@/components/onboarding/destination-question";
import { ButtonLink } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/states";
import { requireUser } from "@/lib/auth/guards";
import { ONBOARDING_GOALS } from "@/lib/onboarding/goals";
import { homeView } from "@/lib/onboarding/first-run";
import { FIRST_PITCH_STEPS, firstPitchMarks } from "@/lib/onboarding/path";
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

  const marks = firstPitchMarks(
    view.kind === "checklist"
      ? {
          destination: view.steps.find((step) => step.id === "destination")?.done === true,
          saved: view.steps.find((step) => step.id === "hotel")?.done === true,
          pitch: view.steps.find((step) => step.id === "pitch")?.done === true,
        }
      : null,
  );

  return (
    <div className="v12-stack">
      <header className="v12-pagehead">
        <div>
          <p className="v12-eyebrow">GETTING STARTED / CREATOR WORKSPACE</p>
          <h1>Your first opportunity, not a long setup.</h1>
          <p>
            We’ll guide you to one useful action. You can complete the rest of your profile later.
          </p>
        </div>
        <div className="v12-head-actions">
          <ButtonLink href="/app/discover">Skip to Discover</ButtonLink>
        </div>
      </header>

      <div className="v12-layout">
        <section className="v12-panel v12-panel-pad">
          <p className="v12-eyebrow">YOUR FIRST SUCCESS</p>
          <h2>What are you here to do?</h2>
          <p>You don&rsquo;t need a confirmed trip or a large audience to begin.</p>
          <ol className="v12-stepper">
            {marks.map((mark, index) => {
              const step = FIRST_PITCH_STEPS[index];
              const state = mark === "done" ? "Done" : mark === "current" ? "Current" : "Upcoming";
              return (
                <li
                  key={step?.title ?? index}
                  className={
                    mark === "done"
                      ? "v12-step v12-step-done"
                      : mark === "current"
                        ? "v12-step v12-step-current"
                        : "v12-step"
                  }
                  aria-current={mark === "current" ? "step" : undefined}
                >
                  <span className="sr-only">
                    {state}: {step?.title ?? "Step"}
                  </span>
                </li>
              );
            })}
          </ol>
          {view.kind === "blocked" ? (
            <p>
              The stepper is blank because your progress could not be read. That is not zero steps
              done.
            </p>
          ) : null}
          <div className="v12-stack">
            {ONBOARDING_GOALS.map((goal, index) => (
              <Link key={goal.id} href={goal.href} className="v12-navtile">
                <div>
                  <strong>
                    {index + 1}. {goal.title}
                  </strong>
                  <p>{goal.detail}</p>
                </div>
              </Link>
            ))}
          </div>
        </section>
        <aside className="v12-stack">
          <section className="v12-panel v12-panel-pad">
            <p className="v12-eyebrow">YOUR PATH TO A FIRST PITCH</p>
            <h3>Four small steps</h3>
            <div className="v12-timeline">
              {FIRST_PITCH_STEPS.map((step, index) => (
                <div key={step.title} className="v12-event">
                  <strong>
                    {marks[index] === "done"
                      ? "Done · "
                      : marks[index] === "current"
                        ? "Now · "
                        : ""}
                    {step.title}
                  </strong>
                  <p>{step.detail}</p>
                </div>
              ))}
            </div>
          </section>
          <p className="v12-callout">
            <strong>First value before a full profile: </strong>
            you can prepare a pitch with no follower metrics and no travel dates.
          </p>
        </aside>
      </div>

      {view.kind === "blocked" ? <ErrorState title={view.title} description={view.body} /> : null}

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
