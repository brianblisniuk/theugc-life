# B07 inference benchmark — run summary, 2026-09-12

**Status:** BENCHMARK INFRASTRUCTURE COMPLETE — EXTERNAL PROVIDER RUNS PENDING.
**Corpus:** `b07_gold_corpus_v1` · **Prompt:** `b07_benchmark_prompt_v1` · **Schema:** `b07_benchmark_schema_v1`
**Specification:** [`docs/B07_INFERENCE_BENCHMARK_SPEC.md`](../B07_INFERENCE_BENCHMARK_SPEC.md)
**Governing decision:** D072 — [`docs/B07_GMAIL_COMMERCIAL_MEANING_CONTRACT.md`](../B07_GMAIL_COMMERCIAL_MEANING_CONTRACT.md)

This summary is derived from a real local run. It contains no provider response
content and no secrets. Raw run artifacts live in the gitignored
`artifacts/b07-benchmark/` directory.

---

## 1. What was actually run

| candidate | provider | requested model | outcome |
|---|---|---|---|
| `benchmark-rules-baseline` | local | `benchmark-lexical-rules-v1` | **RUN** — 175/175 cases |
| `openai-gpt-5-6-luna` | OpenAI | `gpt-5.6-luna` | `not_run_missing_key` |
| `openai-gpt-5-6-terra` | OpenAI | `gpt-5.6-terra` | `not_run_missing_key` |
| `anthropic-sonnet-5` | Anthropic | `claude-sonnet-5` | `not_run_missing_key` |
| `anthropic-haiku-4-5` | Anthropic | `claude-haiku-4-5` | `not_run_missing_key` |
| `google-gemini-flash` | Google | `gemini-flash-latest` | `not_run_missing_key` |
| `google-gemini-pro` | Google | `gemini-pro-latest` | `not_run_missing_key` |
| `anthropic-opus-5` | Anthropic | `claude-opus-5` | `not_run_missing_key` (ceiling, finals only) |

`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` were all absent from
the execution environment. **No external API call of any kind was made in this
round**, so no model above may be cited as benchmark evidence. Their model ids
could likewise not be verified against a live catalogue; ids marked
`unverified_at_authoring` in `scripts/b07-benchmark/config/candidates.ts` must be
re-checked (or overridden via `B07_BENCH_MODEL_<CANDIDATE_ID>`) before the
screening stage is run for real.

Scored set = 175 cases: the 180-case corpus minus the 5 few-shot exemplars, which
are excluded from scoring because the candidate is shown their answers.

## 2. Corpus

- 180 cases: 110 message-task, 70 thread-task.
- Split: 60 `dev` / 120 `holdout`, disjoint.
- Languages: 111 `en`, 48 `es`, 13 `pt`, 8 `fr`.
- Critical-invariant suite: 126 cases (41 `dev`, 85 `holdout`).

Gold taxonomy coverage (primary gold only):

| axis | distribution |
|---|---|
| disposition | positive 38 · neutral 39 · negative 13 · mixed 12 · ambiguous 8 |
| signals | terms_discussion 35 · interest 28 · (empty set) 22 · request_information 18 · rejection 16 · timing_constraint 16 · redirect 12 · offer 11 · agreement 7 · other_commercial 1 |
| thread_state | negotiating 18 · engaged 17 · unresolved 13 · declined_observed 9 · agreement_observed 7 · ambiguous 6 |
| compensation | unknown 37 · in_kind 13 · paid 7 · hybrid 6 · unpaid 5 · other 2 |

## 3. Stage 0 — BENCHMARK BASELINE (deterministic lexical rules)

> **BENCHMARK BASELINE — NOT PRODUCTION B07 IMPLEMENTATION.** This exists only
> to give the model candidates a floor to beat. It must not be promoted into
> B07 production architecture, and the decision logic structurally refuses to
> nominate it.

**Hard gate: FAIL.** 123 critical cases evaluated, **2 violations**, all of
`temporary_timing_not_permanent_decline` — the baseline reads a dated
availability constraint as an outright decline, exactly the collapse D072 §17/§27
forbids.

| Task M (n=107) | value |
|---|---|
| disposition accuracy | 79.4% |
| disposition macro F1 (all classes) | 0.6902 |
| signal exact-set accuracy | 43.9% (47/107) |
| signal micro F1 | 0.5654 |
| signal macro F1 | 0.4831 |
| signal over-prediction rate | 0.0458 |
| signal under-prediction rate | 0.5878 |
| empty gold signal sets | 25, correctly empty 25 |
| evidence-strength accuracy | 16.8% |

Per-class disposition F1: `ambiguous` 1.000 · `positive` 0.862 · `neutral` 0.836
· `mixed` 0.400 · `negative` 0.353.

