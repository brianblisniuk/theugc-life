import Link from "next/link";

import { SourceBadge } from "@/components/ui/badge";
import { DisconnectedEmailState, InsufficientDataState } from "@/components/ui/states";
import {
  HOME_DASHBOARD_COPY,
  attentionEmptyCopy,
  outreachFractionLabel,
  outreachProgress,
  type HomeDashboard,
  type OutreachCard,
} from "@/lib/home/dashboard";
import { HOME_NEXT_COPY } from "@/lib/home/next-actions";
import type { InboxMailbox } from "@/lib/inbox/model";

/** Small V12.2 action marks; presentational only, original 15px / 1.7 stroke. */
function ActionArrow() {
  return <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 12h16m-6-6 6 6-6 6" /></svg>;
}
function ActionColumns() {
  return <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="18" rx="1" /><rect x="14" y="3" width="7" height="18" rx="1" /></svg>;
}

function CampaignProgress({ card, openTasks }: { card: OutreachCard; openTasks: number | null }) {
  const progress = outreachProgress(card);
  return (
    <>
      {progress.kind === "empty" ? (
        <p>{HOME_DASHBOARD_COPY.outreachHotelsEmpty}</p>
      ) : (
        <>
          <div className="v12-between">
            <strong>{progress.label}</strong>
            <span>{progress.percentLabel}</span>
          </div>
          <div className="v12-progress" aria-hidden="true">
            <span style={{ width: `${progress.width}%` }} />
          </div>
          <p>{outreachFractionLabel(card)}</p>
          <div className="v12-stats v12-stats-3">
            <div className="v12-stat">
              <span className="v12-stat-label">Shortlist</span>
              <div className="v12-stat-num">{card.hotelCount}</div>
              <div className="v12-stat-note">Hotels</div>
            </div>
            <div className="v12-stat">
              <span className="v12-stat-label">Replies</span>
              <div className="v12-stat-num">{card.replyCount}</div>
              <div className="v12-stat-note">Reported</div>
            </div>
            <div className="v12-stat">
              <span className="v12-stat-label">Open tasks</span>
              <div className="v12-stat-num">{openTasks === null ? "—" : openTasks}</div>
              <div className="v12-stat-note">
                {openTasks === null ? "Could not be read" : "Next steps"}
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function MailLine({ mailbox }: { mailbox: InboxMailbox }) {
  if (mailbox.kind === "connected") {
    return (
      <p className="v12-mail-ok" data-testid="home-mailbox">
        Connected email{mailbox.email ? ` · ${mailbox.email}` : ""}. Verified via Gmail applies only
        to events from that mailbox.
      </p>
    );
  }
  if (mailbox.kind === "consent") {
    return (
      <DisconnectedEmailState description="Private mailbox processing still needs your permission on Account. Home does not read new mail until you allow it." />
    );
  }
  if (mailbox.kind === "reauth") {
    return (
      <DisconnectedEmailState description="Reconnect Gmail on Account. Suggestions already stored stay. This page does not send mail." />
    );
  }
  if (mailbox.kind === "error") {
    return (
      <InsufficientDataState description="We could not check the mailbox. This does not mean it is disconnected, and it is not zero." />
    );
  }
  if (mailbox.kind === "unconfigured") {
    return (
      <DisconnectedEmailState description="Gmail sign-in is not configured on this site. Recorded activity stays manual." />
    );
  }
  return (
    <DisconnectedEmailState description="Gmail is not connected. Next actions from your pipeline still show. A manual record is not a verified message." />
  );
}

export function HomeScreen({
  dashboard,
  mailbox,
  credits,
  continueExplore,
}: {
  dashboard: HomeDashboard;
  mailbox: InboxMailbox;
  credits: { title: string; detail: string } | null;
  continueExplore: { title: string; href: string; detail: string };
}) {
  const trip = dashboard.trip;
  return (
    <div className="v12-workspace" data-testid="home-dashboard">
      <header className="v12-pagehead">
        <div>
          <p className="v12-eyebrow">HOME / CREATOR WORKSPACE</p>
          <h1>{dashboard.heading}</h1>
          <p>A focused start to your day. Open what matters, leave the rest for later.</p>
          <p>Nothing on this page is a sample.</p>
        </div>
        <div className="v12-head-actions">
          <Link href="/app/pipeline" className="v12-btn">
            <ActionColumns /> View all opportunities
          </Link>
        </div>
      </header>

      <MailLine mailbox={mailbox} />

      {dashboard.notices.map((notice) => (
        <p key={notice} className="v12-notice" role="status">
          {notice}
        </p>
      ))}

      <div className="v12-home-grid">
        <section className="v12-panel v12-panel-pad" aria-label="Needs your attention">
          <div className="v12-panel-head">
            <h2>Needs your attention</h2>
            <Link href="/app/pipeline" className="v12-btn v12-btn-ghost v12-btn-small">
              Open your Pipeline <ActionArrow />
            </Link>
          </div>
          {dashboard.tasks.length === 0 ? (
            dashboard.attentionUnavailable ? (
              <InsufficientDataState description={attentionEmptyCopy(true)} />
            ) : (
              <p>{attentionEmptyCopy(false)}</p>
            )
          ) : (
            <ol className="v12-tasks">
              {dashboard.tasks.map((task) => {
                const body = (
                  <>
                    <span className="v12-task-num">{task.index}</span>
                    <span className="v12-task-body">
                      <strong>{task.title}</strong>
                      <span>{task.detail}</span>
                    </span>
                    <SourceBadge source={task.source} />
                    <span className="v12-pill-inline">{task.pill}</span>
                  </>
                );
                return (
                  <li key={task.id}>
                    {task.href ? (
                      <Link href={task.href} className="v12-task">
                        {body}
                      </Link>
                    ) : (
                      <div className="v12-task">{body}</div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {dashboard.hiddenCount > 0 ? (
            <p className="v12-notice">{HOME_NEXT_COPY.hidden(dashboard.hiddenCount)}</p>
          ) : null}
          {credits ? (
            <p data-testid="home-credits">
              <strong>{credits.title}</strong>
              <span className="v12-task-body">{credits.detail}</span>
            </p>
          ) : null}
        </section>

        <section className="v12-panel v12-panel-pad" aria-label="Next trip">
          <p className="v12-eyebrow">Next trip</p>
          {trip.status === "error" ? (
            <InsufficientDataState description={HOME_DASHBOARD_COPY.tripError} />
          ) : trip.status === "none" ? (
            <p>{HOME_DASHBOARD_COPY.noTrip}</p>
          ) : (
            <>
              <h2>{trip.destination}</h2>
              <p>
                {trip.startDate} – {trip.endDate}
                {trip.daysUntil !== null && trip.daysUntil >= 0
                  ? ` · in ${trip.daysUntil} days`
                  : ""}
                {trip.name ? ` · ${trip.name}` : ""}
              </p>
              {trip.coverage.status === "error" ? (
                <InsufficientDataState description={HOME_DASHBOARD_COPY.nightsError} />
              ) : trip.coverage.status === "none" ? (
                <p>{HOME_DASHBOARD_COPY.nightsNone}</p>
              ) : (
                <div data-testid="home-nights">
                  <p>
                    {trip.coverage.coverage.confirmedNights} / {trip.coverage.coverage.tripNights}{" "}
                    nights confirmed
                  </p>
                  <p>{HOME_DASHBOARD_COPY.nightsNote}</p>
                  {trip.coverage.coverage.tripNights === 0 ? (
                    <p>{HOME_DASHBOARD_COPY.sameDay}</p>
                  ) : null}
                  <ul className="v12-night-pills">
                    <li>{trip.coverage.coverage.confirmedNights} confirmed</li>
                    <li>{trip.coverage.coverage.pendingNights} pending</li>
                    <li>{trip.coverage.coverage.gapNights} uncovered</li>
                  </ul>
                </div>
              )}
              <Link href="/app/trips" className="v12-btn v12-btn-primary v12-btn-block">
                <ActionArrow /> Open My Trips
              </Link>
            </>
          )}
        </section>
      </div>

      <div className="v12-stats" data-testid="home-stats">
        {dashboard.stats.map((stat) => (
          <div key={stat.id} className="v12-stat">
            <span>{stat.label}</span>
            {stat.value === null ? (
              <strong className="v12-stat-word">Insufficient data</strong>
            ) : (
              <strong>{stat.value}</strong>
            )}
            <small>{stat.note}</small>
            {stat.source === "insufficient" ? null : <SourceBadge source={stat.source} />}
          </div>
        ))}
      </div>

      <div className="v12-split">
        <section className="v12-panel v12-panel-pad" aria-label="Outreach">
          {dashboard.outreach.status === "error" ? (
            <InsufficientDataState description={HOME_DASHBOARD_COPY.outreachError} />
          ) : dashboard.outreach.status === "empty" ? (
            <>
              <h2>Outreach</h2>
              <p>{HOME_DASHBOARD_COPY.outreachEmpty}</p>
            </>
          ) : (
            <>
              <div className="v12-panel-head">
                <div>
                  <h2>{dashboard.outreach.cards[0]?.name ?? "Outreach"}</h2>
                  <p>Your main active initiative</p>
                </div>
                <span className="v12-badge v12-badge-green">In progress</span>
              </div>
              {dashboard.outreach.cards[0] ? (
                <CampaignProgress
                  card={dashboard.outreach.cards[0]}
                  openTasks={dashboard.campaignOpenTasks}
                />
              ) : null}
              {dashboard.outreach.truncated ? <p>{HOME_DASHBOARD_COPY.outreachTruncated}</p> : null}
              {dashboard.outreach.cards[0] ? (
                <Link
                  href={`/app/outreach/${dashboard.outreach.cards[0].id}`}
                  className="v12-btn v12-btn-dark"
                >
                  Continue outreach <ActionArrow />
                </Link>
              ) : null}
            </>
          )}
        </section>
        <section className="v12-panel v12-panel-pad" aria-label="Continue where you left off">
          <p className="v12-eyebrow">CONTINUE WHERE YOU LEFT OFF</p>
          <h2>{continueExplore.title}</h2>
          <p>{continueExplore.detail}</p>
          <Link href={continueExplore.href} className="v12-btn v12-btn-primary">
            {continueExplore.title} <ActionArrow />
          </Link>
        </section>
      </div>

      <section className="v12-panel v12-panel-pad" aria-label="Intelligence">
        <h2>{dashboard.intelligence.title}</h2>
        <ul className="v12-intel">
          {dashboard.intelligence.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
