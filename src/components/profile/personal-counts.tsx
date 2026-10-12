/**
 * Private counts. Each figure is an integer. A failed load is not shown as zero.
 */
import { personalCountEntries } from "@/lib/profile/contract";
import type { PersonalCountsLoad } from "@/lib/profile/contract";

export function PersonalCounts({ load }: { load: PersonalCountsLoad }) {
  if (load.status === "error" || load.status === "not_found") {
    return (
      <section className="space-y-2" aria-labelledby="personal-counts-heading">
        <h2 id="personal-counts-heading" className="text-lg font-semibold text-text">
          Your counts
        </h2>
        <p className="max-w-prose text-sm text-muted">
          Your counts couldn’t be loaded. This is not zero.
        </p>
      </section>
    );
  }

  const entries = personalCountEntries(load.counts);
  return (
    <section className="space-y-2" aria-labelledby="personal-counts-heading">
      <h2 id="personal-counts-heading" className="text-lg font-semibold text-text">
        Your counts
      </h2>
      <p className="max-w-prose text-sm text-muted">
        Counts of what you recorded. A zero means none recorded. These are not rates.
      </p>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((entry) => (
          <div
            key={entry.label}
            className="rounded-[var(--radius-app)] border border-border bg-surface p-4"
          >
            <dt className="text-xs font-medium text-muted">{entry.label}</dt>
            <dd className="mt-1 text-2xl font-semibold text-text">{entry.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
