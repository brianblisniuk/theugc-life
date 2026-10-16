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
import { ButtonLink } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/states";
import { requireUser } from "@/lib/auth/guards";
import { initialsFromName } from "@/lib/screens/initials";
import {
  getOwnProfile,
  getPastCollaborations,
  getPersonalCounts,
  getProfileVisibility,
} from "@/lib/profile/queries";
import { profileReadiness } from "@/lib/profile/readiness";
import { getShareSettings } from "@/lib/profile/share-queries";
import { PROFILE_LIST_COPY } from "@/lib/surfaces/list-outcome";

export const metadata: Metadata = { title: "My Profile" };

/**
 * The creator's profile. Private fields stay private until the creator opts
 * them into a hotel share link. Gmail connect and the 30-day deletion clock
 * are the same account actions as Account.
 */
export default async function ProfilePage() {
  const session = await requireUser("/app/profile");
  const [profile, counts, past, share, visibility] = await Promise.all([
    getOwnProfile(session.userId),
    getPersonalCounts(),
    getPastCollaborations(null),
    getShareSettings(),
    getProfileVisibility(session.userId),
  ]);

  const selectedCount =
    (past.status === "ok" ? past.items.length : 0) +
    (share.status === "ok" ? share.deliverables.length : 0);
  const readiness =
    profile.status === "ok"
      ? profileReadiness({
          bio: profile.profile.bio,
          formats: profile.profile.contentFormats,
          languages: profile.profile.languages,
          selectedCount: past.status === "ok" && share.status === "ok" ? selectedCount : 0,
          shareLinkUsable: share.status === "ok" && share.link?.usable === true,
        })
      : null;
  const pieceReadsFailed = past.status !== "ok" || share.status !== "ok";

  return (
    <div className="v12-stack">
      <header className="v12-pagehead">
        <div>
          <p className="v12-eyebrow">MY PROFILE / CREATOR WORKSPACE</p>
          <h1>Your work speaks before your follower count.</h1>
          <p>
            A hotel-facing portfolio that makes quality, experience and creative fit easy to
            understand.
          </p>
        </div>
        <div className="v12-head-actions">
          <ButtonLink href="/app/profile/pitches">Pitch templates</ButtonLink>
          <ButtonLink href="/app/pitch" variant="primary">
            Open Pitch Studio
          </ButtonLink>
        </div>
      </header>

      <div className="v12-layout">
        <div className="v12-stack">
          <section className="v12-panel v12-panel-pad">
            <div className="v12-panel-head">
              <div>
                <p className="v12-eyebrow">YOUR CREATOR IDENTITY</p>
                <h2>Make a strong introduction.</h2>
              </div>
              {readiness ? (
                <span className={readiness.ready ? "v12-badge v12-badge-green" : "v12-badge"}>
                  {readiness.ready ? "Ready to share" : "Not ready to share"}
                </span>
              ) : null}
            </div>
            {profile.status === "ok" ? (
              <>
                <div className="v12-row">
                  <span className="v12-mark">
                    {initialsFromName(profile.profile.displayName || "Creator")}
                  </span>
                  <div>
                    <h2>{profile.profile.displayName.trim() || "Creator portfolio"}</h2>
                    <p>
                      {[profile.profile.contentFormats, profile.profile.languages]
                        .map((value) => value.trim())
                        .filter(Boolean)
                        .join(" · ") || "Formats and languages are not filled in."}
                    </p>
                  </div>
                </div>
                <ProfileEditor profile={profile.profile} />
              </>
            ) : (
              <ErrorState title="Profile" description={PROFILE_LIST_COPY.error} />
            )}
          </section>

          <section className="v12-panel v12-panel-pad">
            <div className="v12-panel-head">
              <div>
                <h2>Selected work</h2>
                <p>Lead with recorded projects. Nothing here is a sample.</p>
              </div>
              <Link href="/app/profile/portfolio" className="v12-btn v12-btn-small">
                Edit portfolio
              </Link>
            </div>
            {pieceReadsFailed ? (
              <ErrorState
                title="Selected work"
                description="Selected work could not be loaded. This is not an empty portfolio."
              />
            ) : selectedCount === 0 ? (
              <p>No selected work is recorded yet.</p>
            ) : (
              <div className="v12-work-grid">
                {past.status === "ok"
                  ? past.items.slice(0, 6).map((item) => (
                      <article key={item.id} className="v12-work-card">
                        <div className="v12-work-preview">{item.typeLabel ?? item.statusLabel}</div>
                        <strong>{item.hotelName}</strong>
                        <p>{item.when ?? "Dates not recorded"}</p>
                      </article>
                    ))
                  : null}
                {share.status === "ok"
                  ? share.deliverables.slice(0, 6).map((item) => (
                      <article key={item.id} className="v12-work-card">
                        <div className="v12-work-preview">{item.label}</div>
                        <strong>{item.platform ?? "Content example"}</strong>
                        <p>{item.proofUrl ? "Proof link recorded" : "No proof link yet"}</p>
                      </article>
                    ))
                  : null}
              </div>
            )}
            {share.status === "ok" ? (
              <ContentExamples
                deliverables={share.deliverables}
                sharedIds={share.sharedDeliverableIds}
              />
            ) : null}
            <PastCollaborations
              load={past}
              heading="Past collaborations"
              linkToHotel
              sharedIds={share.status === "ok" ? new Set(share.sharedCollaborationIds) : undefined}
            />
            <p>
              Past collaborations stay on this page until you mark them for the hotel link. They
              are not public by default.
            </p>
          </section>
        </div>

        <aside className="v12-stack">
          <section className="v12-port-preview">
            <p className="v12-eyebrow">HOTEL-FACING PREVIEW</p>
            <h3>
              {profile.status === "ok" && profile.profile.displayName.trim()
                ? profile.profile.displayName.trim()
                : "Your introduction"}
            </h3>
            <p>
              {profile.status === "ok" && profile.profile.bio.trim()
                ? profile.profile.bio.trim()
                : "A bio appears here after you save one. Follower counts are not shown."}
            </p>
            <p>
              {pieceReadsFailed
                ? "Selected work could not be counted."
                : selectedCount === 0
                  ? "No featured projects yet."
                  : `${selectedCount} featured project${selectedCount === 1 ? "" : "s"}`}
            </p>
            <p>
              Mailbox connection and account deletion stay on <Link href="/app/account">Account</Link>.
            </p>
          </section>
          <section className="v12-panel v12-panel-pad">
            <p className="v12-eyebrow">PROFILE READINESS</p>
            <h3>{readiness?.ready ? "Ready enough to pitch" : "Still private until you fill it"}</h3>
            {readiness ? (
              <ul className="v12-checklist">
                {readiness.items.map((item) => (
                  <li key={item.id}>
                    {item.done ? "Done" : "Not yet"} · {item.label}
                  </li>
                ))}
              </ul>
            ) : (
              <p>Readiness could not be checked because the profile did not load.</p>
            )}
            {pieceReadsFailed ? (
              <p>Selected pieces and the share link were not counted. That is not zero.</p>
            ) : null}
            <p>Audience-size claims are optional. A new creator can have a portfolio without invented follower counts.</p>
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
            </>
          ) : (
            <ErrorState title="Hotel share link" description={PROFILE_LIST_COPY.shareError} />
          )}
        </aside>
      </div>

      <PersonalCounts load={counts} />
    </div>
  );
}
