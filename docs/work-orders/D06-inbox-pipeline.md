# D06 — Inbox and pipeline stay one record

**Status:** Binding work order for PR #58. D080 is Accepted (Brian, 13 Oct 2026). Do not merge.  
**Base:** `main` `023a354c8592411e1ac85c818324589993f358a6` (merge of PR #57, MAP, D079).  
**Branch:** `cursor/d06-inbox-pipeline-774f`  
**Decision:** D080, Accepted (Brian, 13 Oct 2026). Renumbered from the proposed D079 after PR #57 took that number. The reading is unchanged.  
**Migration:** `0049_inbox_pipeline_unity.sql`

`0050` is D07 and is not edited. `0047` and `0048` are B08 and are not edited.

One PR for the whole block, including the tracker and autopilot state. Do not merge.

## Principal question

How does a stored Gmail thread and a pipeline cycle stay one relationship, so a machine reading cannot silently become CRM state and a creator's status cannot be overwritten by the next sync?

## Sources

D068 inclusion, D072 (machine interpretation is not human truth; a redirect is not a rejection; B07 writes no CRM row), D076 (B08 runs the existing local pipeline after new mail), D043 and D045 (close and won stay creator transitions). D078 does not invent an automatic thread-to-pipeline link. This work order does not add a product semantic beyond the accepted reading in D080. D079 is Google Maps and is not changed.

## Locked reading used by this implementation

- The creator names the mailbox and the stored provider thread. One pipeline item, one thread. One thread, one item.
- `pipeline_items.status` is the only CRM status. Refresh copies the current non-stale B07 label into suggestion rows and does not call a CRM transition.
- `mark_replied` accept requires a creator sentiment and uses the existing transition. `open_negotiation` accept uses `start_negotiation` and does not mark the deal won.
- `review_agreement` and `review_decline` record acknowledgement only. A redirect does not become `review_decline`. Acknowledgement does not close the cycle and does not create a collaboration.
- A dismissed or accepted suggestion for one machine attempt stays that way. A creator status that already covers the suggestion is `creator_overrides`.
- B08's stored pipeline calls refresh after commercial interpretation. No binding writes nothing and does not change the pipeline.

## In scope

- Tables, checks, RLS, writer gates, and service-role RPCs for the link, the reading, and the suggestions.
- Security-invoker read `read_pipeline_inbox_unity`.
- The hotel activity panel shows the link beside the creator's pipeline status.
- Tests: redirect is not a rejection, acknowledgement does not close or create a collaboration, creator sentiment is required, User A versus User B, ACL and empty `search_path`.

## Out of scope

New OAuth scopes, `gmail.send`, a new provider, automatic thread-to-hotel matching, ghosted-from-silence, model or vendor HTTP, public aggregates, production deploy, and any change to D072 machine semantics.
