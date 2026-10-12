/**
 * Discover search + filter controls (PRD §7.2, D013).
 *
 * GET form so the URL is the state. Destination is a catalogue record; the
 * search includes that record and its descendants. Country is the hotel's
 * country code. Creator activity and observed collaboration match only
 * disclosed public signals.
 */
import Link from "next/link";

import {
  ACTIVITY_FILTERS,
  COLLABORATION_FILTERS,
  HOTEL_TYPE_FILTERS,
  STAR_FILTERS,
  VERIFICATION_FILTERS,
  hotelTypeLabel,
  verificationLabel,
  type DiscoverQuery,
} from "@/lib/hotels/filters";
import { activityLabel } from "@/lib/hotels/intelligence";
import type { DiscoverCountryOption, DiscoverDestinationOption } from "@/lib/hotels/queries";

const FIELD = "w-full border border-border bg-background px-3 py-2 text-sm text-text";
const LABEL = "block text-xs font-medium text-muted";

export function DiscoverFilters({
  query,
  showClear,
  destinations,
  countries,
  catalogFailed,
}: {
  query: DiscoverQuery;
  showClear: boolean;
  destinations: readonly DiscoverDestinationOption[];
  countries: readonly DiscoverCountryOption[];
  catalogFailed: boolean;
}) {
  const destinationKnown = destinations.some(
    (destination) => destination.slug === query.destination,
  );
  const countryKnown = countries.some((country) => country.code === query.country);

  return (
    <form
      action="/app/discover"
      method="get"
      role="search"
      aria-label="Search hotels"
      className="space-y-3"
    >
      {catalogFailed ? (
        <p className="text-sm text-muted" role="status">
          The destination list couldn’t be loaded. You can still search by name.
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1 sm:col-span-2">
          <label className={LABEL} htmlFor="discover-q">
            Search hotels or destinations
          </label>
          <input
            id="discover-q"
            name="q"
            type="search"
            defaultValue={query.q ?? ""}
            placeholder="Hotel or destination"
            className={FIELD}
          />
        </div>

        <div className="space-y-1">
          <label className={LABEL} htmlFor="discover-destination">
            Destination
          </label>
          <select
            id="discover-destination"
            name="destination"
            defaultValue={query.destination ?? ""}
            className={FIELD}
          >
            <option value="">Any destination</option>
            {query.destination && !destinationKnown ? (
              <option value={query.destination}>{query.destination}</option>
            ) : null}
            {destinations.map((destination) => (
              <option key={destination.slug} value={destination.slug}>
                {destination.name}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label className={LABEL} htmlFor="discover-country">
            Country
          </label>
          <select
            id="discover-country"
            name="country"
            defaultValue={query.country ?? ""}
            className={FIELD}
          >
            <option value="">Any country</option>
            {query.country && !countryKnown ? (
              <option value={query.country}>{query.country}</option>
            ) : null}
            {countries.map((country) => (
              <option key={country.code} value={country.code}>
                {country.name}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label className={LABEL} htmlFor="discover-type">
            Hotel type
          </label>
          <select id="discover-type" name="type" defaultValue={query.type ?? ""} className={FIELD}>
            <option value="">Any type</option>
            {HOTEL_TYPE_FILTERS.map((type) => (
              <option key={type} value={type}>
                {hotelTypeLabel(type)}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label className={LABEL} htmlFor="discover-stars">
            Hospitality classification
          </label>
          <select
            id="discover-stars"
            name="stars"
            defaultValue={query.minStars ? String(query.minStars) : ""}
            className={FIELD}
          >
            <option value="">4- and 5-star</option>
            {STAR_FILTERS.map((stars) => (
              <option key={stars} value={stars}>
                {stars === "5" ? "5-star" : "4-star and above"}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label className={LABEL} htmlFor="discover-activity">
            Creator activity
          </label>
          <select
            id="discover-activity"
            name="activity"
            defaultValue={query.activity ?? ""}
            className={FIELD}
          >
            <option value="">Any disclosed activity</option>
            {ACTIVITY_FILTERS.map((level) => (
              <option key={level} value={level}>
                {activityLabel(level)}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label className={LABEL} htmlFor="discover-collaboration">
            Collaboration
          </label>
          <select
            id="discover-collaboration"
            name="collaboration"
            defaultValue={query.collaboration ?? ""}
            className={FIELD}
          >
            <option value="">Any</option>
            {COLLABORATION_FILTERS.map((value) => (
              <option key={value} value={value}>
                Observed collaboration
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
            {VERIFICATION_FILTERS.map((status) => (
              <option key={status} value={status}>
                {verificationLabel(status)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          className="bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
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
