# Workflow: large-pr-review

> **What this is:** a markdown runbook that Grok Bot agents follow by hand: the Orchestrator plus subagents running on the shared box, using `gh` authenticated as the owner. There is **no native workflow engine**. Nothing here executes automatically, and the `.grok/config.toml` flags are advisory. Hard enforcement is GitHub ruleset **24915605** on `main`: PR required, `verify` must pass, no force push, no deletion.

For PRs with more than ~1,000 changed lines or more than 20 files (e.g. PR #40: 70+ files).

## Steps

1. **Partition** (Orchestrator): `gh pr view <n> --json files` → group into slices: migrations/SQL, server code, scripts/CLIs, tests, docs/evaluation evidence.
2. **Parallel slice audits**: one independent auditor subagent per slice, each given only the PR number, head SHA and its file list. Each posts a slice verdict comment. Use the standard format and add `SLICE: <name>`.
3. **Cross-slice checks** (Security+DB Auditor):
   - every migration has tests;
   - every new public function/route is covered by the ACL matrix or route tests;
   - docs claims match code (e.g. "no provider call made" vs actual call sites);
   - frozen evidence files are append-only.
4. **Scope audit** (Release Auditor): diff vs work order. Out-of-scope work → BLOCKING; split it into another PR.
5. **Consolidation** (Orchestrator): one summary comment linking the slice verdicts. PASS only if every slice passes at the same head.

## Stop conditions

- The head moves during review → all slice verdicts are void; restart from step 2 for the changed slices, and re-run step 3.
- A slice cannot be reviewed without product context → `PRODUCT DECISION REQUIRED`, naming the specific question.
