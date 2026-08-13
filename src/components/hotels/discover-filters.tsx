/**
 * Discover search + filter controls (PRD §7.2, §22).
 *
 * Implemented as a plain GET form targeting /app/discover, so filtering happens
 * server-side, the state lives in the URL (shareable/bookmarkable), and the
 * whole control set works with the keyboard and without client JavaScript
 * (DESIGN_SYSTEM.md §7). No dataset is loaded into the browser to filter.
 */
import Link from "next/link";

import {
  HOTEL_TYPE_FILTERS,
  STAR_FILTERS,
  VERIFICATION_FILTERS,
  hotelTypeLabel,
  verificationLabel,
  type DiscoverQuery,
} from "@/lib/hotels/filters";

const FIELD =
  "w-full rounded-[var(--radius-app)] border border-border bg-background px-3 py-2 text-sm text-text";
const LABEL = "block text-xs font-medium text-muted";

export function DiscoverFilters({
  query,
  showClear,
}: {
  query: DiscoverQuery;
  showClear: boolean;
}) {
  return (
    <form
      action="/app/discover"
      method="get"
      role="search"
      aria-label="Search hotels"
      className="space-y-3 rounded-[var(--radius-app)] border border-border bg-surface p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1 lg:col-span-2">
          <label className={LABEL} htmlFor="discover-q">
            Search hotels or destinations
          </label>
          <input
            id="discover-q"
            name="q"
            type="search"
            defaultValue={query.q ?? ""}
            placeholder="e.g. Four Seasons, Dubai"
            className={FIELD}
          />
        </div>

        <div className="space-y-1">
          <label className={LABEL} htmlFor="discover-type">
            Hotel type
          </label>
          <select id="discover-type" name="type" defaultValue={query.type ?? ""} className={FIELD}>
            <option value="">Any type</option>
            {HOTEL_TYPE_FILTERS.map((t) => (
              <option key={t} value={t}>
                {hotelTypeLabel(t)}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label className={LABEL} htmlFor="discover-stars">
            Minimum stars
          </label>
          <select
            id="discover-stars"
            name="stars"
            defaultValue={query.minStars ? String(query.minStars) : ""}
            className={FIELD}
          >
            <option value="">Any rating</option>
            {STAR_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s}+ stars
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label className={LABEL} htmlFor="discover-verified">
            Editorial status
          </label>
          <select
            id="discover-verified"
            name="verified"
            defaultValue={query.verification ?? ""}
            className={FIELD}
          >
            <option value="">Any status</option>
            {VERIFICATION_FILTERS.map((v) => (
              <option key={v} value={v}>
                {verificationLabel(v)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          className="rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
        >
          Apply filters
        </button>
        {showClear ? (
          <Link href="/app/discover" className="text-sm text-muted underline hover:text-text">
            Clear filters
          </Link>
        ) : null}
      </div>
    </form>
  );
}
