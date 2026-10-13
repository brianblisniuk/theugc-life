"use client";

import { useState } from "react";

import {
  dismissPortfolioEntry,
  publishPortfolioEntry,
  setPortfolioTemplate,
  withdrawPortfolioEntry,
  type PortfolioWriteResult,
} from "@/lib/profile/portfolio-actions";
import {
  PORTFOLIO_COPY,
  PORTFOLIO_TEMPLATES,
  PORTFOLIO_TEMPLATE_LABELS,
  portfolioListOutcome,
  type OwnPortfolio,
  type PortfolioEntry,
  type PortfolioTemplate,
} from "@/lib/profile/portfolio-contract";

const STATUS_LABELS: Record<PortfolioEntry["status"], string> = {
  agreed: "Agreed",
  scheduled: "Scheduled",
  active: "Active",
  completed: "Completed",
  cancelled: "Cancelled",
};

const TYPE_LABELS: Record<string, string> = {
  stay: "Stay",
  product: "Product",
  paid: "Paid",
  stay_plus_paid: "Stay plus paid",
  other: "Other",
};

function whenLabel(entry: PortfolioEntry): string {
  if (entry.startDate && entry.endDate) return `${entry.startDate} – ${entry.endDate}`;
  return entry.startDate ?? entry.endDate ?? "Unknown";
}

function typeLabel(entry: PortfolioEntry): string {
  if (!entry.collaborationType) return "Unknown";
  return TYPE_LABELS[entry.collaborationType] ?? "Unknown";
}

function saveMessage(result: PortfolioWriteResult): string {
  if (result.result === "saved")
    return "Layout saved. Approved collaborations can appear on your share link.";
  if (result.result === "published")
    return "Approved. It appears on your share link when a layout is chosen.";
  if (result.result === "dismissed") return "Dismissed. It stays off the share link.";
  if (result.result === "withdrawn")
    return "Removed. A confirmed collaboration can be suggested again.";
  if (result.result === "invalid_input") return result.message;
  if (result.result === "not_confirmed") {
    return "Only a confirmed collaboration can be approved. A cancelled one is not confirmed.";
  }
  if (result.result === "not_found") return "That collaboration is not on your account.";
  return "We couldn’t save that. Try again.";
}

function EntryFacts({ entry }: { entry: PortfolioEntry }) {
  return (
    <div className="space-y-1">
      <h3 className="text-base font-semibold text-text">{entry.hotelName}</h3>
      <p className="text-sm text-muted">
        {entry.destinationName ?? "Unknown"} · {STATUS_LABELS[entry.status]} · {typeLabel(entry)}
      </p>
      <p className="text-xs text-muted">{whenLabel(entry)}</p>
    </div>
  );
}

