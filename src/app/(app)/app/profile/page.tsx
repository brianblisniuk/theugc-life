import type { Metadata } from "next";

import { AudienceFields } from "@/components/profile/audience-fields";
import { ContentExamples } from "@/components/profile/content-examples";
import { PastCollaborations } from "@/components/profile/past-collaborations";
import { PersonalCounts } from "@/components/profile/personal-counts";
import { ProfileEditor } from "@/components/profile/profile-editor";
import { ShareLinkPanel } from "@/components/profile/share-link-panel";
import { ShareOptIns } from "@/components/profile/share-opt-ins";
import { PageHeader } from "@/components/shell/page-header";
import { requireUser } from "@/lib/auth/guards";
import { getOwnProfile, getPastCollaborations, getPersonalCounts } from "@/lib/profile/queries";
import { getShareSettings } from "@/lib/profile/share-queries";
import { listCrumbs } from "@/lib/shell/navigation";

export const metadata: Metadata = { title: "Profile" };

/**
 * The creator's profile (D081 Profile). Private fields stay private until the
 * creator opts them into the hotel share link (D089–D091, Accepted).
 */
export default async function ProfilePage() {
  const session = await requireUser("/app/profile");
  const [profile, counts, past, share] = await Promise.all([
    getOwnProfile(session.userId),
    getPersonalCounts(),
    getPastCollaborations(null),
    getShareSettings(),
  ]);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Profile"
        crumbs={listCrumbs("Profile")}
        description="Your details stay private until you turn a field on and share a link."
      />

      {profile.status === "ok" ? (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-text">Your details</h2>
          <ProfileEditor profile={profile.profile} />
        </section>
      ) : (
        <p className="max-w-prose text-sm text-muted">
          We couldn’t load your profile. This is not an empty profile.
        </p>
      )}

      {share.status === "ok" ? (
        <>
          <AudienceFields followers={share.followers} engagement={share.engagement} />
          <ShareOptIns optIns={share.optIns} />
          <ShareLinkPanel link={share.link} />
        </>
      ) : (
        <p className="max-w-prose text-sm text-muted">
          Share settings couldn’t be loaded. This is not an empty share link.
        </p>
      )}

      <PersonalCounts load={counts} />
      <PastCollaborations
        load={past}
        heading="Past collaborations"
        linkToHotel
        sharedIds={share.status === "ok" ? new Set(share.sharedCollaborationIds) : undefined}
      />
      {share.status === "ok" ? (
        <ContentExamples deliverables={share.deliverables} sharedIds={share.sharedDeliverableIds} />
      ) : null}
    </div>
  );
}