| Task T (n=68) | value |
|---|---|
| thread-state accuracy | 76.5% |
| thread-state macro F1 (all classes) | 0.6310 |
| compensation accuracy | 88.2% |
| **unknown predicted as unpaid** | **0** |
| unpaid predicted as unknown | 1 |
| evidence-strength accuracy | 10.3% |

Per-class thread-state F1: `engaged` 1.000 · `agreement_observed` 1.000 ·
`negotiating` 0.788 · `unresolved` 0.776 · `declined_observed` 0.222 ·
`ambiguous` 0.000.

Reliability: first-pass 100%, retries 0%, final 100%, provider errors 0,
timeouts 0 — trivially, since it is local and deterministic.
Economics: no pricing metadata (no tokens are consumed).

### What the baseline result actually tells us

The lexical baseline is respectable on the easy half and collapses exactly where
D072's semantics live:

- it recovers straightforward positives, redirects and clean confirmations;
- it scores **0.000 F1 on `ambiguous` threads and 0.222 on `declined_observed`**,
  because "what the thread currently supports" is not a keyword problem;
- it scores 0.353 on `negative` and 0.400 on `mixed` dispositions — it cannot tell
  a decline from a constrained yes;
- its evidence-strength assessment is near-useless (16.8% / 10.3%) because
  counting matched keywords is not an epistemic judgement;
- and it **fails the critical safety gate outright**.

Notably it did NOT commit the `unknown` → `unpaid` collapse — silence produces no
keyword match, so the rules land on `unknown` by construction. That is luck of
architecture, not safety reasoning, and it should not be read as evidence that a
rules approach is safe on this axis.

**Conclusion for the round:** a deterministic rules approach is not a viable
standalone B07 implementation under D072. It remains useful as the floor every
model candidate must clear by a wide margin, and the evidence does not yet
support or refute a "rules for obvious cases + model for ambiguity" hybrid —
that question needs the model runs.

## 4. Privacy / vendor screen

Verified 2026-09-12. **Passing this screen authorizes nothing about real Gmail.**

| provider | trains on API data by default | standard retention | ZDR | synthetic benchmark | private-Gmail candidacy | verification |
|---|---|---|---|---|---|---|
| Anthropic — Claude API | no | conversation content **not retained by default**; 30 days for Covered Models | yes, on request (per organization) | `synthetic_benchmark_suitable` | `potential_private_gmail_candidate_pending_final_approval` | `official_page_fetched` |
| OpenAI — Platform API | unknown | unknown | unknown | `synthetic_benchmark_suitable` | `undetermined_official_source_unreachable` | `official_page_unreachable_from_this_host` |
| Google — Gemini Developer API (paid) | no (paid tier) | abuse logs, reported 55-day default expiry | unknown | `synthetic_benchmark_suitable` | `undetermined_official_source_unreachable` | `secondary_summary_only` |

### Correction to the round brief's stated baseline facts

The brief stated Anthropic's commercial API has "standard API retention
approximately 30 days". The official
[API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)
page, read on 2026-09-12, says something materially narrower:

> "Only what is technically necessary for the feature to work is retained.
> Conversation content (your prompts and Claude's outputs) is not retained by
> default; the exception is Covered Models, which require 30-day retention."

and

> "Retained data is never used for model training without your express
> permission."

So the 30-day figure applies to Covered Models (Fable/Mythos class), which are
also **not ZDR-eligible unless expressly authorized**. Any B07 vendor approval
must therefore fix the exact model tier before it can state a retention posture.

The same page carries a constraint that is directly relevant to B07's design:
structured-output JSON schemas are compiled to grammars and **cached separately
from message content, without the same protections**. The benchmark schema
contains only D072 enum names and no case content, and a production B07
configuration must preserve that property — no Gmail-derived text, names,
property names or regex patterns in a schema.

OpenAI's and Google's official documentation domains are blocked by this
environment's egress proxy. Their entries record what could and could not be
verified; neither is cleared as a private-Gmail candidate on the strength of a
secondary summary.

## 5. Decision

`DECISION: external_runs_pending` — "No non-baseline candidate was successfully
called, so no provider comparison exists."

The benchmark's own decision logic reached this outcome mechanically, from the
recorded evidence, rather than by editorial judgement.

## 6. Known limitations

See §14 of the specification. In short: `other_commercial` has a single primary
gold instance and a correspondingly high-variance per-label F1;
`evidence_strength` is the most subjective axis and is deliberately not a hard
gate; and the corpus is synthetic by mandate, so any production decision should
be revisited against real, privacy-approved data before B07 ships.
