# E01 — Discover + Hotel Detail (map deferred)

**Status:** Binding work order for PR #55. Awaiting independent audit. Do not merge.  
**Base:** `main` `989e7f020f07362113b3e9b00fd9950293808f10` (merge of PR #54, C01 docs only)  
**Branch:** `feat/e01-discover-hotel-detail`  
**Migration:** none. B08 PR #53 holds 0047 and 0048. D07 is draft PR #56 and holds 0050. This block does not add a migration.

One PR for the whole block. Do not merge.

## Principal question

How does a creator browse and open only published canonical hotels, with public intelligence and their own trip/pipeline state, without a map provider?

## Locked reading used by this implementation

- A row in `hotels` is the publication boundary (D062). Discover and Hotel Detail additionally require the conditions that are columns on that row: a destination, hospitality classification exactly 4 or 5, latitude and longitude inside the geographic ranges, and `active_status` in `active`, `temporarily_closed`, or `unknown`. `closed` is inactive and is not rendered. `unknown` stays visible because A05 publishes that status for "no known closure", which is not an inactive claim.
- Star and coordinate provenance stay on the publication receipt. Creators cannot read that table. This block does not add a security-definer function or a migration to expose it.
- There is no review score. A fractional `star_rating` is not labeled and is not rounded.
- Public card signals come only from `hotel_public_intelligence`. Null is withheld. A false collaboration flag is not shown as "no collaboration". Premium columns are not selected for a card.
- Premium intelligence and contacts still use `has_premium_hotel_access` and the existing panel states. No new price or limit.
- "Add to trip" posts to the existing D01 `addTripHotelAction`. The Free trip allowance stays inside that RPC.
- Pipeline and trip badges are read with the cookie-bound client. The viewer id passed to the assembler is `creator_profiles.id`, resolved from the session user (`auth.uid()`). A failed profile lookup or a failed row read renders no badge, not "not saved" and not "not on a trip". The assembler drops any row whose creator id is not that profile.
- The map slot is empty. No tile URL, no embed, no coordinate is sent to a provider. Coordinates are used only to apply the publication predicate and are not copied onto the card payload.
- No photograph is invented. The no-photo state is a designed empty mark (D064).
- Destination filters include the selected destination and its descendants (D013). Country matches `hotels.country_code`. Creator-activity and observed-collaboration filters match only disclosed public values. Collaboration types are not a Discover filter.

## Out of scope

Map or tile provider, new data sources, AI, payments, a media table, and any change to D072.
