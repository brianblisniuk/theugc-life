"use client";

import { useState } from "react";

import { adminGrantCreditsAction, reviewContactReportAction } from "@/lib/credits/actions";
import type {
  AdminGrantResult,
  PendingContactReport,
  ReviewReportResult,
} from "@/lib/credits/types";

export function AdminGrantForm({ idempotencyKey }: { idempotencyKey: string }) {
  const [result, setResult] = useState<AdminGrantResult | null>(null);

  async function onSubmit(formData: FormData) {
    setResult(await adminGrantCreditsAction(formData));
  }

  return (
    <form action={onSubmit} className="space-y-3">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <label className="block text-xs font-medium text-muted">
        User id
        <input
          name="userId"
          required
          className="mt-1 block w-full max-w-md rounded-[var(--radius-app)] border border-border bg-background px-3 py-2 text-sm text-text"
        />
      </label>
      <label className="block text-xs font-medium text-muted">
        Credits to grant
        <input
          name="amount"
          type="number"
          min={1}
          required
          className="mt-1 block w-32 rounded-[var(--radius-app)] border border-border bg-background px-3 py-2 text-sm text-text"
        />
      </label>
      <button
        type="submit"
        className="inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
      >
        Grant credits
      </button>
      {result?.status === "granted" ? (
        <p className="text-sm text-text" role="status">
          Granted. Balance is {result.balance ?? "unreadable"}.
        </p>
      ) : null}
      {result && result.status !== "granted" ? (
        <p className="text-sm text-muted" role="status">
          The grant did not land ({result.status}).
        </p>
      ) : null}
    </form>
  );
}

export function AdminReportQueue({ reports }: { reports: readonly PendingContactReport[] }) {
  const [done, setDone] = useState<Record<string, ReviewReportResult["status"]>>({});

  async function onSubmit(formData: FormData) {
    const outcome = await reviewContactReportAction(formData);
    const reportId = formData.get("reportId");
    if (typeof reportId === "string") {
      setDone((current) => ({ ...current, [reportId]: outcome.status }));
    }
  }

  if (reports.length === 0) {
    return <p className="text-sm text-muted">No pending contact reports.</p>;
  }

  return (
    <ul className="space-y-4">
      {reports.map((report) => (
        <li
          key={report.id}
          className="space-y-2 rounded-[var(--radius-app)] border border-border p-3 text-sm"
        >
          <p className="text-text">{report.reason}</p>
          <p className="text-xs text-muted">
            User {report.userId} · hotel {report.hotelId}
          </p>
          {done[report.id] ? (
            <p role="status">Marked {done[report.id]}.</p>
          ) : (
            <form action={onSubmit} className="flex gap-2">
              <input type="hidden" name="reportId" value={report.id} />
              <button
                type="submit"
                name="decision"
                value="accept"
                className="rounded-[var(--radius-app)] bg-accent px-3 py-1.5 text-sm font-semibold text-accent-contrast"
              >
                Accept report
              </button>
              <button
                type="submit"
                name="decision"
                value="reject"
                className="rounded-[var(--radius-app)] border border-border px-3 py-1.5 text-sm font-semibold"
              >
                Reject report
              </button>
            </form>
          )}
        </li>
      ))}
    </ul>
  );
}
