import type { Metadata } from "next";

import { PastCollaborations } from "@/components/profile/past-collaborations";
import { PersonalCounts } from "@/components/profile/personal-counts";
import { ProfileEditor } from "@/components/profile/profile-editor";
import { PageHeader } from "@/components/shell/page-header";
import { requireUser } from "@/lib/auth/guards";
import { getOwnProfile, getPastCollaborations, getPersonalCounts } from "@/lib/profile/queries";
import { listCrumbs } from "@/lib/shell/navigation";

export const metadata: Metadata = { title: "Profile" };

/**
 * The creator's private profile (D081 Profile, D086–D088 Proposed).
 * A hotel share link is not on this page. Opt-in rows are not edited here.
 */
export default async function ProfilePage() {
  const session = await requireUser("/app/profile");
  const [profile, counts, past] = await Promise.all([
    getOwnProfile(session.userId),
    getPersonalCounts(),
    getPastCollaborations(null),
  ]);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Profile"
        crumbs={listCrumbs("Profile")}
        description="Only you can see this. Nothing on this page is shared with a hotel."
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

      <PersonalCounts load={counts} />
      <PastCollaborations load={past} heading="Past collaborations" linkToHotel />
    </div>
  );
}
