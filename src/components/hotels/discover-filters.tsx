"use client";

import { useEffect, useState } from "react";

import {
  ACTIVITY_FILTERS,
  HOTEL_TYPE_FILTERS,
  STAR_FILTERS,
  VERIFICATION_FILTERS,
  hotelTypeLabel,
  verificationLabel,
  type DiscoverQuery,
} from "@/lib/hotels/filters";
import { activityLabel } from "@/lib/hotels/intelligence";
import type { DiscoverCountryOption, DiscoverDestinationOption } from "@/lib/hotels/queries";
import { METRIC_IDS, METRIC_LAYERS, METRIC_TITLES } from "@/lib/metrics/contract";
import { sortOptionLabel } from "@/lib/screens/discover-sort";
import { DISCOVER_SEARCH_LABEL, DISCOVER_SEARCH_PLACEHOLDER } from "@/lib/screens/copy";

export function DiscoverFilters({
  query,
  destinations,
  countries,
  catalogFailed,
  tripId = null,
}: {
  query: DiscoverQuery;
  destinations: readonly DiscoverDestinationOption[];
  countries: readonly DiscoverCountryOption[];
  catalogFailed: boolean;
  tripId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const destinationKnown = destinations.some(
    (destination) => destination.slug === query.destination,
  );
  const countryKnown = countries.some((country) => country.code === query.country);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <form action="/app/discover" method="get" role="search" className="ux-stack">
      {tripId ? <input type="hidden" name="trip" value={tripId} /> : null}
      {catalogFailed ? (
        <p className="ux-meta" role="status">
          The destination list couldn’t be loaded. You can still search by name.
        </p>
      ) : null}
      <div className="ux-toolbar">
        <div className="ux-field ux-search">
          <label className="ux-label" htmlFor="discover-q">
            {DISCOVER_SEARCH_LABEL}
          </label>
          <input
            id="discover-q"
            name="q"
            type="search"
            defaultValue={query.q ?? ""}
            placeholder={DISCOVER_SEARCH_PLACEHOLDER}
            autoComplete="off"
            className="ux-control"
          />
        </div>
        <div className="ux-field ux-select">
          <label className="ux-label" htmlFor="discover-destination">
            Destination
          </label>
          <select
            id="discover-destination"
            name="destination"
            defaultValue={query.destination ?? ""}
            className="ux-control"
          >
            <option value="">All destinations</option>
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
        <div className="ux-field ux-select">
          <label className="ux-label" htmlFor="discover-type">
            Hotel type
          </label>
          <select
            id="discover-type"
            name="type"
            defaultValue={query.type ?? ""}
            className="ux-control"
          >
            <option value="">All types</option>
            {HOTEL_TYPE_FILTERS.map((type) => (
              <option key={type} value={type}>
                {hotelTypeLabel(type)}
              </option>
            ))}
          </select>
        </div>
        <div className="ux-anchor">
          <button
            type="button"
            className="ux-btn"
            aria-expanded={open}
            aria-controls="discover-more"
            onClick={() => setOpen((value) => !value)}
          >
            More filters
          </button>
          {open ? (
            <div className="ux-popover" id="discover-more" role="dialog" aria-label="More filters">
              <h2 className="ux-name">More filters</h2>
              <div className="ux-field">
                <label className="ux-label" htmlFor="discover-country">
                  Country
                </label>
                <select
                  id="discover-country"
                  name="country"
                  defaultValue={query.country ?? ""}
                  className="ux-control"
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
              <div className="ux-field">
                <label className="ux-label" htmlFor="discover-stars">
                  Classification
                </label>
                <select
                  id="discover-stars"
                  name="stars"
                  defaultValue={query.minStars ? String(query.minStars) : ""}
                  className="ux-control"
                >
                  <option value="">Any published classification</option>
                  {STAR_FILTERS.map((stars) => (
                    <option key={stars} value={stars}>
                      {stars}-star
                    </option>
                  ))}
                </select>
              </div>
              <div className="ux-field">
                <label className="ux-label" htmlFor="discover-verified">
                  Editorial verification
                </label>
                <select
                  id="discover-verified"
                  name="verified"
                  defaultValue={query.verification ?? ""}
                  className="ux-control"
                >
                  <option value="">Any status</option>
                  {VERIFICATION_FILTERS.map((status) => (
                    <option key={status} value={status}>
                      {verificationLabel(status)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="ux-field">
                <label className="ux-label" htmlFor="discover-activity">
                  Creator activity
                </label>
                <select
                  id="discover-activity"
                  name="activity"
                  defaultValue={query.activity ?? ""}
                  className="ux-control"
                >
                  <option value="">Any disclosed activity</option>
                  {ACTIVITY_FILTERS.map((level) => (
                    <option key={level} value={level}>
                      {activityLabel(level)}
                    </option>
                  ))}
                </select>
              </div>
              <label
                className="ux-meta"
                style={{ display: "flex", gap: 8, minHeight: 44, alignItems: "center" }}
              >
                <input
                  type="checkbox"
                  name="collaboration"
                  value="observed"
                  defaultChecked={query.collaboration === "observed"}
                />
                Creator collaboration observed
              </label>
              <button type="submit" className="ux-btn ux-btn-primary">
                Apply
              </button>
            </div>
          ) : (
            <>
              {query.country ? <input type="hidden" name="country" value={query.country} /> : null}
              {query.minStars ? (
                <input type="hidden" name="stars" value={String(query.minStars)} />
              ) : null}
              {query.verification ? (
                <input type="hidden" name="verified" value={query.verification} />
              ) : null}
              {query.activity ? (
                <input type="hidden" name="activity" value={query.activity} />
              ) : null}
              {query.collaboration ? (
                <input type="hidden" name="collaboration" value={query.collaboration} />
              ) : null}
            </>
          )}
        </div>
        <button type="submit" className="ux-btn ux-btn-primary">
          Apply
        </button>
      </div>
      {query.rank ? <input type="hidden" name="rank" value={query.rank} /> : null}
    </form>
  );
}

/** Sort sits beside the results heading. Changing it keeps the current filters. */
export function DiscoverSort({ query, tripId }: { query: DiscoverQuery; tripId: string | null }) {
  return (
    <form action="/app/discover" className="v12-row">
      {query.q ? <input type="hidden" name="q" value={query.q} /> : null}
      {query.type ? <input type="hidden" name="type" value={query.type} /> : null}
      {query.minStars ? <input type="hidden" name="stars" value={String(query.minStars)} /> : null}
      {query.verification ? (
        <input type="hidden" name="verified" value={query.verification} />
      ) : null}
      {query.country ? <input type="hidden" name="country" value={query.country} /> : null}
      {query.destination ? (
        <input type="hidden" name="destination" value={query.destination} />
      ) : null}
      {query.activity ? <input type="hidden" name="activity" value={query.activity} /> : null}
      {query.collaboration ? (
        <input type="hidden" name="collaboration" value={query.collaboration} />
      ) : null}
      {tripId ? <input type="hidden" name="trip" value={tripId} /> : null}
      <label className="v12-field" htmlFor="discover-rank">
        <span>Sort</span>
        <select
          id="discover-rank"
          name="rank"
          defaultValue={query.rank ?? ""}
          className="v12-sort"
          onChange={(event) => event.currentTarget.form?.requestSubmit()}
        >
          <option value="">Most relevant</option>
          {METRIC_IDS.map((metric) => (
            <option key={metric} value={metric}>
              {sortOptionLabel(metric, METRIC_TITLES[metric], METRIC_LAYERS[metric] === "premium")}
            </option>
          ))}
        </select>
      </label>
    </form>
  );
}
