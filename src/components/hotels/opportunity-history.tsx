import { ButtonLink } from "@/components/ui/button";
import type { OpportunityCardModel } from "@/lib/screens/hotel-opportunities";

const TONE = {
  green: "v12-badge v12-badge-green",
  blue: "v12-badge v12-badge-blue",
  amber: "v12-badge v12-badge-amber",
  gray: "v12-badge v12-badge-gray",
} as const;

export function OpportunityHistory({
  cards,
  failed,
}: {
  cards: readonly OpportunityCardModel[];
  failed: boolean;
}) {
  if (failed) {
    return (
      <div className="v12-state v12-state-danger" role="alert">
        <h3>Opportunities couldn’t be loaded</h3>
        <p>Retry. This is not an empty history.</p>
        <a className="v12-btn" href="">
          Retry
        </a>
      </div>
    );
  }
  if (cards.length === 0) {
    return (
      <p className="s1-muted" role="status">
        You have no opportunities with this hotel yet. Saving it starts one. It does not invent a
        second.
      </p>
    );
  }
  return (
    <div>
      {cards.map((card) => (
        <article className="s1-opp" key={card.id} data-opportunity={card.id}>
          <div className="s1-between">
            <strong>{card.title}</strong>
            <span className={TONE[card.tone]}>{card.stage}</span>
          </div>
          <p>{card.body}</p>
          <div style={{ marginTop: 9 }}>
            <ButtonLink href={card.href} size="small">
              {card.action}
            </ButtonLink>
          </div>
        </article>
      ))}
    </div>
  );
}
