# D09 — Creator profile shareable with hotels

**Status:** Binding work order. D089–D091 are Accepted (Brian, 13 Oct 2026). Do not merge.  
**Base:** `main` `d030cd0329c8b1e30afcdd14a72485174edcd9f5` (merge of PR #61, D08).  
**Branch:** `cursor/d09-creator-share-link-6270`  
**PR:** #63  
**Decisions:** D089, D090, D091 — Accepted. D086–D088 stay Proposed. D083–D085 are not used.  
**Migration:** `0053_creator_share_link.sql`. `0051` is on main from E04 (PR #62, `dc5979e`) and is not edited. `0052` is not edited.

One PR for the whole block, including this work order and the state files. Do not merge.

## Principal question

How does a creator share a profile with a hotel, and stop that share, without showing anything the creator did not opt in to?

## Sources

D089–D091, Accepted (Brian, 13 Oct 2026). D086 left the field keys open and did not issue a token. PRD §7.6 names a public portfolio at `/creators/[username]`; that route is not this link. `share_cards` stores a raw token for a different surface and is not reused. D072: a machine reading is not human truth, so audience figures are labeled self-reported. D078: unknown compensation is not zero.

## Locked reading

- One active link per creator. The token is 32 random bytes, hex-encoded. Only the SHA-256 digest is stored. Create and rotate return the token once. View shows state, not the token.
- Rotate and revoke take effect in the same transaction. Optional `expires_at`. Invalid, revoked, rotated, and expired tokens return the same `not_found`.
- Public page `/p/[token]`, no auth, `noindex`, `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`. A per-address limit runs before the lookup. The lookup compares a 32-byte digest.
- Public read is `read_creator_share_profile`, security definer, `search_path` empty. Anon is granted execute on that function only. Anon has no privilege on the new tables. Existing table RLS is not widened for anon.
- Field keys: `bio`, `niche`, `social_links`, `audience`, `past_collaborations`, `content_examples`, `compensation`. Private by default. A field that is off is absent on the next read.
- Past collaborations and content examples also require an explicit mark. Compensation appears only on a marked past collaboration, and only when that field is opted in. Null followers, null engagement, and a missing compensation amount are unknown, never zero.
- Audience attribution is `self_reported`. The page says it is not verified.

## In scope

- Create, view, rotate, and revoke on Profile.
- Per-field opt-in, self-reported audience, collaboration marks, and deliverable marks.
- `/p/[token]`.
- Real Postgres tests for the acceptance cases in the block prompt.

## Out of scope

Sending the link by email, hotel accounts, verification badges, view analytics, AI, new providers, scopes, secrets, payments, and production deploy. `/creators/[username]` and `share_cards` are unchanged. D086–D088 are not accepted by this block.
