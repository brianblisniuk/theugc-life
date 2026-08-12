# theugc.life — Technical Documentation Pack

This folder is intended to be copied into the project repository as `/docs` (except this README may remain as `/docs/README.md`).

## Implementation agent

**Primary: Claude Code.**

Reason: implementation is repository-, migration-, test-, terminal- and git-centric. Claude Cowork can be useful for document review, product discussion, and broader workspace tasks, but should not become a parallel source of implementation/product decisions.

## Files

- `PRD.md` — master product source of truth (copy the separately supplied PRD here)
- `DATABASE.md` — database invariants, entities, indexing and retention
- `PERMISSIONS.md` — RLS/authorization model and test matrix
- `EVENTS.md` — canonical outreach event vocabulary and transition semantics
- `ROUTES.md` — public/app/admin route contracts
- `ANALYTICS.md` — product measurement plan and KPI dictionary
- `DESIGN_SYSTEM.md` — UX/design implementation guardrails
- `AI_RULES.md` — future AI/email safety and architecture rules
- `DECISIONS.md` — accepted architecture/product decisions
- `SPRINT_0_PROMPT.md` — first implementation prompt for Claude Code

## Precedence

1. PRD
2. Explicit approved amendments/decision records
3. Derived technical docs

If documents conflict, stop implementation and surface the conflict. Do not silently resolve it.

## Recommended workflow

1. Create repository.
2. Put the PRD at `/docs/PRD.md`.
3. Copy this technical pack into `/docs`.
4. Open repository in Claude Code.
5. Give Claude Code the contents/instruction of `SPRINT_0_PROMPT.md`.
6. Review Sprint 0 before authorizing Sprint 1.
