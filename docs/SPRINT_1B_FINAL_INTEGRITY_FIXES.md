# Sprint 1B Final Integrity Fixes

Status: approved blocking fixes before PR. Implement only F7-F10, add regression tests, run migrations/lint/typecheck/tests/build, commit/push, and stop. Do not start Sprint 1C or touch real datasets.

## F7 — Full manifest snapshot
`applyReview` must require the manifest bundle-key set to equal exactly the authoritative set of reviewable property keys for the batch. Reject missing, extra, or duplicate bundles. A partial manifest must never leave an old property approval silently active.

Test: two reviewed properties A/B, then reapply a manifest containing only A; apply must fail and persisted state remain unchanged.

## F8 — Child override snapshot semantics
On review re-apply, persisted `import_row_reviews` for this batch must exactly match current `childOverrides`. Inside the review transaction, remove prior overrides for child rows in this batch, then write only current manifest overrides. Never affect another batch.

Test: inferred contact explicitly included; reapply complete manifest with override removed; DB override disappears and default policy defers the contact. Other batch overrides remain.

## F9 — Serialize review and apply-promotion
`applyReview` and `promoteBatch(...,{apply:true})` for the same batch must not overlap or operate on mixed review snapshots. Use a PostgreSQL session advisory lock keyed deterministically by batchId (or equally strong DB-backed serialization). `applyReview` acquires it before batch/review reads and releases in finally. Apply-promotion acquires the same lock before loading review state and holds it across all per-bundle transactions, releasing in finally. Keep existing row locks.

Test with two DB sessions that same-batch review mutation and apply-promotion serialize; different batches should not share the lock.

## F10 — Country/destination consistency
Canonical hotel geography must satisfy: when both are known, hotel country equals canonical destination country.

Destination resolution: exact `destination_slug` with a known staged country that conflicts with the canonical destination country must not resolve cleanly.

`approve_create`: load chosen destination country. If staged and destination countries are both known and differ, fail with zero canonical mutation. If staged country is null and destination country known, create hotel using destination country.

`approve_match`: never fill a hotel country that conflicts with its canonical destination. If hotel country is null and destination country known, prefer destination country; report conflicting staged country without writing it.

Tests: bali/ID slug + AR source does not cleanly resolve; cross-country create fails; null source country + ID destination creates ID; match cannot fill AR into ID destination; compatible cases still work.
