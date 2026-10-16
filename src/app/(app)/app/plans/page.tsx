import type { Metadata } from "next";
import Link from "next/link";

import { ButtonLink } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { ErrorState } from "@/components/ui/states";
import { requireUser } from "@/lib/auth/guards";
import { loadBillingAccess } from "@/lib/billing/queries";
import { billingAccessState } from "@/lib/billing/view";
import { creditActions, destinationPassNote, packOffers, planCards } from "@/lib/plans/catalog";
import { PLAN_PRICES } from "@/lib/credits/config";
import { planChipFromBillingState } from "@/lib/screens/plan-chip";

export const metadata: Metadata = { title: "Plans & Credits" };

/**
 * Plan comparison. Amounts come from config. Checkout stays on Billing.
 * This page does not grant access and does not send an amount.
 */
export default async function PlansPage() {
  const session = await requireUser("/app/plans");
  const access = await loadBillingAccess(session.userId);
  const state = billingAccessState(access);
  const chip = planChipFromBillingState(state);
  const cards = planCards();

  return (
    <div className="s6-page">
      <header className="s6-head">
        <div>
          <p className="s6-eyebrow">Plans & Credits</p>
          <h1>Choose the capacity that fits your work.</h1>
          <p>
            Every plan can reach the catalog. A credit is spent only when a lookup or a draft
            succeeds. Prices below are the configured plan amounts.
          </p>
        </div>
        <ButtonLink href="/app/billing">Billing & Activity</ButtonLink>
      </header>

      <p className="s6-callout">
        One credit unlocks a hotel&apos;s available professional contacts when the lookup succeeds.
        An unsuccessful lookup and reopening an unlocked hotel cost nothing.
      </p>

      {state.kind === "error" ? (
        <ErrorState title={state.title} description={state.body} />
      ) : (
        <p className="s6-muted">
          Current access: {chip}.{" "}
          {state.kind === "free"
            ? state.body
            : "Paid access is the entitlement, not the checkout button."}
        </p>
      )}

      <div className="s6-plans">
        {cards.map((card) => {
          const current =
            (card.id === "free" && chip === "Free") ||
            (card.id === "pro" && chip === "Pro") ||
            (card.id === "max" && chip === "Max");
          return (
            <section
              key={card.id}
              className={current ? "v12-card v12-card-pad s6-current" : "v12-card v12-card-pad"}
            >
              <p className="s6-eyebrow">{current ? "Current" : card.name}</p>
              <h2>{card.name}</h2>
              <p className="s6-credits">{card.credits} credits</p>
              <p>{card.creditNote}</p>
              <p className="s6-price">{card.priceNote}</p>
              <ul>
                {card.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
              <ButtonLink
                href={card.checkoutHref}
                variant={card.id === "pro" ? "primary" : "secondary"}
                block
              >
                {card.id === "free"
                  ? "Review Free on Billing"
                  : `Continue with ${card.name} on Billing`}
              </ButtonLink>
            </section>
          );
        })}
      </div>

      {chip === "Pass" ? <p className="s6-callout">{destinationPassNote()}</p> : null}

      <section className="v12-card">
        <div className="v12-card-pad">
          <h2>What a credit pays for</h2>
        </div>
        <DataTable
          caption="Credit actions"
          columns={["Action", "Credits", "What you should see"]}
          rows={creditActions().map((row) => [row.action, row.credits, row.result])}
        />
      </section>

      <section className="v12-card v12-card-pad">
        <h2>Credit packs</h2>
        <ul className="s6-list">
          {packOffers().map((pack) => (
            <li key={pack.credits}>
              <LinkPack pack={pack} />
            </li>
          ))}
        </ul>
        <p className="s6-muted">
          Pro annual is ${PLAN_PRICES.pro.annualPerMonthUsd * 12} and Max annual is $
          {PLAN_PRICES.max.annualPerMonthUsd * 12}. Checkout starts on Billing. A payment is not
          access.
        </p>
      </section>
    </div>
  );
}

function LinkPack({ pack }: { pack: { credits: number; priceUsd: number; href: string } }) {
  return (
    <Link href={pack.href}>
      {pack.credits} credits · ${pack.priceUsd}
    </Link>
  );
}
