# B07 inference benchmark harness

Evaluation infrastructure for the D072 / B07 commercial-meaning inference
decision. **This is not production B07 code.** It reads a synthetic fixture
corpus, makes no Gmail API call, opens no database connection, and is never
imported by `src/`.

Full specification: [`docs/B07_INFERENCE_BENCHMARK_SPEC.md`](../../docs/B07_INFERENCE_BENCHMARK_SPEC.md).
Governing contract: [`docs/B07_GMAIL_COMMERCIAL_MEANING_CONTRACT.md`](../../docs/B07_GMAIL_COMMERCIAL_MEANING_CONTRACT.md).

## Commands

```bash
npm run eval:b07:status      # corpus stats, taxonomy coverage, candidate/key status, vendor screen
npm run eval:b07:baseline    # Stage 0 deterministic rules baseline over the whole corpus
npm run eval:b07:screen      # Stage 1 screening over the dev split
npm run eval:b07:final       # Stage 2 finalists over the holdout split
npm run eval:b07:report -- --run <run-id>
```

Flags (all stages): `--candidate <id>` (repeatable), `--split dev|holdout`,
`--critical-only`, `--concurrency N`, `--max-schema-retries 0|1`, `--dry-run`,
`--resume`, `--run <run-id>`.

Stage-2-only flags (auditable finalist selection — see finding 14 of the
integrity correction): `--from-run <stage-1-run-id>` (the screening run these
finalists were drawn from) and `--finalist-reason "<why>"` (**required** when
any selected candidate has `role: "ceiling"`).

`--max-schema-retries` is capped at 1 on purpose: unlimited retries make a weak
candidate look reliable.

`final` **requires** at least one explicit `--candidate <id>` and fails before
any provider call, corpus load or case selection if none is given — Stage 2
never auto-runs every configured model or an implicit quality ceiling.

## API keys

Read from the environment (or `.env.local`, which is gitignored):
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`.

A missing key is **not** an error. That candidate's cases are recorded
`not_run_missing_key`, the report lists it under "Not run — recorded as absence
of evidence, NOT as a result", and everything else still runs. Keys are never
printed, never committed and never written into an artifact.

`not_run_missing_key` is **not** a terminal state for `--resume`: once the
required key is present, resuming the same `--run` id actually calls that
provider for those cases instead of reusing the old absence.

## Result identity

A stored result is only reused on `--resume` when EVERY identity component
matches: candidate, provider, the exact requested model, the effective
inference configuration (reasoning/thinking effort, transport version — see
`config/inference-config.ts`), case id, and the corpus/prompt/schema versions.
Overriding a model id (`B07_BENCH_MODEL_...`) or changing the inference policy
between two runs of the same `--run` id is therefore never silently mixed into
one score — the affected cases are reported as an identity conflict and that
candidate's row is marked invalidated rather than partially scored.

## Exact selection reproducibility

Every run manifest records the exact selected case ids and a digest over them
(`selected_case_ids`, `case_set_digest`), not just `split`. `report --run`
replays that exact set — a `--critical-only` run can never later be reported
as though it had scored the full split — and refuses if the corpus can no
longer produce a recorded case id or if the manifest's own digest doesn't
match its own recorded ids.

## Renamed models

Model ids are configuration. Override any candidate at run time:

```bash
B07_BENCH_MODEL_OPENAI_GPT_5_6_LUNA=some-new-id npm run eval:b07:screen
```

Availability is checked against the provider's own model listing before the run;
a model that is gone is recorded `unavailable`, never faked.

## Artifacts

Everything a run produces lands in `artifacts/b07-benchmark/<run-id>/`
(`manifest.json`, `results.jsonl`, `report.md`, `scores.json`). That directory is
gitignored — raw provider output is not committed.

## Layout

| path          | what it is                                                              |
| ------------- | ----------------------------------------------------------------------- |
| `taxonomy.ts` | the D072 enums, single source of truth                                  |
| `schema.ts`   | the one logical machine-output schema (Zod + JSON Schema)               |
| `fixtures/`   | the versioned synthetic gold corpus (JSONL)                             |
| `corpus/`     | corpus schema and strict loader (split, leakage and invariant guards)   |
| `prompt/`     | `b07_benchmark_prompt_v1` and the candidate-visible projection          |
| `providers/`  | benchmark-only `fetch` adapters (OpenAI, Anthropic, Google)             |
| `baseline/`   | Stage 0 lexical rules — **BENCHMARK BASELINE, NOT PRODUCTION**          |
| `scoring/`    | metric primitives, invariant suite, candidate scoring, targets/decision |
| `run/`        | runner (concurrency, bounded retry, resume) and artifact IO             |
| `report/`     | human-readable report rendering                                         |
| `privacy/`    | benchmark-time privacy/vendor screen                                    |
| `config/`     | candidate matrix and timestamped price metadata                         |

Tests: `tests/b07-benchmark/`.
