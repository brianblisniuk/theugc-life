import Link from "next/link";
import type { Metadata } from "next";

import { DeleteAccountPanel } from "@/components/account/delete-account-panel";
import { GmailConnectionPanel } from "@/components/gmail/gmail-connection-panel";
import { AudienceFields } from "@/components/profile/audience-fields";
import { ContentExamples } from "@/components/profile/content-examples";
import { PastCollaborations } from "@/components/profile/past-collaborations";
import { PersonalCounts } from "@/components/profile/personal-counts";
import { ProfileEditor } from "@/components/profile/profile-editor";
import { PublicProfileToggle } from "@/components/profile/public-profile-toggle";
import { ShareLinkPanel } from "@/components/profile/share-link-panel";
import { ShareOptIns } from "@/components/profile/share-opt-ins";
import { ButtonLink } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/states";
import { getOwnAccountDeletion } from "@/lib/account/deletion";
import { requireUser } from "@/lib/auth/guards";
import { listGmailAccounts } from "@/lib/gmail/connection.server";
import { isGmailOAuthConfigured } from "@/lib/gmail/env.server";
import {
  getOwnProfile,
  getPastCollaborations,
  getPersonalCounts,
  getProfileVisibility,
} from "@/lib/profile/queries";
import { getShareSettings } from "@/lib/profile/share-queries";
import { PROFILE_LIST_COPY } from "@/lib/surfaces/list-outcome";

export const metadata: Metadata = { title: "My Profile" };

/**
 * The creator's profile. Private fields stay private until the creator opts
 * them into a hotel share link. Gmail connect and the 30-day deletion clock
 * are the same account actions as Account.
 */
export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireUser("/app/profile");
  const gmailStatus = (await searchParams).gmail;
  const configured = isGmailOAuthConfigured();
  const [profile, counts, past, share, visibility, gmailAccounts, deletion] = await Promise.all([
    getOwnProfile(session.userId),
    getPersonalCounts(),
    getPastCollaborations(null),
    getShareSettings(),
    getProfileVisibility(session.userId),
    configured ? listGmailAccounts(session.userId) : Promise.resolve([]),
    session.role === "creator" ? getOwnAccountDeletion() : Promise.resolve(null),
  ]);

  return (
    <div className="s6-page">
      <header className="s6-head">
        <div>
          <p className="s6-eyebrow">My Profile</p>
          <h1>Your work speaks before your follower count.</h1>
          <p>
            Audience size is optional. A new creator can have a portfolio without invented follower
            counts. Private fields stay off the hotel link until you turn them on.
          </p>
        </div>
        <div className="s6-actions">
          <ButtonLink href="/app/profile/portfolio">Portfolio</ButtonLink>
          <ButtonLink href="/app/profile/pitches" variant="primary">
            Pitch templates
          </ButtonLink>
        </div>
      </header>

      <section className="v12-card v12-card-pad">
        <h2>Your details</h2>
        {profile.status === "ok" ? (
          <ProfileEditor profile={profile.profile} />
        ) : (
          <ErrorState title="Profile" description={PROFILE_LIST_COPY.error} />
        )}
      </section>

      {visibility.status === "ok" ? (
        <PublicProfileToggle enabled={visibility.enabled} username={visibility.username} />
      ) : (
        <ErrorState title="Public profile" description={PROFILE_LIST_COPY.error} />
      )}

      {share.status === "ok" ? (
        <>
          <AudienceFields followers={share.followers} engagement={share.engagement} />
          <ShareOptIns optIns={share.optIns} />
          <ShareLinkPanel link={share.link} />
          <ContentExamples
            deliverables={share.deliverables}
            sharedIds={share.sharedDeliverableIds}
          />
        </>
      ) : (
        <ErrorState title="Hotel share link" description={PROFILE_LIST_COPY.shareError} />
      )}

      <section className="v12-card v12-card-pad">
        <h2>Connected email</h2>
        <p className="s6-muted">
          Gmail is connected for this account only. The same connection is on{" "}
          <Link href="/app/account">Account</Link>.
        </p>
        <GmailConnectionPanel
          accounts={gmailAccounts}
          configured={configured}
          callbackStatus={typeof gmailStatus === "string" ? gmailStatus : null}
          deletionPending={deletion?.status === "scheduled"}
          deletionReadable={deletion == null || deletion.status !== "error"}
        />
      </section>

      <section className="v12-card v12-card-pad">
        <h2>Pitch templates and portfolio</h2>
        <p className="s6-muted">
          Templates you write are only yours. Confirmed collaborations join the portfolio only after
          you approve them. Gmail detections are not included.
        </p>
        <div className="s6-actions">
          <Link href="/app/profile/pitches">Edit templates</Link>
          <Link href="/app/profile/portfolio">Edit portfolio</Link>
        </div>
      </section>

      <PersonalCounts load={counts} />
      <p className="s6-muted">Past collaborations stay on this page. They are not public.</p>
      <PastCollaborations
        load={past}
        heading="Past collaborations"
        linkToHotel
        sharedIds={share.status === "ok" ? new Set(share.sharedCollaborationIds) : undefined}
      />

      {deletion?.status === "error" ? (
        <ErrorState
          title="Deletion status"
          description="We couldn’t load the deletion status. Try again. This is not “no request”."
        />
      ) : null}
      {deletion && deletion.status !== "error" ? (
        <section className="v12-card v12-card-pad">
          <h2>Delete account</h2>
          <p className="s6-muted">
            Personal data is deleted within 30 days of a confirmed request. The same control is on
            Account.
          </p>
          <DeleteAccountPanel
            schedule={
              deletion.status === "scheduled"
                ? {
                    deletionRequestedAt: deletion.deletionRequestedAt,
                    deleteAfter: deletion.deleteAfter,
                  }
                : null
            }
          />
        </section>
      ) : null}
    </div>
  );
}
