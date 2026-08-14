import type { Metadata } from "next";
import Link from "next/link";

import { requireUser } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Profile" };

/**
 * Creator profile view. Reads the owner's own creator_profiles row under RLS
 * (a foundation read; the full editor is a later sprint).
 */
export default async function ProfilePage() {
  const session = await requireUser("/app/profile");
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("creator_profiles")
    .select("display_name, username, public_profile_enabled")
    .eq("user_id", session.userId)
    .maybeSingle();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-text">Profile</h1>
        <Link href="/app/profile/portfolio" className="text-sm text-accent hover:underline">
          Portfolio
        </Link>
      </div>
      <dl className="grid gap-4 rounded-[var(--radius-app)] border border-border bg-surface p-5 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted">Display name</dt>
          <dd className="text-text">{profile?.display_name ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted">Username</dt>
          <dd className="text-text">{profile?.username ? `@${profile.username}` : "—"}</dd>
        </div>
        <div>
          <dt className="text-muted">Public profile</dt>
          <dd className="text-text">{profile?.public_profile_enabled ? "Enabled" : "Private"}</dd>
        </div>
      </dl>
    </div>
  );
}
