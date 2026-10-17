import type { Metadata } from "next";
import Link from "next/link";

import { ButtonLink } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { requireUser } from "@/lib/auth/guards";
import { startRebillCheckoutAction } from "@/lib/billing/actions";
import {
  BALANCE_ERROR,
  COMMERCE_EMPTY,
  COMMERCE_ERROR,
  LEDGER_EMPTY,
  LEDGER_ERROR,
  NOT_A_CHARGE,
  REFUND_RULES,
  planAllowance,
} from "@/lib/billing/activity";
import { loadOwnCommerce, loadOwnLedger } from "@/lib/billing/activity-queries";
import { loadBillingAccess } from "@/lib/billing/queries";
import {
  REBILL_PRODUCT_CODES,
  rebillAmountUsd,
  rebillProductTitle,
} from "@/lib/billing/rebill-catalog";
import { billingAccessState } from "@/lib/billing/view";
import { PLAN_PRICES } from "@/lib/credits/config";
import { getOwnCreditBalance, refreshOwnGrants } from "@/lib/credits/queries";
import { planChipFromBillingState } from "@/lib/screens/plan-chip";

function planLabel(accessType: string): string {
  if (accessType === "pro") return "Pro";
  if (accessType === "max") return "Max";
  if (accessType === "destination") return "Destination Pass";
  if (accessType === "admin") return "Admin";
  return accessType;
}

const CHECKOUT_NOTES: Record<string, string> = {
  invalid_product: "That product is not for sale.",
  deletion_pending: "Account deletion is scheduled. New checkouts are closed. Nothing was charged.",
  not_configured: "Checkout is not configured on this server.",
  live_disabled: "Live charges are off. Sandbox checkout is not available for this key.",
  provider_error: "Rebill did not open a checkout. Nothing was granted.",
  rejected_url: "The checkout URL was not the theugc-life payment page. Nothing was granted.",
  returned:
    "If the payment succeeded, access appears after the verified webhook. A payment alone is not access.",
};

export const metadata: Metadata = { title: "Billing & Activity" };

