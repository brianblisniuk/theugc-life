# Sprint 1C — Persistent Database Preflight

Status: Approved gate before first canonical real-data apply.

## Purpose
The local Dubai pilot preview passed. The next step must target a persistent database deliberately. Never treat a local/test database as production canonical storage.

## Hard stop rules
1. `DATABASE_URL` must be explicitly present. For this workflow, do not fall back to `TEST_DATABASE_URL`.
2. Do not print credentials, passwords, full connection strings, service-role keys, or raw contact data.
3. Classify the target without secrets: remote vs local, database host class, database name if safe, and SSL mode. A localhost/loopback/local-Supabase target is NOT an approved persistent target.
4. If no explicit remote `DATABASE_URL` is available, STOP and report `PERSISTENT_DATABASE_NOT_CONFIGURED`.
5. Before any write, inspect migration/schema state. If the remote DB is missing required Sprint 0–1C schema/migrations or its state is ambiguous, STOP. Do not automatically repair or push remote migrations in this preflight.
6. Before any write, report aggregate baseline counts only: destinations, hotels, hotel_contacts, editorial_evidence, outreach_events, hotel_intelligence, destination_intelligence, import_batches. No PII.
7. Confirm canonical destinations `united-arab-emirates` and `dubai` exist with country AE and Dubai parented to UAE. If missing or inconsistent, STOP and report.
8. The private pilot XLSX remains gitignored and must never be committed.

## Required target report
Return:
- `DATABASE_URL`: present/absent only
- target classification: remote/local
- migration/schema readiness: ready/not-ready + evidence
- baseline aggregate counts
- UAE/Dubai destination readiness
- pilot file presence + SHA256 (hash only; no contents)
- decision: `READY_FOR_REMOTE_RESTAGE` or a specific blocking state

## If ready
Do not apply canonical data yet. Re-run the Dubai pilot against this SAME persistent database:
`inspect -> stage -> dry-run -> full review snapshot -> review apply -> promotion preview`

The remote preview must again confirm:
- 30 reviewable properties
- 0 rejected properties
- 30/30 resolve to Dubai
- 0 country conflicts
- no unsafe hotel match ambiguity
- inferred/probable contacts remain deferred by default
- zero canonical mutation during preview
- zero outreach/intelligence mutation

Then STOP for external approval. The later explicit apply run will use the exact remote batch reviewed here.