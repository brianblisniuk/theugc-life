import {
  NETWORK_BUILDING_COPY,
  NETWORK_ERROR_COPY,
  NETWORK_INSUFFICIENT_COPY,
  PRIORITY_SAVED,
  activityLabel,
  factTypeLabel,
  networkPanelState,
  recencyLabel,
} from "@/lib/network-intelligence/display";
import type { NetworkLoad, OwnFactsLoad, RankLoad } from "@/lib/network-intelligence/contract";
import { recordNetworkPriorityAction } from "@/lib/pipeline/actions";

function Card({ title, description }: { title: string; description: string }) {
  return (
    <div
      className="rounded-[var(--radius-app)] border border-border bg-surface p-6"
      data-testid="network-intelligence"
    >
      <h3 className="text-base font-semibold text-text">{title}</h3>
      <p className="mt-2 max-w-prose text-sm text-muted">{description}</p>
    </div>
  );
}

export function NetworkIntelligencePanel({
  hotelId,
  network,
  rank,
  prioritized,
}: {
  hotelId: string;
  network: NetworkLoad;
  rank: RankLoad;
  prioritized: boolean;
}) {
  const state = networkPanelState(network);
  if (state === "error") {
    return <Card title={NETWORK_ERROR_COPY.title} description={NETWORK_ERROR_COPY.description} />;
  }
  if (state === "building") {
    return (
      <Card title={NETWORK_BUILDING_COPY.title} description={NETWORK_BUILDING_COPY.description} />
    );
  }
  if (state === "insufficient" || network.status !== "ok") {
    return (
      <Card
        title={NETWORK_INSUFFICIENT_COPY.title}
        description={NETWORK_INSUFFICIENT_COPY.description}
      />
    );
  }

  const activity = activityLabel(network.row.activityLevel);
  const recency = recencyLabel(network.row.recencyBand ?? network.row.freshnessBand);

  return (
    <div
      className="space-y-3 rounded-[var(--radius-app)] border border-border bg-surface p-6"
      data-testid="network-intelligence"
    >
      <h3 className="text-base font-semibold text-text">Anonymous network</h3>
      <p className="max-w-prose text-sm text-muted">
        This mixes confirmed facts from several creators. It identifies no one, and it does not
        separate Gmail from what was recorded by hand.
      </p>
      <dl className="space-y-1.5 text-sm">
        {activity ? (
          <div className="flex gap-2">
            <dt className="text-muted">Activity</dt>
            <dd className="text-text">{activity}</dd>
          </div>
        ) : null}
        {recency ? (
          <div className="flex gap-2">
            <dt className="text-muted">Freshness</dt>
            <dd className="text-text">{recency}</dd>
          </div>
        ) : null}
        {network.row.hasObservedCollaboration ? (
          <div className="flex gap-2">
            <dt className="text-muted">Collaboration</dt>
            <dd className="text-text">Collaboration observed</dd>
          </div>
        ) : null}
      </dl>
      {prioritized ? (
        <p className="text-sm text-text" data-testid="network-priority-stored">
          {PRIORITY_SAVED}
        </p>
      ) : (
        <form action={recordNetworkPriorityAction}>
          <input type="hidden" name="hotelId" value={hotelId} />
          <button
            type="submit"
            className="inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
          >
            Prioritize this hotel
          </button>
        </form>
      )}
      {rank.status === "ok" && rank.hotels.length > 0 ? (
        <div className="space-y-1 border-t border-border pt-3">
          <h4 className="text-sm font-semibold text-text">Signal in this destination</h4>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-text">
            {rank.hotels.map((hotel) => (
              <li key={hotel.hotelId}>{hotel.name}</li>
            ))}
          </ol>
          <p className="text-xs text-muted">Reference order, with no score.</p>
        </div>
      ) : null}
    </div>
  );
}

export function PersonalFacts({ load }: { load: OwnFactsLoad }) {
  if (load.status === "hidden") return null;
  if (load.status === "error") {
    return (
      <p className="text-sm text-muted" data-testid="personal-intelligence">
        Your history could not be loaded. That does not mean it is empty.
      </p>
    );
  }
  if (load.facts.manual.length === 0 && load.facts.gmail.length === 0) return null;
  return (
    <div
      className="space-y-2 rounded-[var(--radius-app)] border border-border bg-surface p-6"
      data-testid="personal-intelligence"
    >
      <h3 className="text-base font-semibold text-text">Your history</h3>
      {load.facts.manual.length > 0 ? (
        <div>
          <p className="text-sm font-medium text-text">Manually recorded</p>
          <ul className="mt-1 space-y-1 text-sm text-muted">
            {load.facts.manual.map((fact) => (
              <li key={`manual-${fact.factType}-${fact.eventAt ?? "none"}`}>
                {factTypeLabel(fact.factType)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {load.facts.gmail.length > 0 ? (
        <div>
          <p className="text-sm font-medium text-text">Verified via Gmail</p>
          <ul className="mt-1 space-y-1 text-sm text-muted">
            {load.facts.gmail.map((fact) => (
              <li key={`gmail-${fact.factType}-${fact.eventAt ?? "none"}`}>
                {factTypeLabel(fact.factType)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
