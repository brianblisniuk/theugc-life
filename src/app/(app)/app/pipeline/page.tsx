import type { Metadata } from "next";

import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = { title: "Pipeline" };

export default function PipelinePage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-text">Pipeline</h1>
      <EmptyState
        title="Your CRM arrives in Sprint 2"
        description="List and board views, statuses, private notes, and follow-ups build on the pipeline schema created in this foundation."
      />
    </div>
  );
}
