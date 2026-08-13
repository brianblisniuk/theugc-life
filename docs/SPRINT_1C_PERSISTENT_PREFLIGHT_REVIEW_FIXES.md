# Sprint 1C — Persistent Preflight Review Fixes

Status: Approved blocking corrections before PR / persistent target setup.
Scope: persistent-target safety only.

## PF1 — Never surface connection details from driver errors

Problem:
`scripts/import/db-preflight.ts` catches the final error and prints `err.message`. PostgreSQL/Node network errors may include a hostname, IP, port, DNS target, certificate detail, or other connection metadata. The preflight contract says no secrets or connection details are printed.

Required change:
- Add a safe/redacted error reporting path for persistent-target preflight.
- Do not print arbitrary `pg`, DNS, TLS, socket, or URL parser messages to stdout/stderr in this CLI.
- User-facing failures should be categorical, for example `PERSISTENT_DATABASE_CONNECTION_FAILED`, `PERSISTENT_DATABASE_AUTH_FAILED`, or `PERSISTENT_DATABASE_PREFLIGHT_FAILED`, with no raw hostname, URL, username, password, token, IP, or port.
- Internal thrown errors may retain a cause for debugging/tests, but CLI output must remain redacted.
- The real `import:promote --apply` guard must likewise never log the raw connection string. Existing `redactedTarget` output is acceptable.

Regression tests:
- Simulated connection error containing `db.example.com:5432`, username and password must not expose any of those substrings in formatted CLI-safe output.
- Unknown arbitrary error message must not be echoed verbatim.

## PF2 — Preflight must prove versioned schema state, not only approximate shape

Problem:
`runPreflight()` currently checks a subset of required tables/columns plus one Sprint 1C index. A manually drifted or partially upgraded database can satisfy those checks while not representing the reviewed Sprint 0–1C migration state.

Required change:
- Add an explicit migration/schema-version verification to the persistent preflight.
- Prefer the repository's actual migration-history mechanism if one exists on the target. If `supabase_migrations.schema_migrations` is the deployed mechanism, read it read-only and verify the expected repository migration versions through `0017` are present in order.
- Do not assume a history-table shape blindly: inspect safely / handle absence explicitly.
- If the remote schema has the expected structural objects but migration history/version cannot be proven, the result must NOT be `READY_FOR_REMOTE_RESTAGE`; return a blocked state such as `BLOCKED_MIGRATION_STATE_UNVERIFIED`.
- Keep the existing structural checks as a second line of defense; migration history alone is not sufficient.
- Report only migration version identifiers / counts, never connection details.

If the project intentionally does not use a migration ledger on deployed environments, stop and report that architectural fact rather than inventing a new ledger in this fix. Do not create migration `0018` merely to satisfy this review without external approval.

Regression tests:
- Expected migration state + required structural objects => schema ready.
- Required objects present but migration history absent/unverifiable => blocked.
- Migration history missing `0017` => blocked.
- Migration history ahead/unknown => report explicitly; do not silently mark ready unless the repository's migration policy says this is valid.

## Verification

Run lint, typecheck, full tests, production build, format.

Do not configure a real DATABASE_URL yet.
Do not create a remote project.
Do not re-stage the pilot.
Do not run `--apply`.
Do not start Sprint 2.

Commit and push the correction and stop for external review.