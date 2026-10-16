import Link from "next/link";

import { CollaborationSuggestions } from "@/components/pipeline/collaboration-suggestions";
import { SourceBadge } from "@/components/ui/badge";
import { DisconnectedEmailState, ErrorState, InsufficientDataState } from "@/components/ui/states";
import { INBOX_COPY, inboxHref, type InboxReady } from "@/lib/inbox/model";

import { DateDecision } from "./date-decision";
import { ThreadDecisions } from "./thread-decisions";

function MailboxBanner({ mailbox }: { mailbox: InboxReady["mailbox"] }) {
  if (mailbox.kind === "connected") {
    return (
      <p className="v12-mail-ok" data-testid="inbox-mailbox">
        Connected email{mailbox.email ? ` · ${mailbox.email}` : ""}
      </p>
    );
  }
  if (mailbox.kind === "reauth") {
    return (
      <DisconnectedEmailState description="Google stopped accepting the stored authorization. Reconnect on Account. Threads already stored stay listed. Nothing is sent." />
    );
  }
  if (mailbox.kind === "consent") {
    return (
      <DisconnectedEmailState description="Google authorized access, and private mailbox processing still needs your permission on Account. Nothing new is read until you allow it." />
    );
  }
  if (mailbox.kind === "error") {
    return (
      <ErrorState
        title="We couldn’t check the mailbox"
        description="Try again. This does not mean the mailbox is empty, and it does not start a sync."
      />
    );
  }
  if (mailbox.kind === "unconfigured") {
    return (
      <DisconnectedEmailState description="Gmail sign-in is not configured on this site. You can still record activity by hand. A manual note is not a verified message." />
    );
  }
  return (
    <DisconnectedEmailState description="Gmail is not connected. You can still record activity by hand. A manual note is not a verified message. Reconnect on Account." />
  );
}

