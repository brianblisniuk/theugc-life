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

`--max-schema-retries` is capped at 1 on purpose: unlimited retries make a weak
candidate look reliable.

## API keys

Read from the environment (or `.env.local`, which is gitignored):
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`.

A missing key is **not** an error. That candidate's cases are recorded
`not_run_missing_key`, the report lists it under "Not run — recorded as absence
of evidence, NOT as a result", and everything else still runs. Keys are never
printed, never committed and never written into an artifact.

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
