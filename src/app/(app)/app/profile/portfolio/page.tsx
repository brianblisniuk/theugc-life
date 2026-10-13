import type { Metadata } from "next";

import { PortfolioEditor } from "@/components/profile/portfolio-editor";
import { PageHeader } from "@/components/shell/page-header";
import { requireUser } from "@/lib/auth/guards";
import { bindServerActions } from "@/lib/entitlements/inventory";
import { PORTFOLIO_COPY } from "@/lib/profile/portfolio-contract";
import { getOwnPortfolio } from "@/lib/profile/portfolio-queries";
import { listCrumbs } from "@/lib/shell/navigation";

bindServerActions(["profile.portfolio"]);

export const metadata: Metadata = { title: "Portfolio" };

/**
 * Travel portfolio (D125). Suggestions are confirmed collaborations the
 * creator recorded. Approval is explicit. The social profile is unchanged.
 */
export default async function PortfolioPage() {
  await requireUser("/app/profile/portfolio");
  const loaded = await getOwnPortfolio();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Portfolio"
        crumbs={listCrumbs("Portfolio", { href: "/app/profile", label: "Profile" })}
        back={{ href: "/app/profile", label: "Profile" }}
        description="Pick a travel layout and approve each confirmed collaboration before it can appear on your hotel share link. Past collaborations on your profile stay private."
      />
      {loaded.status === "ok" ? (
        <PortfolioEditor portfolio={loaded.portfolio} />
      ) : (
        <p className="max-w-prose text-sm text-muted">{PORTFOLIO_COPY.error}</p>
      )}
    </div>
  );
}
