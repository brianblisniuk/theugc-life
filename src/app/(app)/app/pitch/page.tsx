/**
 * Pitch Studio entry (V12.2).
 *
 * The sidebar opens the editor. A pitch is generated only on a real hotel
 * page, after an unlocked opportunity is chosen. This page does not call a
 * model, does not save a draft, and does not send mail.
 */
import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { V12Icon } from "@/components/icons/v12-icons";
import { EmptyState } from "@/components/empty-state";
import { requireUser } from "@/lib/auth/guards";
import { isUuid } from "@/lib/hotels/ids";
import { listOpenPipelineForAttention } from "@/lib/pipeline/queries";
import { nextStep, shownDisplayRef, type DensityRow } from "@/lib/pipeline/density";
import { opportunityPitchHref } from "@/lib/shell/navigation";
import { pipelineStatusLabel } from "@/lib/pipeline/types";

export const metadata: Metadata = { title: "Pitch Studio" };

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function PitchStudioPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser("/app/pitch");
  const raw = await searchParams;
  const requested = first(raw.opportunity);
  const asOf = new Date().toISOString();
  const loaded = await listOpenPipelineForAttention().catch(() => ({ status: "error" as const }));

  if (loaded.status === "ok" && requested && isUuid(requested)) {
    const match = loaded.items.find((item) => item.id === requested && item.hotel?.id);
    const href = match?.hotel?.id
      ? opportunityPitchHref(match.hotel.id, match.id, match.tripId)
      : null;
    if (href) redirect(href);
  }

  const choices =
    loaded.status === "ok"
      ? loaded.items.flatMap((item) => {
          const href = item.hotel?.id
            ? opportunityPitchHref(item.hotel.id, item.id, item.tripId)
            : null;
          if (!href || !item.hotel?.id) return [];
          const row: DensityRow = {
            id: item.id,
            status: item.status,
            displayRef: item.displayRef,
            hotelId: item.hotel.id,
            hotelName: item.hotel.name,
            destinationName: item.hotel.destinationName ?? null,
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
          const ref = shownDisplayRef(item.displayRef);
          return [
            {
              id: item.id,
              href,
              hotelName: item.hotel.name,
              detail: [
                ref ?? "Opportunity",
                pipelineStatusLabel(item.status),
                item.hotel.destinationName,
              ]
                .filter(Boolean)
                .join(" · "),
              step: nextStep(row, asOf).detail,
            },
          ];
        })
      : [];

  const unmatched = Boolean(requested) && loaded.status === "ok";

  return (
    <div className="v12-stack" data-testid="pitch-editor">
      <header className="v12-pagehead">
        <div>
          <p className="v12-eyebrow">PITCH STUDIO / CREATOR WORKSPACE</p>
          <h1>A better pitch starts with context.</h1>
          <p>
            Make a thoughtful proposal without rewriting what the product already knows about your
            hotel, trip, or portfolio.
          </p>
        </div>
        <div className="v12-head-actions">
          <Link href="/app/inbox" className="v12-btn">
            <V12Icon name="inbox" size={15} />
            View Inbox
          </Link>
        </div>
      </header>

      <div className="v12-context">
        <div>
          <strong>Choose a hotel opportunity</strong>
          <p>
            A pitch is generated only from a real unlocked hotel. Nothing on this page is drafted or
            sent.
          </p>
        </div>
        <span className="v12-badge">Not sent</span>
      </div>

      <div className="v12-pitch">
        <aside className="v12-stack">
          <section className="v12-panel v12-panel-pad" aria-label="What we know">
            <p className="v12-eyebrow">WHAT WE KNOW</p>
            <h2>Hotel and opportunity</h2>
            {loaded.status !== "ok" ? (
              <EmptyState
                title="We couldn’t load your opportunities"
                description="Reload the page to try again. This is not an empty studio, and no pitch was generated."
              />
            ) : choices.length === 0 ? (
              <EmptyState
                title="No open opportunity"
                description="Save a hotel from Discover. Opening this editor does not create an opportunity or a draft."
              >
                <Link href="/app/discover" className="v12-btn v12-btn-primary">
                  <V12Icon name="discover" size={15} />
                  Discover hotels
                </Link>
              </EmptyState>
            ) : (
              <ul className="v12-plain-list" data-testid="pitch-opportunity-picker">
                {loaded.capped ? (
                  <li>
                    <p>This list is capped. It is not every open opportunity.</p>
                  </li>
                ) : null}
                {unmatched ? (
                  <li>
                    <p>
                      That opportunity is not open here. Choose one below. A display id is not a
                      link.
                    </p>
                  </li>
                ) : null}
                {choices.map((choice) => (
                  <li key={choice.id}>
                    <Link href={choice.href} className="v12-navtile">
                      <span>
                        <strong>{choice.hotelName}</strong>
                        <p>{choice.detail}</p>
                        <p>{choice.step}</p>
                      </span>
                      <V12Icon name="chevron" size={15} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="v12-panel v12-panel-pad">
            <p className="v12-eyebrow">YOUR CREATIVE DIRECTION</p>
            <h3>Choose the right angle</h3>
            <p>Introduction, stay, follow-up, and return open after you choose the hotel.</p>
          </section>
        </aside>

        <section className="v12-panel v12-panel-pad" aria-label="Email composer">
          <div className="v12-panel-head">
            <div>
              <p className="v12-eyebrow">EMAIL COMPOSER</p>
              <h2>A proposal worth reading</h2>
              <p>Every specific claim should come from your own verified information.</p>
            </div>
          </div>
          <div className="v12-pitch-disabled">
            <label className="v12-field">
              <span>Subject</span>
              <input disabled placeholder="Choose a hotel opportunity first" />
            </label>
            <label className="v12-field">
              <span>Message</span>
              <textarea
                className="min-h-64"
                disabled
                placeholder="A pitch is filled on the hotel page, from a real unlocked hotel."
              />
            </label>
            <div className="v12-head-actions">
              <button type="button" className="v12-btn v12-btn-dark" disabled>
                <V12Icon name="save" size={15} />
                Save draft
              </button>
              <button type="button" className="v12-btn" disabled>
                <V12Icon name="copy" size={15} />
                Copy email
              </button>
            </div>
            <p>Save and copy stay off until a hotel opportunity is open. Neither sends mail.</p>
          </div>
        </section>

        <aside className="v12-stack">
          <section className="v12-panel v12-panel-pad">
            <p className="v12-eyebrow">FINAL REVIEW</p>
            <h2>Check before you send</h2>
            <ul className="v12-checklist">
              <li>Waiting · Hotel named correctly</li>
              <li>Waiting · Offer is understandable</li>
              <li>Waiting · Clear next step</li>
            </ul>
            <p className="v12-callout">
              These checks run after you open a real opportunity. Nothing here is a sample pitch.
            </p>
          </section>
          <section className="v12-panel v12-panel-pad">
            <p className="v12-eyebrow">YOU&rsquo;RE IN CONTROL</p>
            <h3>How this pitch continues</h3>
            <p>
              Templates, saved drafts, and copy stay available on the hotel. AI drafting and Gmail
              send keep their plan and permission gates. A draft is not a send.
            </p>
            <Link href="/app/billing" className="v12-btn v12-btn-small">
              Open Plans
            </Link>
          </section>
        </aside>
      </div>
    </div>
  );
}
