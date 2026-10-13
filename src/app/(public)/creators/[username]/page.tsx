import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { readPublicCreatorCard } from "@/lib/profile/queries";

export const metadata: Metadata = { title: "Creator" };

const COUNTS = [
  ["outreach", "Pitches sent"],
  ["replies", "Replies"],
  ["agreements", "Agreements"],
  ["completedCollaborations", "Completed collaborations"],
  ["deliverablesDone", "Deliverables approved"],
] as const;

/**
 * Social profile (D096–D097). Renders the projected card only.
 * A missing or private profile is not found, not a zero.
 */
export default async function PublicCreatorPage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  const loaded = await readPublicCreatorCard(username);
  if (loaded.status === "error") {
    return (
      <p className="text-sm text-muted">
        We couldn’t open this profile. Reload the page. This is not an empty profile.
      </p>
    );
  }
  if (loaded.status === "missing") notFound();
  const card = loaded.card;

  return (
    <article className="space-y-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.1em] text-[#666]">Creator</p>
        <h1 className="text-4xl font-extrabold tracking-tight">
          {card.displayName ?? card.username}
        </h1>
        <p className="text-sm text-[#555]">@{card.username}</p>
      </header>
      {card.bio ? <p className="max-w-prose text-sm">{card.bio}</p> : null}
      <p className="text-sm text-[#555]">
        {[card.homeCity, card.homeCountry, card.primaryLanguage].filter(Boolean).join(" · ")}
      </p>
      {card.niches.length > 0 ? <p className="text-sm">{card.niches.join(", ")}</p> : null}
      <ul className="space-y-1 text-sm">
        {card.instagramUrl ? <li>Instagram: {card.instagramUrl}</li> : null}
        {card.tiktokUrl ? <li>TikTok: {card.tiktokUrl}</li> : null}
        {card.youtubeUrl ? <li>YouTube: {card.youtubeUrl}</li> : null}
        {card.websiteUrl ? <li>Web: {card.websiteUrl}</li> : null}
      </ul>
      <dl className="grid grid-cols-2 gap-4 border-t-2 border-[#111] pt-4">
        {COUNTS.map(([key, label]) => (
          <div key={key}>
            <dt className="text-xs text-[#555]">{label}</dt>
            <dd className="text-3xl font-extrabold">{card.counts[key]}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}