function DecisionButtons({
  entry,
  primary,
  primaryLabel,
  secondary,
  secondaryLabel,
}: {
  entry: PortfolioEntry;
  primary: (formData: FormData) => Promise<PortfolioWriteResult>;
  primaryLabel: string;
  secondary?: (formData: FormData) => Promise<PortfolioWriteResult>;
  secondaryLabel?: string;
}) {
  const [message, setMessage] = useState<string | null>(null);

  async function run(
    action: (formData: FormData) => Promise<PortfolioWriteResult>,
    formData: FormData,
  ) {
    setMessage(saveMessage(await action(formData)));
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <form action={(formData) => run(primary, formData)}>
          <input type="hidden" name="collaborationId" value={entry.collaborationId} />
          <button
            type="submit"
            className="inline-flex rounded-[var(--radius-app)] bg-accent px-3 py-1.5 text-sm font-semibold text-accent-contrast"
          >
            {primaryLabel}
          </button>
        </form>
        {secondary && secondaryLabel ? (
          <form action={(formData) => run(secondary, formData)}>
            <input type="hidden" name="collaborationId" value={entry.collaborationId} />
            <button
              type="submit"
              className="inline-flex rounded-[var(--radius-app)] border border-border px-3 py-1.5 text-sm font-semibold text-text"
            >
              {secondaryLabel}
            </button>
          </form>
        ) : null}
      </div>
      {message ? (
        <p className="text-sm text-text" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}

export function PortfolioEditor({ portfolio }: { portfolio: OwnPortfolio }) {
  const [message, setMessage] = useState<string | null>(null);
  const suggestions = portfolioListOutcome({
    failed: false,
    suggestionCount: portfolio.suggestions.length,
  });

  async function onTemplate(formData: FormData) {
    setMessage(saveMessage(await setPortfolioTemplate(formData)));
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-text">Layout</h2>
          <p className="max-w-prose text-sm text-muted">
            The layout changes the order and the headings. It does not add a hotel, a date, or a
            rate. Approved collaborations stay off the share link until you pick one.
          </p>
        </div>
        <form action={onTemplate} className="space-y-3">
          <ul className="space-y-2">
            {PORTFOLIO_TEMPLATES.map((template) => (
              <li key={template}>
                <label className="flex items-start gap-2 text-sm text-text">
                  <input
                    type="radio"
                    name="template"
                    value={template}
                    defaultChecked={portfolio.template === template}
                    className="mt-1"
                  />
                  <span>
                    {PORTFOLIO_TEMPLATE_LABELS[template as PortfolioTemplate]}
                    <span className="mt-0.5 block text-xs text-muted">
                      {templateHelp(template)}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <button
            type="submit"
            className="inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
          >
            Save layout
          </button>
          {message ? (
            <p className="text-sm text-text" role="status">
              {message}
            </p>
          ) : null}
        </form>
      </section>

      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-text">Suggestions</h2>
          <p className="max-w-prose text-sm text-muted">
            These are confirmed collaborations you recorded. Nothing here is on the share link until
            you approve it. A Gmail detection is not a suggestion.
          </p>
        </div>
        {suggestions === "empty" ? (
          <p className="max-w-prose text-sm text-muted">{PORTFOLIO_COPY.emptySuggestions}</p>
        ) : (
          <ul className="space-y-3">
            {portfolio.suggestions.map((entry) => (
              <li
                key={entry.collaborationId}
                className="space-y-3 rounded-[var(--radius-app)] border border-border bg-surface p-4"
              >
                <EntryFacts entry={entry} />
                <DecisionButtons
                  entry={entry}
                  primary={publishPortfolioEntry}
                  primaryLabel="Show on share link"
                  secondary={dismissPortfolioEntry}
                  secondaryLabel="Not this one"
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-text">On the share link</h2>
        {portfolio.template === null && portfolio.published.length > 0 ? (
          <p className="max-w-prose text-sm text-muted">
            These are approved, and they stay off the share link until you pick a layout.
          </p>
        ) : null}
        {portfolio.published.length === 0 ? (
          <p className="max-w-prose text-sm text-muted">No collaboration is approved yet.</p>
        ) : (
          <ul className="space-y-3">
            {portfolio.published.map((entry) => (
              <li
                key={entry.collaborationId}
                className="space-y-3 rounded-[var(--radius-app)] border border-border bg-surface p-4"
              >
                <EntryFacts entry={entry} />
                <DecisionButtons
                  entry={entry}
                  primary={withdrawPortfolioEntry}
                  primaryLabel="Remove from share link"
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {portfolio.dismissed.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-text">Dismissed</h2>
          <ul className="space-y-3">
            {portfolio.dismissed.map((entry) => (
              <li
                key={entry.collaborationId}
                className="space-y-3 rounded-[var(--radius-app)] border border-border bg-surface p-4"
              >
                <EntryFacts entry={entry} />
                <DecisionButtons
                  entry={entry}
                  primary={withdrawPortfolioEntry}
                  primaryLabel="Suggest again"
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {portfolio.withheld.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-text">No longer confirmed</h2>
          <p className="max-w-prose text-sm text-muted">
            These collaborations were cancelled, so they are not on the share link. Cancelling is
            not a confirmed collaboration.
          </p>
          <ul className="space-y-3">
            {portfolio.withheld.map((entry) => (
              <li
                key={entry.collaborationId}
                className="space-y-3 rounded-[var(--radius-app)] border border-border bg-surface p-4"
              >
                <EntryFacts entry={entry} />
                <DecisionButtons
                  entry={entry}
                  primary={withdrawPortfolioEntry}
                  primaryLabel="Remove"
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function templateHelp(template: PortfolioTemplate): string {
  if (template === "journey") return "Newest end date first. The date leads each block.";
  if (template === "destinations") return "Grouped by the hotel’s destination. No rank.";
  return "The hotel name leads each block. Same dates, no score.";
}
