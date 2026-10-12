import { AppShell } from "@/components/shell/app-shell";
import { requireUser } from "@/lib/auth/guards";

/**
 * Authenticated app shell. Route-group middleware already gates authentication;
 * requireUser here is the server-side source of truth and provides the session
 * context to child surfaces. The shell does not change that check.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireUser("/app");
  const isStaff = session.role === "admin" || session.role === "editor";

  return <AppShell isStaff={isStaff}>{children}</AppShell>;
}
