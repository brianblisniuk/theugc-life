import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PublicShareView } from "@/components/profile/public-share-view";
import { readPublicCreatorShare } from "@/lib/profile/public-share";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Creator profile",
  robots: { index: false, follow: false, nocache: true },
};

/**
 * Public hotel view of one share link. No session. Invalid, revoked, and
 * expired tokens use the same not-found page. The response is not cached.
 */
export default async function PublicSharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const loaded = await readPublicCreatorShare(token);
  if (loaded.status === "not_found") notFound();
  if (loaded.status === "error") {
    return (
      <p className="max-w-prose text-sm text-muted">
        This profile couldn’t be loaded. This is not an empty profile.
      </p>
    );
  }
  return <PublicShareView view={loaded.view} />;
}
