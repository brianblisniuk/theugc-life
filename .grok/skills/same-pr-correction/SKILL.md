# Skill: same-pr-correction

Fix audit findings on the SAME branch/PR. Never open a second PR for findings on an open PR.

Steps:

1. Read each finding from the auditor's PR comment (each is tied to a head SHA).
2. `git fetch origin && git checkout <branch> && git pull --ff-only`. Never force-push; the ruleset rejects non-fast-forward.
3. For each BLOCKING finding: write the failing test first (the negative control), then the fix. Confirm the test fails without the fix (`negative-control-generator`).
4. Local gates: `npm run lint && npm run typecheck && npm run build && npm test`, with `TEST_DATABASE_URL` set so DB suites run (see `release-readiness`).
5. Commit with message `fix(<scope>): address audit <finding-ids>` and push the branch.
6. Post a PR comment listing each finding → commit → test, with the new head SHA.
7. Request re-audit. A prior PASS does not carry over to a new head.

Stop: if a fix would change product semantics or weaken an invariant → `PRODUCT DECISION REQUIRED`.
