# START_HERE.md

Use this file when resuming the project in a new ChatGPT conversation, coding-agent session, or after a long pause.

## Read first

1. [`docs/WORKING_METHOD.md`](docs/WORKING_METHOD.md) — **how work is performed and audited**.
2. [`docs/DECISIONS.md`](docs/DECISIONS.md) — closed product/architecture decisions.
3. [`docs/MASTER_PLAN.md`](docs/MASTER_PLAN.md) — long-range direction.
4. [`docs/MASTER_PLAN_TRACKER.md`](docs/MASTER_PLAN_TRACKER.md) — current execution sequence/status.
5. The contract/spec for the block currently being implemented.
6. The most recent continuity backup, if one is supplied.

Then verify the **real GitHub state** — current `main`, open PRs, branch/head SHA and CI — before deciding what to do next.

## Minimal prompt for a new ChatGPT conversation

```text
Estamos continuando el proyecto brianblisniuk/theugc-life.

Antes de proponer o cambiar nada:
1. lee START_HERE.md;
2. lee docs/WORKING_METHOD.md;
3. lee docs/DECISIONS.md;
4. lee docs/MASTER_PLAN.md y docs/MASTER_PLAN_TRACKER.md;
5. lee el contrato del bloque actual;
6. lee el backup de continuidad que adjunto, si hay uno;
7. verifica el estado REAL de GitHub (main, PR, head SHA, CI).

No reinventes decisiones cerradas.
Usa el método de WORKING_METHOD.md: contrato explícito → implementación acotada → auditoría externa del head real → corrections en el mismo PR → gate → merge.
```

## Important distinction

The continuity backup tells you **where the project was** at a moment in time.

The repository tells you **what is true now**.

If they disagree, inspect the repo/history and resolve the difference rather than blindly trusting the backup.
