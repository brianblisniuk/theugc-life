# E02 — Product coherence

**Status:** Binding work order for PR #59. Do not merge.  
**Base:** `main` `6b59318bbe33897a5204f42fa2292eccaf6d13a7` (merge of PR #58, D06)  
**Branch:** `cursor/e02-product-coherence-7b10`  
**Migration:** none.

## Principal question

How does one authenticated shell connect Home, Trips, Pipeline, Inbox, Collaborations, Discover, and Hotel Detail without a second information architecture?

## Locked reading used by this implementation

D081 (Proposed) is the simplest reading. PRD §6 stays the primary bar: Home, Discover, Pipeline, Trips, Profile. Inbox and Collaborations are pipeline surfaces (`surface=inbox`, `surface=collaborations`), not new primary items and not new tables. Hotel Detail breadcrumbs follow an allowlisted `from` query. Unknown values fall back to Discover. The trip crumb is labeled "Trip" and only links when the id is a UUID.

The Google map (D079) is unchanged. A missing key still renders no map and no error. Navigation does not start a Gmail sync (D076). Existing RLS and authorization checks stay where they are.

Empty and error copy is left for the parallel E03 block.

## Out of scope

Schema, migrations, permissions, data semantics, new primary navigation items, onboarding, and empty/error/recovery copy.
