# Skill: release-readiness

Final gate before `MERGE DECISION REQUIRED`. Run by the Release Auditor on the exact head.

Local gates (box):

```bash
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
sudo service postgresql start      # installed on the box; CI uses postgres:16
npm ci && npm run lint && npm run typecheck && npm run build && npm test
npm run autopilot:validate
```

`npm test` without `TEST_DATABASE_URL` skips every DB suite. That is NOT evidence for RLS/RPC changes.

Checks:

1. `gh pr view <n> --json headRefOid,mergeStateStatus`: head equals the audited SHA; state `CLEAN`.
2. `gh api repos/brianblisniuk/theugc-life/commits/<head>/check-runs`: `verify` success at that exact SHA.
3. The diff matches the work order's scope. No future-scope work, and no edits to historical D-entries or frozen evaluation results.
4. Security+DB Auditor verdict comment exists for this head (PASS).
5. Negative-control table is present (`negative-control-generator`).
6. State/tracker updated in this PR (`docs-state-sync`).
7. Known flakes are recorded, not silently re-run more than once.

Output: post the Release verdict comment (format in `.grok/workflows/pr-cycle.md`), then notify `MERGE DECISION REQUIRED — PR #X — HEAD <sha>`.
