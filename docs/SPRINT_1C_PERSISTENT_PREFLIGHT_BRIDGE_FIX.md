# Sprint 1C — Persistent Preflight Bridge Alias Fix

Status: Approved blocking correction before PR.

`classifyHost()` must treat known local/container bridge aliases as non-remote so a real `--apply` cannot target a developer-host Postgres through a container bridge.

At minimum block:
- `host.docker.internal`
- `gateway.docker.internal`
- `host.containers.internal`

Keep this lexical/deterministic. Do not add broad DNS resolution.

Add regression tests proving each alias is rejected and a normal public managed-database hostname remains remote.

This is part of the same preflight review as `SPRINT_1C_PERSISTENT_PREFLIGHT_REVIEW_FIXES.md`. Do not configure DATABASE_URL, create a remote project, re-stage the pilot, run `--apply`, or start Sprint 2.