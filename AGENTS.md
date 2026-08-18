# AGENTS.md

This repository uses a binding working method.

**Before any implementation, audit, refactor, migration, or product-logic change, read:**

1. [`docs/WORKING_METHOD.md`](docs/WORKING_METHOD.md)
2. [`docs/DECISIONS.md`](docs/DECISIONS.md)
3. the relevant domain contract/spec
4. [`docs/PRD.md`](docs/PRD.md)
5. [`docs/MASTER_PLAN.md`](docs/MASTER_PLAN.md) and tracker when sequencing matters

Core protocol:

```text
explicit contract
→ scoped implementation
→ tests / replay / security gates
→ independent audit of the REAL GitHub head
→ corrections in the SAME PR
→ re-audit
→ human merge gate
```

Non-negotiable operating rules:

- Do not invent product behavior when a required decision is missing; stop and surface the decision.
- Do not treat the implementer's own report as final proof that a PR is correct.
- Do not merge merely because local tests pass; the exact PR head must pass the required GitHub CI gates.
- Preserve provenance, current-vs-historical semantics, unknown-vs-zero distinctions, idempotency, RLS/ACL boundaries and canonical safety.
- Prefer one dependency-chain implementation block per PR.
- Corrections stay on the same branch/PR unless the contract explicitly says otherwise.
- Do not silently rewrite closed decisions or authoritative docs to justify new behavior.
- When a future orchestration system (including Codex) replaces today's tooling, preserve the separation between contract/architecture, implementation, independent audit and merge authorization unless the owner explicitly changes the method.

`docs/WORKING_METHOD.md` is the canonical explanation of the process; this file is only the repository entrypoint.
