import type { Metadata } from "next";

import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = { title: "Discover" };

export default function DiscoverPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-text">Discover</h1>
      <EmptyState
        title="Hotel discovery arrives in Sprint 1"
        description="Map, search, filters, and hotel intelligence are built on the Sprint 1 database. This is a foundation shell."
      />
    </div>
  );
}
