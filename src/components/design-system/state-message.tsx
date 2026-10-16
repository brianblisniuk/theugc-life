import Link from "next/link";

import { Button } from "@/components/design-system/button";
import { Skeleton } from "@/components/design-system/skeleton";
import { mandatoryState, type MandatoryStateId } from "@/lib/design-system/states";

/**
 * One mandatory state. Retry is a button with no form action, so the guide
 * cannot charge a credit or send a message.
 */
export function StateMessage({ id }: { id: MandatoryStateId }) {
  const state = mandatoryState(id);
  const live = id === "failed" || id === "access-changed" ? "assertive" : "polite";
  return (
    <article className="v12-panel v12-pad v12-state" data-state={id} aria-live={live}>
      <h3>{state.title}</h3>
      {id === "loading" ? <Skeleton label={state.body} /> : <p>{state.body}</p>}
      {state.action?.href ? (
        <p style={{ marginTop: 12 }}>
          <Link className="v12-btn is-primary" href={state.action.href}>
            {state.action.label}
          </Link>
        </p>
      ) : null}
      {state.action && state.action.href === null ? (
        <p style={{ marginTop: 12 }}>
          <Button type="button" tone="secondary">
            {state.action.label}
          </Button>
        </p>
      ) : null}
    </article>
  );
}
