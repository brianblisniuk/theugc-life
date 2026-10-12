import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { requireUser } from "@/lib/auth/guards";
import { WORKSPACES } from "@/lib/shell/navigation";
import { createClient } from "@/lib/supabase/server";

/** Home. The greeting links into the workspaces that already exist (D081). */
export default async function AppHomePage() {
  const session = await requireUser("/app");
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("creator_profiles")
    .select("display_name")
    .eq("user_id", session.userId)
    .maybeSingle();

  const name = profile?.display_name ?? session.email ?? "creator";

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Welcome, ${name}`}
        description="Discover hotels, plan a trip, and keep pipeline, inbox, and collaborations in one place."
      />
      <nav
        aria-label="Workspaces"
        className="-mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:grid md:grid-cols-2 md:overflow-visible md:px-0 lg:grid-cols-3"
      >
        {WORKSPACES.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="flex min-h-11 min-w-[12rem] shrink-0 flex-col justify-center rounded-[var(--radius-app)] border border-border bg-surface px-4 py-3 md:min-w-0"
          >
            <span className="text-sm font-semibold text-text">{item.label}</span>
            <span className="text-xs text-muted">{item.note}</span>
          </Link>
        ))}
      </nav>
      <EmptyState
        title="Nothing due yet"
        description="Save hotels and start a pipeline to see follow-ups and recommendations here."
      />
    </div>
  );
}