export function InboxScreen({ model }: { model: InboxReady }) {
  const selected = model.selected;
  return (
    <div className="v12-workspace" data-testid="inbox-workspace">
      <header className="v12-pagehead">
        <div>
          <p className="v12-eyebrow">Inbox</p>
          <h1>{model.heading}</h1>
          <p>{model.lede}</p>
        </div>
        <div className="v12-head-actions">
          <Link href="/app/pipeline" className="v12-btn">
            Open Pipeline
          </Link>
        </div>
      </header>

      <MailboxBanner mailbox={model.mailbox} />

      <div className="v12-stats" data-testid="inbox-counts">
        <div className="v12-stat">
          <span>Needs a reply</span>
          <strong>{model.counts.needsReply}</strong>
          <small>Linked conversations</small>
        </div>
        <div className="v12-stat">
          <span>Follow-up checks</span>
          <strong>{model.counts.followUp}</strong>
          <small>Linked conversations</small>
        </div>
        <div className="v12-stat">
          <span>Waiting</span>
          <strong>{model.counts.waiting}</strong>
          <small>Linked conversations</small>
        </div>
        <div className="v12-stat">
          <span>Mailbox</span>
          <strong className="v12-stat-word">
            {model.mailbox.kind === "connected"
              ? "Connected"
              : model.mailbox.kind === "consent"
                ? "Permission"
                : model.mailbox.kind === "reauth"
                  ? "Reconnect"
                  : model.mailbox.kind === "error"
                    ? "Unknown"
                    : "Disconnected"}
          </strong>
          <small>
            {model.mailbox.kind === "connected" ? "Verified via Gmail" : "Not a verified mailbox"}
          </small>
        </div>
      </div>

      {model.notices.map((notice) => (
        <p key={notice} className="v12-notice" role="status">
          {notice}
        </p>
      ))}

      <div className="v12-inbox-grid">
        <section className="v12-panel" aria-label="Your conversations">
          <div className="v12-panel-head">
            <h2>Your conversations</h2>
            <div className="v12-choice">
              <Link
                href={inboxHref("needs_reply", selected?.id)}
                className="v12-chip"
                aria-current={model.filter === "needs_reply" ? "true" : undefined}
              >
                Needs reply
              </Link>
              <Link
                href={inboxHref("all", selected?.id)}
                className="v12-chip"
                aria-current={model.filter === "all" ? "true" : undefined}
              >
                All
              </Link>
            </div>
          </div>
          {model.threads.length === 0 ? (
            <p className="v12-panel-empty">
              {model.mailbox.kind === "connected" || model.mailbox.kind === "reauth"
                ? INBOX_COPY.emptyConnected
                : INBOX_COPY.emptyDisconnected}
            </p>
          ) : (
            <ul className="v12-threads">
              {model.threads.map((thread) => (
                <li key={thread.id}>
                  <Link
                    href={thread.href}
                    className={thread.active ? "v12-thread is-active" : "v12-thread"}
                    aria-current={thread.active ? "true" : undefined}
                  >
                    <span className="v12-thread-top">
                      <strong>{thread.hotelName}</strong>
                      <span>{thread.when}</span>
                    </span>
                    <span className="v12-thread-summary">{thread.summary}</span>
                    <span className="v12-thread-meta">
                      {thread.displayRef ? `${thread.displayRef} · ` : ""}
                      {thread.attentionLabel}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="v12-panel" aria-label="Conversation">
          {selected ? (
            <div className="v12-conversation">
              <div className="v12-panel-head">
                <div>
                  <h2>{selected.hotelName}</h2>
                  <p>
                    {selected.displayRef ? `${selected.displayRef} · ` : ""}
                    {selected.stage}
                  </p>
                </div>
                <SourceBadge source="gmail" />
              </div>
              <p>{selected.summary}</p>
              <p className="v12-body-hidden">{INBOX_COPY.bodyHidden}</p>
              {selected.summary === INBOX_COPY.noClassification ? (
                <InsufficientDataState description="This thread is linked, and no current commercial classification is stored. That is not a decline and not zero." />
              ) : null}
              <ThreadDecisions
                pipelineItemId={selected.pipelineItemId}
                hotelId={selected.hotelId}
                suggestions={selected.suggestions}
              />
              {model.collaborationStatus === "ok" ? (
                <CollaborationSuggestions
                  pipelineItemId={selected.pipelineItemId}
                  hotelId={selected.hotelId}
                  load={{ status: "ok", suggestions: selected.collaborationIds }}
                />
              ) : null}
              <p className="v12-send-gate">{model.sendGate}</p>
              <div className="v12-head-actions">
                {selected.pitchHref ? (
                  <Link href={selected.pitchHref} className="v12-btn v12-btn-primary">
                    Prepare reply in Pitch Studio
                  </Link>
                ) : null}
                {selected.pipelineHref ? (
                  <Link href={selected.pipelineHref} className="v12-btn v12-btn-dark">
                    Open Pipeline
                  </Link>
                ) : null}
              </div>
            </div>
          ) : (
            <p className="v12-panel-empty">{INBOX_COPY.choose}</p>
          )}
        </section>

        <aside className="v12-side" aria-label="Relationship">
          {selected ? (
            <section className="v12-panel v12-panel-pad">
              <h2>The relationship</h2>
              <p>
                <strong>{selected.hotelName}</strong>
              </p>
              <p>Opportunity {selected.displayRef ?? "has no display id"}</p>
              <p>Current stage {selected.stage}</p>
              <p>Next {selected.attentionLabel}</p>
              <SourceBadge source="gmail" />
            </section>
          ) : null}
          <section className="v12-panel v12-panel-pad">
            <h2>{INBOX_COPY.datesTitle}</h2>
            {model.dates.length === 0 ? (
              <p>{INBOX_COPY.datesEmpty}</p>
            ) : (
              <>
                <p>Accept copies the dates onto that one record. Reject leaves them as they are.</p>
                {model.dates.map((date) => (
                  <DateDecision key={date.id} suggestion={date} />
                ))}
              </>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
