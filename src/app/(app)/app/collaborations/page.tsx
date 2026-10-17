import Link from "next/link";
import type { Metadata } from "next";

import { V12Icon } from "@/components/icons/v12-icons";
import { CollaborationBoardView } from "@/components/collaboration/collaboration-board";
import { DeliverableReminders } from "@/components/collaboration/deliverable-reminders";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { requireUser } from "@/lib/auth/guards";
import { AGREED_IS_NOT_APPROVED } from "@/lib/collaboration/board";
import { loadCollaborationBoard, loadOpportunityTimeline } from "@/lib/collaboration/board-queries";
import { loadDeliverableDeadlineBoard } from "@/lib/collaboration/deadline-queries";

export const metadata: Metadata = { title: "Collaborations" };

/**
 * Deliverables and agreed compensation for collaborations the creator recorded.
 * Rows come from the owner read. Nothing here is a sample hotel.
 */
export default async function CollaborationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const selectedId = typeof raw.collaboration === "string" ? raw.collaboration : null;
  const session = await requireUser("/app/collaborations");
  const [board, deadlines] = await Promise.all([
    loadCollaborationBoard(session.userId),
    loadDeliverableDeadlineBoard(session.userId, new Date().toISOString()),
  ]);
  const selectedCard =
    board.kind === "items"
      ? (board.cards.find((card) => card.id === selectedId) ?? board.cards[0] ?? null)
      : null;
  const timeline =
    board.kind === "items"
      ? await loadOpportunityTimeline(session.userId, selectedCard?.pipelineItemId ?? null)
      : { kind: "error" as const };

  return (
    <div className="v12-stack">
      <header className="v12-pagehead">
        <div>
          <p className="v12-eyebrow">COLLABORATIONS / CREATOR WORKSPACE</p>
          <h1>Deliver brilliantly. Get invited back.</h1>
          <p>
            Once a hotel agrees, keep deliverables, dates, and approvals in one place. Barter,
            payment, or both is the compensation you enter. It is not a charge.
          </p>
        </div>
        <div className="v12-head-actions">
          <ButtonLink href="/app/pipeline">
            <V12Icon name="arrow" size={15} />
            Open Pipeline
          </ButtonLink>
        </div>
      </header>

      <div className="v12-compact-strip">
        <p className="v12-callout">{AGREED_IS_NOT_APPROVED}</p>
        <DeliverableReminders board={deadlines} />
      </div>

      {board.kind === "error" ? (
        <ErrorState title={board.title} description={board.body} />
      ) : board.kind === "empty" ? (
        <EmptyState
          title={board.title}
          description={board.body}
          action={
            <Link href={board.cta.href} className="v12-btn v12-btn-primary">
              {board.cta.label}
            </Link>
          }
        />
      ) : (
        <>
          <p role="status">{board.summary}</p>
          {board.capped ? (
            <p className="s6-muted">This list is capped. It is not every deliverable.</p>
          ) : null}
          <CollaborationBoardView cards={board.cards} selectedId={selectedId} timeline={timeline} />
        </>
      )}
    </div>
  );
}
