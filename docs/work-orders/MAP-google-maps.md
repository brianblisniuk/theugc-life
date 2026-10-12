# MAP — Google Maps on Discover and Hotel Detail

**Status:** Binding work order. Do not merge from automation.
**Base:** `main` `eb136190f676e9201b6b39de4b570d51e52da73d` (merge of PR #53, B08)
**Branch:** `cursor/map-google-js-7ba9`
**Decision:** D079
**Migration:** none. `0049` stays unused.

One PR for the whole block, including the tracker and autopilot state. Do not merge.

## Principal question

How does Discover show the published hotels on the current filtered page, and Hotel Detail show that one hotel, on a Google map, without a key in the repo and without sending private creator data to Google?

## Locked reading

- Provider is the Maps JavaScript API. The public key is `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`. It is read from the environment. It is never hardcoded. `.env.example` has an empty placeholder.
- A missing or blank key, or a failed script load, renders no map and no error. Tests pass with no key by mocking the loader.
- Discover pins are the hotels `searchHotels` already returned for the current filters and page. The map does not load the rest of the catalog (PRD §22). The list and the map are the same set.
- Hotel Detail has one pin, from the published hotel the page already loaded.
- A pin exists only for a row that passes the publication predicate (D054, D062). Coordinates are not copied onto the card.
- Free, Pass, and Pro share one inventory (D049). The map does not select premium intelligence, contacts, pipeline, or trips.
- The script URL is `https://maps.googleapis.com/maps/api/js` with `key`, `v`, and `callback` only. Marker options are `{ map, position }`. The script referrer is the origin only.
- No migration, no production deploy, and no Netlify env change.

## Out of scope

Geocoding, Places, clustering, a Cloud Map ID, Advanced Markers, and any change to premium gating.
