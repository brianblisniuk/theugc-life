/**
 * Pitch Studio index (V2-S3).
 *
 * Lists the caller's open opportunities. It does not call a model and it
 * does not send mail. Each link names the pipeline row id, not the display id.
 */
import Link from "next/link";
import type { Metadata } from "next";

import { EmptyState } from "@/components/empty-state";
import { requireUser } from "@/lib/auth/guards";
import { listOpenPipelineForAttention } from "@/lib/pipeline/queries";
import { nextStep, shownDisplayRef, type DensityRow } from "@/lib/pipeline/density";
import { opportunityPitchHref } from "@/lib/shell/navigation";
import { pipelineStatusLabel } from "@/lib/pipeline/types";

export const metadata: Metadata = { title: "Pitch Studio" };

export default async function PitchStudioPage() {
  await requireUser("/app/pitch");
  const asOf = new Date().toISOString();
  const loaded = await listOpenPipelineForAttention().catch(() => ({ status: "error" as const }));

  return (
    <div className="v12-stack">
      <header className="v12-pagehead">
        <div>
          <p className="v12-eyebrow">PITCH STUDIO / CREATOR WORKSPACE</p>
          <h1>A better pitch starts with context.</h1>
          <p>
            Open one of your opportunities and review a draft. Generation stays on the hotel pitch
            page. Nothing on this page is sent.
          </p>
        </div>
        <div className="v12-head-actions">
          <Link href="/app/inbox" className="v12-btn">
            View Inbox
          </Link>
        </div>
      </header>
      {loaded.status !== "ok" ? (
        <EmptyState
          title="We couldn’t load your opportunities"
          description="Reload the page to try again. This is not an empty studio."
        />
      ) : loaded.items.length === 0 ? (
        <EmptyState
          title="No open opportunity"
          description="Save a hotel from Discover. A pitch draft does not create an opportunity."
        >
          <Link href="/app/discover" className="v12-btn v12-btn-primary">
            Discover hotels
          </Link>
        </EmptyState>
      ) : (
        <ul className="space-y-2">
          {loaded.capped ? (
            <li className="text-sm text-muted">
              This list is capped. It is not every open opportunity.
            </li>
          ) : null}
          {loaded.items.map((item) => {
            const row: DensityRow = {
              id: item.id,
              status: item.status,
              displayRef: item.displayRef,
              hotelId: item.hotel?.id ?? null,
              hotelName: item.hotel?.name ?? "Unknown hotel",
              destinationName: item.hotel?.destinationName ?? null,
              stayStart: item.stayStart,
              stayEnd: item.stayEnd,
              tripName: item.tripName,
              tripId: item.tripId,
              nextFollowupAt: item.nextFollowupAt,
              lastActivityAt: item.lastActivityAt,
              deadlineLabel: null,
              contactEmail: null,
              privateNotes: null,
              metricRank: null,
              metricValue: null,
              metricSample: null,
            };
            const href = item.hotel?.id
              ? opportunityPitchHref(item.hotel.id, item.id, item.tripId)
              : null;
            const ref = shownDisplayRef(item.displayRef);
            const step = nextStep(row, asOf);
            return (
              <li key={item.id}>
                {href ? (
                  <Link href={href} className="v12-navtile">
                    <span>
                      <strong>{item.hotel?.name ?? "Unknown hotel"}</strong>
                      <p>
                        {ref ?? "Opportunity"} · {pipelineStatusLabel(item.status)}
                        {item.hotel?.destinationName ? ` · ${item.hotel.destinationName}` : ""}
                      </p>
                      <p>{step.detail}</p>
                    </span>
                  </Link>
                ) : (
                  <div className="v12-navtile">
                    <span>
                      <strong>{item.hotel?.name ?? "Unknown hotel"}</strong>
                      <p>{step.detail}</p>
                    </span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
