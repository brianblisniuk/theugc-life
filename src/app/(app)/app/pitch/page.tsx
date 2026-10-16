/**
 * Pitch Studio index (V2-S3).
 *
 * Lists the caller's open opportunities. It does not call a model and it
 * does not send mail. Each link names the pipeline row id, not the display id.
 */
import Link from "next/link";
import type { Metadata } from "next";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/shell/page-header";
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
    <div className="space-y-6">
      <PageHeader
        title="Pitch Studio"
        crumbs={[{ label: "Home", href: "/app" }, { label: "Pitch Studio" }]}
        description="Open one of your opportunities and review a draft. Generation stays on the hotel pitch page. Nothing on this page is sent."
      />
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
          <Link
            href="/app/discover"
            className="inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
          >
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
              nextFollowupAt: item.nextFollowupAt,
              lastActivityAt: item.lastActivityAt,
              deadlineLabel: null,
              contactEmail: null,
              privateNotes: null,
              metricRank: null,
              metricValue: null,
              metricSample: null,
            };
            const href = item.hotel?.id ? opportunityPitchHref(item.hotel.id, item.id) : null;
            const ref = shownDisplayRef(item.displayRef);
            const step = nextStep(row, asOf);
            return (
              <li key={item.id} className="v12-card px-4 py-3">
                {href ? (
                  <Link href={href} className="font-semibold text-text hover:underline">
                    {item.hotel?.name ?? "Unknown hotel"}
                  </Link>
                ) : (
                  <span className="font-semibold text-text">
                    {item.hotel?.name ?? "Unknown hotel"}
                  </span>
                )}
                <p className="text-sm text-muted">
                  {ref ?? "Opportunity"} · {pipelineStatusLabel(item.status)}
                  {item.hotel?.destinationName ? ` · ${item.hotel.destinationName}` : ""}
                </p>
                <p className="text-sm text-text">{step.detail}</p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
