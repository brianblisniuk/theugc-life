# CLAUDE.md

Before doing repository work, read and follow [`docs/WORKING_METHOD.md`](docs/WORKING_METHOD.md).

Then read, in order:

1. [`docs/DECISIONS.md`](docs/DECISIONS.md)
2. the relevant domain contract/spec
3. [`docs/PRD.md`](docs/PRD.md)
4. [`docs/MASTER_PLAN.md`](docs/MASTER_PLAN.md) / [`docs/MASTER_PLAN_TRACKER.md`](docs/MASTER_PLAN_TRACKER.md) when sequencing matters

For implementation work:

- Work from the exact base SHA/branch named in the prompt.
- One scoped question per implementation block/PR.
- Do not invent missing product decisions; stop and report the blocker/options/recommendation.
- Respect explicit `PRESERVE`, `NOT IN THIS PR`, provenance, security, replay and canonical-safety constraints.
- Add semantic/adversarial tests, not just happy-path tests.
- Run the requested format/lint/typecheck/test/build/migration/security gates.
- Report the exact SHA, real recomputed counts and ambiguities refused.
- Do **not** self-merge unless explicitly instructed.
- For audit corrections, stay on the SAME branch and SAME PR unless told otherwise.
- Expect an independent external audit of the real GitHub head after every material implementation round.

The canonical method is `docs/WORKING_METHOD.md`; do not duplicate or silently redefine it here.
