import { recordCreatorFitDecisionAction } from "@/lib/pipeline/actions";
import {
  CONFIDENCE_LABELS,
  FIT_EMPTY_COPY,
  FIT_LOCKED_COPY,
  FRESHNESS_LABELS,
  TYPE_LABELS,
  type FitDecisionLoad,
  type FitLoad,
  type PersonalLoad,
  type StrengthLoad,
} from "@/lib/intelligence/contract";

const METRIC_TITLES = {
  response_rate: "Most responsive",
  response_time: "Fastest replying",
  creator_activity: "Most active with creators",
} as const;

function Notice({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-[var(--radius-app)] border border-border bg-surface p-6" role="status">
      <h3 className="text-base font-semibold text-text">{title}</h3>
      <p className="mt-2 max-w-prose text-sm text-muted">{description}</p>
    </div>
  );
}

/**
 * Freshness, the caller's own counts, and creator fit. Metric values stay on
 * the H01 cards. A decision does not change the list.
 */
export function DecisionIntelligence({
  hotelId,
  strength,
  personal,
  fit,
  decision,
}: {
  hotelId: string;
  strength: StrengthLoad;
  personal: PersonalLoad;
  fit: FitLoad;
  decision: FitDecisionLoad;
}) {
  return (
    <div className="space-y-4" data-testid="decision-intelligence">
      <StrengthBlock strength={strength} />
      <PersonalBlock personal={personal} />
      <FitBlock hotelId={hotelId} fit={fit} decision={decision} />
    </div>
  );
}

function StrengthBlock({ strength }: { strength: StrengthLoad }) {
  if (strength.status === "error") {
    return <Notice title="Data strength" description={strength.notice} />;
  }
  return (
    <div className="space-y-3 rounded-[var(--radius-app)] border border-border bg-surface p-6" data-testid="data-strength">
      <h3 className="text-base font-semibold text-text">Data strength</h3>
      <p className="max-w-prose text-sm text-muted">
        Confidence and freshness sit beside each metric. They are not a score. A hidden band is not zero.
      </p>
      <div className="space-y-3">
        {strength.metrics.map((metric) => (
          <div key={metric.metric} className="space-y-1">
            <h4 className="text-sm font-semibold text-text">{METRIC_TITLES[metric.metric]}</h4>
            {metric.state === "locked" ? (
              <p className="text-sm text-muted">Locked</p>
            ) : metric.state === "not_enough_data" ? (
              <p className="text-sm text-muted">Not enough data</p>
            ) : (
              <p className="text-sm text-text">
                {metric.confidenceLevel ? `Confidence: ${CONFIDENCE_LABELS[metric.confidenceLevel]}` : "Confidence withheld"}
                {metric.freshnessBand ? `. Freshness: ${FRESHNESS_LABELS[metric.freshnessBand]}` : ". Freshness withheld"}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PersonalBlock({ personal }: { personal: PersonalLoad }) {
  if (personal.status === "hidden") return null;
  if (personal.status === "error") {
    return <Notice title="Your confirmed events" description={personal.notice} />;
  }
  const { aggregate } = personal;
  const types = aggregate.collaborationTypes.map((type) => TYPE_LABELS[type]).join(", ");
  return (
    <div className="space-y-2 rounded-[var(--radius-app)] border border-border bg-surface p-6" data-testid="personal-aggregate">
      <h3 className="text-base font-semibold text-text">Your confirmed events</h3>
      <p className="text-sm text-text">
        Recorded by you: {aggregate.manualEvents}. From Gmail: {aggregate.gmailEvents}.
      </p>
      {types ? <p className="text-sm text-muted">Types you confirmed: {types}</p> : null}
      {aggregate.manualEvents === 0 && aggregate.gmailEvents === 0 ? (
        <p className="text-sm text-muted">You have no confirmed events at this hotel.</p>
      ) : null}
    </div>
  );
}

function FitBlock({
  hotelId,
  fit,
  decision,
}: {
  hotelId: string;
  fit: FitLoad;
  decision: FitDecisionLoad;
}) {
  if (fit.status === "hidden") return null;
  if (fit.status === "error") return <Notice title="Creator fit" description={fit.notice} />;
  if (fit.status === "locked") {
    return <Notice title={FIT_LOCKED_COPY.title} description={FIT_LOCKED_COPY.description} />;
  }
  const current = fit.hotels.find((hotel) => hotel.hotelId === hotelId);
  const saved = decision.status === "ok" ? decision.decision : null;
  return (
    <div className="space-y-3 rounded-[var(--radius-app)] border border-border bg-surface p-6" data-testid="creator-fit">
      <h3 className="text-base font-semibold text-text">Fit for you</h3>
      <p className="max-w-prose text-sm text-muted">
        A hotel fits when you have confirmed that collaboration type and at least three creators confirmed it there.
        The order is creator activity, then hotel id. No prior is applied.
      </p>
      {fit.hotels.length === 0 ? (
        <p className="max-w-prose text-sm text-muted">{FIT_EMPTY_COPY}</p>
      ) : (
        <ol className="space-y-3">
          {fit.hotels.map((hotel) => (
            <li key={hotel.hotelId} className="text-sm">
              <p className="font-semibold text-text">
                {fit.detailed && hotel.rank ? `${hotel.rank}. ` : ""}
                {hotel.name ?? "Hotel"}
              </p>
              <p className="text-text">
                {hotel.activityLabel}. Matches {TYPE_LABELS[hotel.matchedType]}.
              </p>
              {fit.detailed ? (
                <p className="text-muted">
                  {hotel.confidenceLevel ? `Confidence: ${CONFIDENCE_LABELS[hotel.confidenceLevel]}. ` : "Confidence withheld. "}
                  {hotel.freshnessBand ? `Freshness: ${FRESHNESS_LABELS[hotel.freshnessBand]}.` : "Freshness withheld."}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {current ? (
        <div className="space-y-2 border-t border-border pt-3">
          {saved ? (
            <p className="text-sm text-text" data-testid="fit-decision-stored">
              {saved === "pursue" ? "You chose to pursue this hotel." : "You chose to skip this hotel."}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {saved !== "pursue" ? (
              <form action={recordCreatorFitDecisionAction}>
                <input type="hidden" name="hotelId" value={hotelId} />
                <input type="hidden" name="decision" value="pursue" />
                <button
                  type="submit"
                  className="inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
                >
                  Pursue this hotel
                </button>
              </form>
            ) : null}
            {saved !== "skip" ? (
              <form action={recordCreatorFitDecisionAction}>
                <input type="hidden" name="hotelId" value={hotelId} />
                <input type="hidden" name="decision" value="skip" />
                <button
                  type="submit"
                  className="inline-flex rounded-[var(--radius-app)] border border-border px-4 py-2 text-sm font-semibold text-text"
                >
                  Skip this hotel
                </button>
              </form>
            ) : null}
          </div>
          <p className="text-xs text-muted">This choice stays on your account. It does not change the network.</p>
        </div>
      ) : null}
      {decision.status === "error" ? <p className="text-sm text-muted">{decision.notice}</p> : null}
    </div>
  );
}
