import type { Metadata } from "next";

import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = { title: "Trips" };

export default function TripsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-text">Trips</h1>
      <EmptyState
        title="Trip planning arrives in Sprint 2"
        description="Trips connect destination planning to discovery and outreach. The trips schema exists; the product UI comes later."
      />
    </div>
  );
}
