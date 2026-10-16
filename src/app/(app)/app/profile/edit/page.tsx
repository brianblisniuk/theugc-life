import Link from "next/link";
import type { Metadata } from "next";

import { AudienceFields } from "@/components/profile/audience-fields";
import { ContentExamples } from "@/components/profile/content-examples";
import { PastCollaborations } from "@/components/profile/past-collaborations";
import { PersonalCounts } from "@/components/profile/personal-counts";
import { ProfileEditor } from "@/components/profile/profile-editor";
import { PublicProfileToggle } from "@/components/profile/public-profile-toggle";
import { ShareLinkPanel } from "@/components/profile/share-link-panel";
import { ShareOptIns } from "@/components/profile/share-opt-ins";
import { ErrorState } from "@/components/ui/states";
import { requireUser } from "@/lib/auth/guards";
import {
  getOwnProfile,
  getPastCollaborations,
  getPersonalCounts,
  getProfileVisibility,
} from "@/lib/profile/queries";
import { getShareSettings } from "@/lib/profile/share-queries";
import { PROFILE_LIST_COPY } from "@/lib/surfaces/list-outcome";

export const metadata: Metadata = { title: "Edit profile" };

/**
 * Profile editing is its own screen. The portfolio page stays a display.
 * Gmail connect and account deletion stay on Account.
 */
export default async function EditProfilePage() {
  const session = await requireUser("/app/profile/edit");
  const [profile, counts, past, share, visibility] = await Promise.all([
    getOwnProfile(session.userId),
    getPersonalCounts(),
    getPastCollaborations(null),
    getShareSettings(),
    getProfileVisibility(session.userId),
  ]);

  return (
    <div className="v12-stack">
      <header className="v12-pagehead">
        <div>
          <p className="v12-eyebrow">EDIT PROFILE / CREATOR WORKSPACE</p>
          <h1>Update what hotels can see.</h1>
          <p>Private fields stay private until you opt them into a hotel share link.</p>
        </div>
        <div className="v12-head-actions">
          <Link href="/app/profile" className="v12-btn">
            Back to profile
          </Link>
          <Link href="/app/profile/pitches" className="v12-btn v12-btn-small">
            Pitch templates
          </Link>
        </div>
      </header>

      <section className="v12-panel v12-panel-pad v12-stack">
        {profile.status === "ok" ? (
          <ProfileEditor profile={profile.profile} />
        ) : (
          <ErrorState title="Profile" description={PROFILE_LIST_COPY.error} />
        )}
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
        <PastCollaborations
          load={past}
          heading="Past collaborations"
          linkToHotel
          sharedIds={share.status === "ok" ? new Set(share.sharedCollaborationIds) : undefined}
        />
        <p>
          Past collaborations stay off the hotel link until you mark them. They are not public by
          default.
        </p>
        <PersonalCounts load={counts} />
      </section>
    </div>
  );
}
