import { EmptyState } from "@/components/empty-state";
import { requireUser } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";

/** Dashboard/home. Sprint 0 renders a greeting shell; content lands in later sprints. */
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
      <div>
        <h1 className="text-2xl font-semibold text-text">Welcome, {name}</h1>
        <p className="mt-1 text-sm text-muted">
          Your operating homepage. Trips, follow-ups, and intelligence appear here as those features
          ship.
        </p>
      </div>
      <EmptyState
        title="Nothing due yet"
        description="Save hotels and start a pipeline to see follow-ups and recommendations here."
      />
    </div>
  );
}
