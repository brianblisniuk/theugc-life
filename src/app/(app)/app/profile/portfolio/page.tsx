import type { Metadata } from "next";

import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = { title: "Portfolio" };

export default function PortfolioPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-text">Portfolio</h1>
      <EmptyState
        title="Portfolio management arrives later"
        description="Portfolio assets (video, image, link, case study) have a schema and storage-permission foundation; the management UI is a later sprint."
      />
    </div>
  );
}
