# D01 — Trips

**Status:** Binding work order for this PR. Awaiting independent audit. Do not merge.  
**Base:** `main` `187af6a3d4b4b5f6db1ec6d1f77ca975e791f852`  
**Branch:** `feat/d01-trips`  
**Migration:** `0046_trips_context.sql`  
0045 is `0045_gmail_commercial_meaning_followups.sql`, merged with B07.1 (PR #51). This block keeps 0046. PR #53 (B08) uses 0047.

One PR for the whole block. Do not merge.

## Principal question

How does a creator keep one private trip context — destination, dates, shortlist, and the pipeline and collaborations linked to that trip — without a second pipeline or a second entitlement system?

## Sources

PRD §7.5, PRD §5.1 and §5.3.1 (Free: 1 active trip; Destination Pass: approved scope; Pro: yes), D014, D023, D042, D056, D062, migration `0005_trips_and_pipeline.sql`, `FREE_LIMITS.activeTrips`, the existing entitlement helpers `_has_active_pro` and `_has_active_destination_access`.

## Locked reading used by this implementation

No new commercial number and no new status were added.

- An **active trip** for `FREE_LIMITS.activeTrips` is a trip whose status is `planning`, `upcoming`, or `active`. `completed` and `cancelled` are the terminal statuses already in the schema and do not consume the allowance. This is the trip-status reading of D023 (non-terminal consumes the allowance; terminal is history).
- The allowance number is the existing `FREE_LIMITS.activeTrips` (1), passed into the RPC. It is not a SQL literal.
- Exemption uses the existing helpers the pipeline RPCs already use. Active Pro is exempt worldwide. An active destination entitlement exempts a trip in that destination or a descendant. A non-exempt create counts every active trip, the same way `save_hotel_to_pipeline` counts every open relationship when the hotel being saved is outside the entitlement.
- A trip that already counts stays editable after the entitlement is revoked. Expiry does not delete trips (D014) and does not call `delete_trip`.
- Moving a terminal trip back into a counting status re-checks the allowance.
- Moving a counting trip from an exempt destination onto a destination that is not exempt re-checks the same allowance (D056). The count is the creator's other counting trips. A Free user can still retarget the one trip that already occupies their slot. After the entitlement is revoked, a trip that already counts stays editable, including its destination (D014).
- `trips.creator_id` cannot change while a pipeline item owned by a different creator is linked to that trip.
- A row in `public.hotels` is the canonical published hotel (D062). Shortlist rejects any other id.
- Summary counts are unknown (JSON null) when the trip has no linked pipeline rows. Unknown is not zero. A real zero is returned only when linked rows exist and that bucket is empty.
- `follow_up` is not a reply. A confirmed collaboration is a collaboration in `agreed`, `scheduled`, `active`, or `completed` (D045). `cancelled` is not counted as confirmed.
- These RPCs never write `visibility`. The column default remains `private`. Public portfolio exposure is out of scope.

## In scope

- Trip create, update, and delete through server actions, Zod, and service-role RPCs.
- Shortlist add/remove of canonical hotels.
- Link and unlink of the caller's own pipeline items, with a database trigger that rejects a cross-creator `trip_id`.
- Trip workspace summary and a Discover link filtered by the trip destination (the destination and its descendants).
- Client `INSERT`/`UPDATE`/`DELETE` on `trips` and `trip_hotels` revoked. RLS policies remain.
- Tests: User A/B isolation, cross-tenant linking, Free allowance, summary derivation, ACL matrix for the new functions.

## Out of scope

Gmail materialization into trips, public portfolio exposure, AI, sending, payments, new prices, new limits, Rebill.
