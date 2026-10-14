"use client";

import { useState } from "react";

import { adminUnpauseAction, type UnpauseResult } from "@/lib/ai/admin-actions";
import type { AbuseFlagRow, PoolAlertRow } from "@/lib/ai/admin-queries";

export function AdminAiControls({
  flags,
  alerts,
}: {
  flags: readonly AbuseFlagRow[];
  alerts: readonly PoolAlertRow[];
}) {
  const [result, setResult] = useState<UnpauseResult | null>(null);

  async function onSubmit(formData: FormData) {
    setResult(await adminUnpauseAction(formData));
  }

  return (
    <section className="space-y-4" data-testid="admin-ai-controls">
      <h2 className="text-lg font-semibold text-text">AI and sending</h2>
      {alerts.length > 0 ? (
        <ul className="space-y-1 text-sm text-text">
          {alerts.map((alert) => (
            <li key={`${alert.monthStart}-${alert.level}`}>
              Pool {alert.level} for {alert.monthStart}. Spent {alert.spentMicros} micros of{" "}
              {alert.poolMicros}.
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No AI pool alert this month.</p>
      )}
      {flags.length > 0 ? (
        <ul className="space-y-1 text-sm text-text">
          {flags.map((flag) => (
            <li key={flag.id}>
              {flag.signal} · {flag.userId}
              {flag.hotelId ? ` · ${flag.hotelId}` : ""}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No abuse flags.</p>
      )}
      <form action={onSubmit} className="space-y-3">
        <label className="block text-xs font-medium text-muted">
          User id
          <input
            name="userId"
            required
            className="mt-1 block w-full max-w-md rounded-[var(--radius-app)] border border-border bg-background px-3 py-2 text-sm text-text"
          />
        </label>
        <label className="block text-xs font-medium text-muted">
          Pause
          <select
            name="kind"
            className="mt-1 block rounded-[var(--radius-app)] border border-border bg-background px-3 py-2 text-sm text-text"
            defaultValue="account"
          >
            <option value="account">Account (AI and sends)</option>
            <option value="sends">Sends only</option>
          </select>
        </label>
        <button
          type="submit"
          className="inline-flex bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
        >
          Unpause
        </button>
        {result?.result === "ok" ? <p className="text-sm text-text">Unpaused.</p> : null}
        {result && result.result !== "ok" ? (
          <p className="text-sm text-text">That account was not changed.</p>
        ) : null}
      </form>
    </section>
  );
}
