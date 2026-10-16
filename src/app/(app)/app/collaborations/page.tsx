import Link from "next/link";
import type { Metadata } from "next";

import { CollaborationBoardView } from "@/components/collaboration/collaboration-board";
import { DeliverableReminders } from "@/components/collaboration/deliverable-reminders";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { requireUser } from "@/lib/auth/guards";
import { AGREED_IS_NOT_APPROVED } from "@/lib/collaboration/board";
import { loadCollaborationBoard } from "@/lib/collaboration/board-queries";
import { loadDeliverableDeadlineBoard } from "@/lib/collaboration/deadline-queries";

export const metadata: Metadata = { title: "Collaborations" };

/**
 * Deliverables and agreed compensation for collaborations the creator recorded.
 * Rows come from the owner read. Nothing here is a sample hotel.
 */
export default async function CollaborationsPage() {
  const session = await requireUser("/app/collaborations");
  const [board, deadlines] = await Promise.all([
    loadCollaborationBoard(session.userId),
    loadDeliverableDeadlineBoard(session.userId, new Date().toISOString()),
  ]);

  return (
    <div className="s6-page">
      <header className="s6-head">
        <div>
          <p className="s6-eyebrow">Collaborations</p>
          <h1>Deliver brilliantly. Get invited back.</h1>
          <p>
            Track deliverables, deadlines, and compensation for deals you already recorded. Barter,
            payment, or both is the compensation you enter. It is not a charge.
          </p>
        </div>
        <ButtonLink href="/app/pipeline">Open Pipeline</ButtonLink>
      </header>

      <p className="s6-callout">{AGREED_IS_NOT_APPROVED}</p>
      <DeliverableReminders board={deadlines} />

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
          <CollaborationBoardView cards={board.cards} />
        </>
      )}
    </div>
  );
}
