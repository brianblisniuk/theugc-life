import { AppShell } from "@/components/shell/app-shell";
import { requireUser } from "@/lib/auth/guards";
import { loadBillingAccess } from "@/lib/billing/queries";
import { getOwnCreditBalance } from "@/lib/credits/queries";
import { creditsAvailableLabel } from "@/lib/screens/next-step";
import { CREDITS_UNAVAILABLE } from "@/lib/screens/copy";
import { planChipFromAccess } from "@/lib/screens/plan-chip";

/**
 * Authenticated app shell. Route-group middleware already gates authentication;
 * requireUser here is the server-side source of truth and provides the session
 * context to child surfaces. The shell does not change that check.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireUser("/app");
  const isStaff = session.role === "admin" || session.role === "editor";
  const [credits, billing] = await Promise.all([
    getOwnCreditBalance(),
    loadBillingAccess(session.userId),
  ]);
  const creditLabel =
    credits.status === "ok" ? creditsAvailableLabel(credits.balance) : CREDITS_UNAVAILABLE;
  const planLabel = planChipFromAccess(billing);

  return (
    <AppShell
      isStaff={isStaff}
      creditLabel={creditLabel}
      planLabel={planLabel}
      email={session.email}
    >
      {children}
    </AppShell>
  );
}
