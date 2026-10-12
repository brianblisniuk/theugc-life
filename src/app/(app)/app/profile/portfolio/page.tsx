import type { Metadata } from "next";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { listCrumbs } from "@/lib/shell/navigation";

export const metadata: Metadata = { title: "Portfolio" };

export default function PortfolioPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Portfolio"
        crumbs={listCrumbs("Portfolio", { href: "/app/profile", label: "Profile" })}
        back={{ href: "/app/profile", label: "Profile" }}
      />
      <EmptyState
        title="Portfolio management arrives later"
        description="Portfolio assets (video, image, link, case study) have a schema and storage-permission foundation; the management UI is a later sprint."
      />
    </div>
  );
}