/**
 * Own credits, payments, and hosted Rebill checkout.
 * Opening the page refreshes this account's grants. The form sends a product
 * code, not an account id or an amount. A payment row is not access.
 */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const session = await requireUser("/app/billing");
  await refreshOwnGrants();
  const [access, balance, ledger, commerce] = await Promise.all([
    loadBillingAccess(session.userId),
    getOwnCreditBalance(),
    loadOwnLedger(session.userId),
    loadOwnCommerce(session.userId),
  ]);
  const state = billingAccessState(access);
  const chip = planChipFromBillingState(state);
  const allowance = planAllowance(chip);
  const checkoutCode = (await searchParams).checkout;
  const checkoutNote =
    checkoutCode && CHECKOUT_NOTES[checkoutCode] ? CHECKOUT_NOTES[checkoutCode] : null;

  return (
    <div className="v12-stack">
      <header className="v12-pagehead">
        <div>
          <p className="v12-eyebrow">BILLING & ACTIVITY / CREATOR WORKSPACE</p>
          <h1>Understand every credit movement.</h1>
          <p>Your plan, credits, and payment records should agree with what happened.</p>
        </div>
        <ButtonLink href="/app/plans">Compare plans</ButtonLink>
      </header>

      {state.kind === "error" ? (
        <ErrorState title={state.title} description={state.body} />
      ) : (
        <section className="s6-hero">
          <div>
            <p className="s6-eyebrow">Available credits</p>
            <h2>{balance.status === "ok" ? balance.balance : BALANCE_ERROR}</h2>
            <p>
              {chip ?? "Plan unavailable"}
              {allowance ? ` · ${allowance.note}` : ""}
            </p>
          </div>
          <ButtonLink href="/app/plans" variant="primary">
            Manage plan
          </ButtonLink>
        </section>
      )}

      <div className="s6-stats">
        <div>
          <span>Allowance</span>
          <strong>{allowance ? allowance.credits : "Unavailable"}</strong>
          <small>{allowance ? allowance.note : "The plan could not be read"}</small>
        </div>
        <div>
          <span>Credits used</span>
          <strong>{ledger.kind === "ok" ? ledger.used : "Unavailable"}</strong>
          <small>Successful unlocks and AI drafts in this list</small>
        </div>
        <div>
          <span>Available</span>
          <strong>{balance.status === "ok" ? balance.balance : "Unavailable"}</strong>
          <small>{balance.status === "ok" ? "Current balance" : BALANCE_ERROR}</small>
        </div>
        <div>
          <span>Access</span>
          <strong>
            {state.kind === "error" ? "Unavailable" : state.kind === "free" ? "Free" : "Paid"}
          </strong>
          <small>An entitlement, not a payment</small>
        </div>
      </div>

      {checkoutNote ? (
        <p className="s6-callout" role="status">
          {checkoutNote}
        </p>
      ) : null}

      <div className="s6-split">
        <section className="v12-card">
          <div className="v12-card-pad">
            <h2>Credit activity</h2>
            <p className="s6-muted">
              Only movements that were written are listed. A lookup that costs nothing is not a row
              here.
            </p>
          </div>
          {ledger.kind === "error" ? (
            <ErrorState title="Credit activity" description={LEDGER_ERROR} />
          ) : ledger.movements.length === 0 ? (
            <EmptyState title="No movements" description={LEDGER_EMPTY} />
          ) : (
            <>
              <DataTable
                caption="Credit activity"
                columns={["Date", "Action", "Credits", "Outcome"]}
                rows={ledger.movements.map((movement) => [
                  movement.when,
                  movement.label,
                  movement.delta > 0 ? `+${movement.delta}` : `−${Math.abs(movement.delta)}`,
                  movement.outcome,
                ])}
              />
              {ledger.capped ? (
                <p className="s6-muted s6-pad">This list is capped. It is not the whole ledger.</p>
              ) : null}
            </>
          )}
        </section>
        <aside className="s6-stack">
          <section className="v12-card v12-card-pad">
            <p className="s6-eyebrow">Access</p>
            {state.kind === "premium" ? (
              <ul className="s6-list">
                {state.entitlements.map((entitlement) => (
                  <li key={`${entitlement.accessType}-${entitlement.startsAt}`}>
                    <strong>{planLabel(entitlement.accessType)}</strong>
                    <p className="s6-muted">
                      {entitlement.expiresAt
                        ? `Until ${new Date(entitlement.expiresAt).toLocaleDateString("en-GB", { timeZone: "UTC" })}`
                        : "Active"}
                    </p>
                  </li>
                ))}
              </ul>
            ) : state.kind === "free" ? (
              <p>{state.body}</p>
            ) : (
              <p>{state.body}</p>
            )}
            <h3>Payment records</h3>
            <p className="s6-muted">These rows do not turn a plan on.</p>
            {commerce.kind === "error" ? (
              <p role="alert">{COMMERCE_ERROR}</p>
            ) : commerce.kind === "empty" ? (
              <p>{COMMERCE_EMPTY}</p>
            ) : (
              <ul className="s6-list">
                {commerce.records.map((record) => (
                  <li key={record.id}>
                    <strong>
                      {record.kind === "subscription" ? "Subscription" : "Payment"} · {record.title}
                    </strong>
                    <p className="s6-muted">
                      {record.status}
                      {record.amount ? ` · ${record.amount}` : ""}
                      {record.when ? ` · ${record.when}` : ""}
                      {record.refundedAt ? ` · refunded ${record.refundedAt}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <Link href="/app/plans" className="v12-btn v12-btn-block">
              Plans & Credits
            </Link>
          </section>
          <section className="v12-card v12-card-pad">
            <h3>Refunds</h3>
            <ul className="s6-list">
              {REFUND_RULES.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
            <p className="s6-callout">{NOT_A_CHARGE}</p>
          </section>
        </aside>
      </div>

      <section className="v12-card v12-card-pad" id="checkout">
        <h2>Checkout</h2>
        <p className="s6-muted">
          Each button opens a hosted Rebill link for that product. Pro annual is $
          {PLAN_PRICES.pro.annualPerMonthUsd * 12}. Max annual is $
          {PLAN_PRICES.max.annualPerMonthUsd * 12}. Live charges stay off unless this server is
          explicitly in live mode. Nothing is granted on this page.
        </p>
        <div className="s6-actions">
          {REBILL_PRODUCT_CODES.map((product) => (
            <form key={product} id={`checkout-${product}`} action={startRebillCheckoutAction}>
              <input type="hidden" name="product" value={product} />
              <button type="submit" className="v12-btn">
                {rebillProductTitle(product)} · ${rebillAmountUsd(product)}
              </button>
            </form>
          ))}
        </div>
      </section>
    </div>
  );
}
