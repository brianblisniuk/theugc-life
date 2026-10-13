import { AppShell } from "@/components/shell/app-shell";
import { requireUser } from "@/lib/auth/guards";
import { creditsLeftLabel } from "@/lib/credits/config";
import { getOwnCreditBalance } from "@/lib/credits/queries";

/**
 * Authenticated app shell. Route-group middleware already gates authentication;
 * requireUser here is the server-side source of truth and provides the session
 * context to child surfaces. The shell does not change that check.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireUser("/app");
  const isStaff = session.role === "admin" || session.role === "editor";
  const letters = (session.email ?? "").split("@")[0]?.replace(/[^a-z]/gi, "") ?? "";
  const initials = letters.slice(0, 2).toUpperCase() || "•";
  const credits = await getOwnCreditBalance();
  const creditLabel =
    credits.status === "ok" ? creditsLeftLabel(credits.balance) : "Credits unavailable";

  return (
    <AppShell isStaff={isStaff} initials={initials} creditLabel={creditLabel}>
      {children}
    </AppShell>
  );
}
