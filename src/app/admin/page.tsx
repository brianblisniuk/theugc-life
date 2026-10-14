import type { Metadata } from "next";

import { AdminAiControls } from "@/components/admin/ai-admin";
import { AdminGrantForm, AdminReportQueue } from "@/components/admin/credit-admin";
import { listAdminAbuseFlags, listAdminPoolAlerts } from "@/lib/ai/admin-queries";
import { requireRole } from "@/lib/auth/guards";
import { listPendingContactReports } from "@/lib/credits/queries";
import { factTypeLabel, responseTimeBandLabel } from "@/lib/network-intelligence/display";
import { getAdminPilotKpis, getAdminProvenance } from "@/lib/network-intelligence/queries";

export const metadata: Metadata = { title: "Admin", robots: { index: false } };

export default async function AdminHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireRole(["admin", "editor"], "/admin");
  const raw = await searchParams;
  const factId = typeof raw.fact === "string" ? raw.fact : "";
  const isAdmin = session.role === "admin";
  const kpis = isAdmin ? await getAdminPilotKpis() : { status: "hidden" as const };
  const reports = isAdmin ? await listPendingContactReports() : { status: "hidden" as const };
  const abuseFlags = isAdmin ? await listAdminAbuseFlags() : [];
  const poolAlerts = isAdmin ? await listAdminPoolAlerts() : [];
  const grantKey = crypto.randomUUID();
  const provenance =
    isAdmin && factId ? await getAdminProvenance(factId) : { status: "hidden" as const };

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold text-text">Admin</h1>
      <p className="max-w-prose text-sm text-muted">
        Pilot measures and fact provenance stay on this page. Creators do not see them.
      </p>

      {session.role !== "admin" ? (
        <p className="text-sm text-muted">These measures are limited to admins.</p>
      ) : kpis.status === "error" ? (
        <p className="text-sm text-muted">
          The pilot measures could not be loaded. That is not a zero.
        </p>
      ) : kpis.status === "hidden" ? null : (
        <section className="space-y-3" data-testid="admin-pilot-kpis">
          <h2 className="text-lg font-semibold text-text">Pilot</h2>
          <dl className="space-y-1 text-sm">
            <div className="flex gap-2">
              <dt className="text-muted">Gmail confirmed</dt>
              <dd className="text-text">{kpis.kpis.gmailConfirmed}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">Gmail dismissed</dt>
              <dd className="text-text">{kpis.kpis.gmailDismissed}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">Confirmed share</dt>
              <dd className="text-text">
                {kpis.kpis.gmailConfirmedPct === null
                  ? "Not enough answers"
                  : `${kpis.kpis.gmailConfirmedPct}%`}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">Hotels at emerging or above</dt>
              <dd className="text-text">{kpis.kpis.hotelsEmergingOrAbove}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">Creators who saw network data</dt>
              <dd className="text-text">{kpis.kpis.creatorsWhoViewed}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">Creators who returned</dt>
              <dd className="text-text">
                {kpis.kpis.creatorsWhoReturned}
                {kpis.kpis.returnRate === null ? "" : ` · ${kpis.kpis.returnRate}`}
              </dd>
            </div>
          </dl>
          <div>
            <h3 className="text-sm font-semibold text-text">Confirmed facts per creator</h3>
            <ul className="mt-1 space-y-1 text-sm text-muted">
              {kpis.kpis.confirmedFactsPerCreator.map((row) => (
                <li key={row.creatorUserId}>
                  {row.creatorUserId}: {row.manualFacts} manual, {row.gmailConfirmedFacts} Gmail
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text">Hotel response time</h3>
            {kpis.kpis.hotelResponseTime.length === 0 ? (
              <p className="text-sm text-muted">
                No hotel has three creators and five observations yet.
              </p>
            ) : (
              <ul className="mt-1 space-y-1 text-sm text-muted">
                {kpis.kpis.hotelResponseTime.map((row) => (
                  <li key={row.hotelId}>
                    {row.hotelId}: {responseTimeBandLabel(row.band) ?? "Unpublished band"}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {isAdmin ? (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-text">Fact provenance</h2>
          <form method="get" className="flex flex-wrap items-end gap-3">
            <label className="block text-xs font-medium text-muted">
              Fact id
              <input
                name="fact"
                defaultValue={factId}
                className="mt-1 block w-80 rounded-[var(--radius-app)] border border-border bg-background px-3 py-2 text-sm text-text"
              />
            </label>
            <button
              type="submit"
              className="inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
            >
              Look up
            </button>
          </form>
          {factId && provenance.status === "error" ? (
            <p className="text-sm text-muted">The lookup failed. That is not an empty fact.</p>
          ) : null}
          {factId && provenance.status === "hidden" ? (
            <p className="text-sm text-muted">No fact with that id.</p>
          ) : null}
          {provenance.status === "ok" ? (
            <dl className="space-y-1 text-sm" data-testid="admin-provenance">
              <div className="flex gap-2">
                <dt className="text-muted">Type</dt>
                <dd className="text-text">{factTypeLabel(provenance.provenance.factType)}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted">Source</dt>
                <dd className="text-text">{provenance.provenance.sourceFamily}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted">Class</dt>
                <dd className="text-text">{provenance.provenance.provenanceClass}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted">Evidence</dt>
                <dd className="text-text">
                  {provenance.provenance.evidenceKind} {provenance.provenance.evidenceId}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted">Owner</dt>
                <dd className="text-text">{provenance.provenance.ownerUserId}</dd>
              </div>
            </dl>
          ) : null}
        </section>
      ) : null}

      {isAdmin ? <AdminAiControls flags={abuseFlags} alerts={poolAlerts} /> : null}

      {isAdmin ? (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-text">Credit grants</h2>
          <p className="max-w-prose text-sm text-muted">
            Pilot credits are granted here. This is not a purchase and it does not call a payment
            provider.
          </p>
          <AdminGrantForm idempotencyKey={grantKey} />
        </section>
      ) : null}

      {isAdmin ? (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-text">Contact reports</h2>
          {reports.status === "error" ? (
            <p className="text-sm text-muted">
              Reports could not be loaded. That is not an empty queue.
            </p>
          ) : reports.status === "ok" ? (
            <AdminReportQueue reports={reports.reports} />
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
