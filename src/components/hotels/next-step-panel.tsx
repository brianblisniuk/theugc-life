import Link from "next/link";

import { AddToTripTrigger } from "@/components/hotels/add-to-trip-dialog";
import { RetryButton } from "@/components/ui/retry-button";

import { SaveHotelButton } from "@/components/pipeline/save-hotel-button";
import { GENERATE_PITCH, UNLOCK_ASSURANCE } from "@/lib/screens/copy";
import { type NextStepModel } from "@/lib/screens/next-step";

function Primary({ model }: { model: NextStepModel }) {
  if (model.primaryDisabled || !model.primaryHref) {
    if (
      model.creditsUnknown ||
      model.kind === "relationship_unknown" ||
      model.kind === "contact_error"
    ) {
      return <RetryButton className="v12-btn v12-btn-primary" label="Retry" />;
    }
    return (
      <button type="button" className="v12-btn" disabled>
        {model.primaryLabel}
      </button>
    );
  }
  return (
    <Link className="v12-btn v12-btn-primary v12-btn-block" href={model.primaryHref}>
      {model.primaryLabel}
    </Link>
  );
}

export function NextStepPanel({
  model,
  hotelId,
  tripNote,
}: {
  model: NextStepModel;
  hotelId: string;
  tripNote: string | null;
}) {
  return (
    <>
      <aside className="s1-panel s1-side" aria-label="Your next step">
        <p className="ux-eyebrow">Your next step</p>
        <h2 className="ux-name">{model.title}</h2>
        <Primary model={model} />
        {model.offerSave ? (
          <SaveHotelButton hotelId={hotelId} idle="Save hotel" pendingLabel="Saving…" />
        ) : null}
        {model.offerAddToTrip ? (
          <AddToTripTrigger className="v12-btn">Add to My Trip</AddToTripTrigger>
        ) : null}
        {model.offerViewPipeline ? (
          <a className="ux-btn" href="#work">
            View pipeline
          </a>
        ) : null}
        {model.stageLabel ? (
          <p>
            <span
              className={
                model.stageTone && model.stageTone !== "neutral"
                  ? `ux-tag ux-tag-${model.stageTone}`
                  : "ux-tag"
              }
            >
              {model.stageLabel}
            </span>
          </p>
        ) : null}
        {model.assurance ? <p className="ux-meta">{model.assurance}</p> : null}
        {model.note ? <p className="ux-meta">{model.note}</p> : null}
        {model.outOfCredits ? <p className="ux-meta">{model.outOfCredits}</p> : null}
        {model.creditsText ? (
          <p>
            <strong>{model.creditsText}</strong>
          </p>
        ) : null}
        {model.creditsUnknown ? (
          <p className="ux-meta">Retry the balance. This is not 0, and it is not an upgrade.</p>
        ) : null}
        {tripNote ? <p className="ux-meta">{tripNote}</p> : null}
      </aside>
      <div className="ux-action">
        <Primary model={model} />
      </div>
    </>
  );
}

export { GENERATE_PITCH, UNLOCK_ASSURANCE };
