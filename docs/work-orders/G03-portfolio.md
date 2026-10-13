# G03 — Portfolio polished

**Status:** Binding work order. D125 is Accepted for this block. Do not merge.  
**Base:** `main` `6c77347ce5cbc9e57c4d675f0a5bc636474a0c16` (merge of PR #75, G02). F04 is `0a69413beb338c7910d8b9473693a3db7136a6aa`.  
**Branch:** `cursor/g03-portfolio-9c32`  
**PR:** #76 (draft). Do not merge.  
**Decisions:** D125. D126–D129 were not needed. D115–D116 stay with G02. D120–D124 stay with H01.  
**Migrations:** `0073_creator_portfolio.sql` and `0074_creator_portfolio_share.sql`.

One PR for the whole block. Do not merge.

## Principal question

How does a creator turn confirmed collaborations into a travel portfolio a hotel can see, without publishing anything they did not approve, and without changing the hotel share link except to render that portfolio?

## Sources

D045 (confirmed is `agreed`, `scheduled`, `active`, or `completed`; cancelled is not). D088–D091 (past list stays private; the share link is per-field opt-in). D096 and D086–D088 v2 (the social profile has no hotel names and no automatic public portfolio). D107 (a Gmail detection is not a collaboration, even after confirm). D098 (no written tier means Free, and owner-only stays owner-only). Canon v1.1 G03. PRD §7.6 describes a public portfolio; D096 already closed that route as the social card, which this block does not widen.

## Locked reading

- Three layouts: `journey`, `destinations`, `highlights`. They change arrangement only. No template means the share link omits `portfolio`.
- Suggestions are the caller’s confirmed collaboration rows. They are not stored. Gmail suggestion rows are never selected.
- `published` is the explicit approval. `dismissed` hides the suggestion and stays off the link. A missing profile is JSON null. An empty array is a successful read.
- The share object adds hotel name, destination, type, status, and dates. It does not add compensation, contacts, notes, or private values. D090 fields, including compensation on a marked past collaboration, stay as they were.
- `/creators/[username]` is unchanged. `public_profile_enabled` and `portfolio_visibility` are not written.
- The editor is Free and owner-only. User A cannot read or write User B’s rows. Anon has no table privilege. The public read remains `read_creator_share_profile`.

## In scope

- Owner portfolio page at `/app/profile/portfolio`.
- Tables, RLS enabled and not forced, and the share-link addition.
- Real Postgres tests for the cases above.

## Out of scope

G02 deliverable reminders (`0069`, merged; `0070` unused). F04 home (`src/lib/home/*`) — a later block can mention pending approvals there without publishing them. G01 contract drafts (`src/lib/contracts/*`) — an agreement draft is not a portfolio entry. H01 ranking, signals, and Discover — portfolio order is date or destination name, not a rank. No send, no model, no production deploy, no production database change.

## Follow-ups left in place

- Home does not list portfolio suggestions. That would edit `src/lib/home`, which F04 owns.
- Deliverable reminders are not portfolio media. That would edit G02’s migrations.
- Contract drafts are not copied into the portfolio.
- Discover does not rank portfolio hotels.
