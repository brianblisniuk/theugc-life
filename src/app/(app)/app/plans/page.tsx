import type { Metadata } from "next";
import Link from "next/link";

import { V12Icon } from "@/components/icons/v12-icons";
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

const PLAN_FACE = {
  free: {
    eyebrow: "START SIMPLE",
    points: [
      "Browse the hotel catalog and public activity",
      "Save a limited hotel shortlist and Trip",
      "Unlock contacts with available credits",
      "Write pitches using manual templates",
      "Track opportunities manually",
    ],
    action: "Current Free capabilities",
  },
  pro: {
    eyebrow: "FOR CONSISTENT OUTREACH",
    points: [
      "Everything in Free, higher working capacity",
      "Reply rate and typical reply signals when publishable",
      "Advanced discovery filters",
      "AI-assisted pitch drafting with credits",
      "Authorized Gmail-connected workflows",
    ],
    action: "Compare Pro capabilities",
  },
  max: {
    eyebrow: "FOR HIGHER VOLUME",
    points: [
      "Everything in Pro, greater credit allowance",
      "Deeper Creator Fit insight where available",
      "More research and outreach capacity",
      "Advanced workflow limits and filters",
      "Still no guaranteed responses or collaborations",
    ],
    action: "Compare Max capabilities",
  },
} as const;

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
    <div className="v12-stack">
      <header className="v12-pagehead">
        <div>
          <p className="v12-eyebrow">PLANS & CREDITS / CREATOR WORKSPACE</p>
          <h1>Choose the capacity that fits your work.</h1>
          <p>
            Every plan starts with the same goal: help creators reach the right hotel contacts and
            manage opportunities confidently.
          </p>
        </div>
        <ButtonLink href="/app/billing">
          <V12Icon name="billing" size={15} />
          Billing & Activity
        </ButtonLink>
      </header>

      <p className="v12-callout">
        <strong>One credit unlocks a hotel&apos;s available professional contacts.</strong> Only a
        successful unlock is charged. An unsuccessful lookup and reopening a previously unlocked
        hotel cost zero. No one is promised a named person if only a department mailbox exists.
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
              <p className="v12-eyebrow">{current ? "Current" : PLAN_FACE[card.id].eyebrow}</p>
              <h2>{card.name}</h2>
              <p className="s6-credits">{card.credits} credits</p>
              <p>{card.creditNote}</p>
              <p className="s6-price">{card.priceNote}</p>
              <ul>
                {PLAN_FACE[card.id].points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
              <ButtonLink
                href={card.checkoutHref}
                variant={card.id === "pro" ? "primary" : "secondary"}
                block
              >
                {PLAN_FACE[card.id].action}
              </ButtonLink>
            </section>
          );
        })}
      </div>

      {chip === "Pass" ? <p className="s6-callout">{destinationPassNote()}</p> : null}

      <section className="v12-card">
        <div className="v12-card-pad">
          <h2>Know what a credit pays for.</h2>
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
          access. Premium access never guarantees a hotel will have sufficient data to publish every
          metric.
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
