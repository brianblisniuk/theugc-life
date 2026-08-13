# Sprint 1C — Persistent Apply Prompt

Work only on `claude/sprint-1c-persistent-apply`.

Read `docs/SPRINT_1C_PERSISTENT_PREFLIGHT.md` and the existing Sprint 1C/1B import specifications in full.

## Objective
Prepare and execute the persistent-database preflight for the approved Dubai Pilot 30. Do NOT run the real canonical `--apply` in this task.

## Safety implementation first
Make the smallest durable changes needed so a real-data apply cannot silently use `TEST_DATABASE_URL` or an accidental local target:

1. Add a reusable persistent-target preflight helper and CLI command (for example `import:db-preflight`). It must never print secrets or raw contact data.
2. Any CLI path that executes `import:promote --apply` must require an explicit `DATABASE_URL`; it must not fall back to `TEST_DATABASE_URL`.
3. By default, refuse `--apply` when the parsed DB host is localhost, loopback, or the standard local Supabase target. Preserve synthetic/library tests without weakening this production CLI guard.
4. Add regression tests for missing `DATABASE_URL`, TEST-only configuration, local-target rejection, secret redaction, and valid remote-target classification. Use invented connection strings only.
5. Do not change promotion semantics, canonical schema, review policy, or the pilot data.

Run lint, typecheck, full tests, build, and format after the safety change.

## Then execute the preflight
Inspect the current Claude Code environment without revealing secrets.

- Determine whether an explicit remote `DATABASE_URL` is actually configured.
- Never print its password or full URL.
- Inspect the target read-only first and follow every stop rule in `SPRINT_1C_PERSISTENT_PREFLIGHT.md`.

If no approved persistent target is configured, STOP with `PERSISTENT_DATABASE_NOT_CONFIGURED` and state exactly what configuration is missing. Do not create a remote project automatically and do not use the local preview DB as a substitute.

If the persistent target is ready, place/use the private `theugc-life_Sprint1C_Dubai_Pilot_30.xlsx` locally under the existing gitignored raw-data path, verify its SHA256, and re-run on that SAME remote DB:

`inspect -> stage -> dry-run -> full review snapshot -> review apply -> promotion preview`

Do not run real-data `import:promote --apply`. Return the complete remote preflight + preview report and stop for external approval.

Commit and push only code/tests/docs changes. Never commit private data, manifests, reports, secrets, or connection details. Do not open a PR automatically. Do not begin Sprint 2.