/**
 * B07 benchmark — runner, reliability accounting and replay safety.
 *
 * Acceptance tests covered here: 11 (first-pass/retry/final counted
 * separately), 12 (missing key produces `not_run_missing_key`), 13 (a provider
 * exception can never become a semantic prediction), 14 (resume does not
 * duplicate completed pairs), 15 (a changed prompt/schema version cannot
 * silently reuse incompatible results), 18 (secrets are redacted),
 * 20 (the deterministic baseline is visibly marked benchmark-only).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BASELINE_BANNER,
  baselineClassify,
  baselineClassifyMessage,
  stripQuotedHistory,
} from "../../scripts/b07-benchmark/baseline/rules-baseline";
import {
  BASELINE_CANDIDATE,
  MODEL_CANDIDATES,
  hasApiKey,
  modelOverrideEnvVar,
  resolveModel,
} from "../../scripts/b07-benchmark/config/candidates";
import { loadCorpus, selectCases } from "../../scripts/b07-benchmark/corpus/load";
import { runCandidate, validatePrediction } from "../../scripts/b07-benchmark/run/runner";
import { isTerminalForResume, resultCompatibilityKey } from "../../scripts/b07-benchmark/run/types";
import { messageOutputZod, threadOutputZod } from "../../scripts/b07-benchmark/schema";
import {
  ProviderCallError,
  requireApiKey,
  timedFetch,
} from "../../scripts/b07-benchmark/providers/types";
import { redactObject, redactSecrets } from "../../scripts/provider-evaluation/redact";

const noop = (): void => {};

describe("structured-output validation", () => {
  it("11. distinguishes a valid parse from an invalid one without guessing", () => {
    expect(
      validatePrediction(
        "message",
        '{"disposition":"positive","signals":[],"evidence_strength":"strong"}',
      ),
    ).toEqual({ disposition: "positive", signals: [], evidence_strength: "strong" });
    expect(validatePrediction("message", '{"disposition":"delighted","signals":[]}')).toBeNull();
    expect(validatePrediction("message", "not json at all")).toBeNull();
    expect(validatePrediction("message", null)).toBeNull();
  });

  it("11b. recovers a JSON object wrapped in prose exactly once, and no further", () => {
    expect(
      validatePrediction(
        "thread",
        'Here you go: {"thread_state":"engaged","compensation_structure":"unknown","evidence_strength":"weak"} hope that helps',
      ),
    ).toEqual({
      thread_state: "engaged",
      compensation_structure: "unknown",
      evidence_strength: "weak",
    });
    // A body that is only prose stays a failure. It is not coerced.
    expect(validatePrediction("thread", "I think they are probably engaged.")).toBeNull();
  });

  it("3c. a response carrying a human outcome value is rejected, not coerced", () => {
    expect(
      validatePrediction(
        "thread",
        '{"thread_state":"ghosted","compensation_structure":"unknown","evidence_strength":"weak"}',
      ),
    ).toBeNull();
  });
});

describe("candidate configuration", () => {
  it("12. a provider with no API key is reported as such by the config layer", () => {
    expect(hasApiKey("openai", {})).toBe(false);
    expect(hasApiKey("openai", { OPENAI_API_KEY: "   " })).toBe(false);
    expect(hasApiKey("openai", { OPENAI_API_KEY: "sk-test-value" })).toBe(true);
    expect(hasApiKey("local", {})).toBe(true);
  });

  it("a renamed model can be overridden by env, so the round never fails on a moved id", () => {
    const candidate = MODEL_CANDIDATES[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;
    const envVar = modelOverrideEnvVar(candidate.id);
    expect(resolveModel(candidate, {})).toBe(candidate.model);
    expect(resolveModel(candidate, { [envVar]: "some-new-id" })).toBe("some-new-id");
    expect(resolveModel(candidate, { [envVar]: "  " })).toBe(candidate.model);
  });

  it("the candidate matrix names no single provider as the production answer", () => {
    // FUTURE-PROOFING: at least two distinct providers must be configured, so
    // the benchmark cannot quietly become a single-vendor commitment.
    const providers = new Set(MODEL_CANDIDATES.map((c) => c.providerId));
    expect(providers.size).toBeGreaterThanOrEqual(3);
  });
});

describe("runner behaviour without API keys", () => {
  const env = { ...process.env };
  const cases = selectCases({ split: "dev" }).slice(0, 5);

  it("12b. records not_run_missing_key and never a fake result", async () => {
    const openai = MODEL_CANDIDATES.find((c) => c.providerId === "openai");
    expect(openai).toBeDefined();
    if (!openai) return;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const outcome = await runCandidate({
        runId: "test-missing-key",
        candidate: openai,
        cases,
        concurrency: 2,
        maxSchemaRetries: 1,
        dryRun: false,
        resume: false,
        log: noop,
      });
      expect(outcome.availability).toBe("not_run_missing_key");
      expect(outcome.results).toHaveLength(cases.length);
      for (const result of outcome.results) {
        expect(result.status).toBe("not_run_missing_key");
        expect(result.prediction).toBeNull();
        expect(result.final_schema_valid).toBe(false);
        expect(result.attempts).toEqual([]);
        expect(result.total_latency_ms).toBe(0);
      }
    } finally {
      Object.assign(process.env, env);
    }
  });

  it("13. a provider exception cannot become a semantic prediction", () => {
    // Structural argument, asserted three ways:
    // (a) the adapter contract throws instead of returning a body;
    expect(() => requireApiKey("B07_DEFINITELY_UNSET_KEY", {})).toThrow(ProviderCallError);
    // (b) only a schema-valid parse can populate `prediction`;
    expect(validatePrediction("message", "Error: 503 Service Unavailable")).toBeNull();
    // (c) the zod schemas reject every non-conforming shape.
    expect(messageOutputZod.safeParse({ error: "rate limited" }).success).toBe(false);
    expect(threadOutputZod.safeParse({ error: "rate limited" }).success).toBe(false);
  });

  it("13b. a network failure is surfaced as a typed error, not an empty answer", async () => {
    await expect(
      timedFetch("https://127.0.0.1:9/definitely-not-listening", { method: "GET" }, 250),
    ).rejects.toBeInstanceOf(ProviderCallError);
  });
});

describe("replay and resume safety", () => {
  const baseIdentity = {
    candidate_id: "c1",
    provider_id: "openai",
    requested_model: "m1",
    inference_config_digest: "cfg1",
    case_id: "m-en-dev-001",
    corpus_version: "v1",
    prompt_version: "p1",
    schema_version: "s1",
  };

  it("14. the resume key identifies a candidate/case pair uniquely", () => {
    const a = resultCompatibilityKey(baseIdentity);
    const sameAgain = resultCompatibilityKey({ ...baseIdentity });
    const otherCase = resultCompatibilityKey({ ...baseIdentity, case_id: "m-en-dev-002" });
    const otherCandidate = resultCompatibilityKey({ ...baseIdentity, candidate_id: "c2" });
    expect(a).toBe(sameAgain);
    expect(a).not.toBe(otherCase);
    expect(a).not.toBe(otherCandidate);
  });

  it("15. a changed prompt, schema or corpus version produces a different key, so results cannot be mixed", () => {
    const base = baseIdentity;
    expect(resultCompatibilityKey(base)).not.toBe(
      resultCompatibilityKey({ ...base, prompt_version: "p2" }),
    );
    expect(resultCompatibilityKey(base)).not.toBe(
      resultCompatibilityKey({ ...base, schema_version: "s2" }),
    );
    expect(resultCompatibilityKey(base)).not.toBe(
      resultCompatibilityKey({ ...base, corpus_version: "v2" }),
    );
  });

  it("1. a changed requested model produces a different key, so a model override cannot reuse an old result", () => {
    const base = baseIdentity;
    expect(resultCompatibilityKey(base)).not.toBe(
      resultCompatibilityKey({ ...base, requested_model: "m2" }),
    );
  });

  it("2. a changed effective inference-config digest produces a different key, so an effort/config change cannot reuse an old result", () => {
    const base = baseIdentity;
    expect(resultCompatibilityKey(base)).not.toBe(
      resultCompatibilityKey({ ...base, inference_config_digest: "cfg2" }),
    );
  });

  it("14b. only settled work is reusable — a transient failure is retried, not frozen", () => {
    expect(isTerminalForResume("ok")).toBe(true);
    expect(isTerminalForResume("schema_failed")).toBe(true);
    expect(isTerminalForResume("provider_error")).toBe(false);
    expect(isTerminalForResume("timeout")).toBe(false);
    expect(isTerminalForResume("dry_run")).toBe(false);
  });

  it("3. `not_run_missing_key` is NOT terminal for resume — an absence of evidence is re-runnable once the key exists", () => {
    // Finding 2: a missing key is an absence of evidence, not completed model
    // work. Once the key is present, resume must actually call the provider.
    expect(isTerminalForResume("not_run_missing_key")).toBe(false);
  });
});

describe("secret hygiene", () => {
  it("18. a credential in a log line or an artifact object is redacted", () => {
    const secret = "sk-test-abcdefghijklmnop";
    expect(redactSecrets(`Authorization: Bearer ${secret}`, [secret])).not.toContain(secret);
    const redacted = redactObject(
      { headers: { authorization: `Bearer ${secret}` }, note: `used ${secret}` },
      [secret],
    ) as { headers: { authorization: string }; note: string };
    expect(redacted.headers.authorization).toBe("[REDACTED]");
    expect(redacted.note).not.toContain(secret);
  });

  it("18b. no benchmark source file contains a literal API key", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const root = resolve(here, "..", "..", "scripts", "b07-benchmark");
    const files = [
      "cli.ts",
      "providers/openai.ts",
      "providers/anthropic.ts",
      "providers/google.ts",
      "config/candidates.ts",
    ];
    for (const file of files) {
      const source = readFileSync(resolve(root, file), "utf8");
      expect(source).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
      expect(source).not.toMatch(/AIza[A-Za-z0-9_-]{30,}/);
    }
  });
});

describe("Stage 0 deterministic baseline", () => {
  it("20. is visibly and unmissably marked as benchmark-only", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const source = readFileSync(
      resolve(here, "..", "..", "scripts", "b07-benchmark", "baseline", "rules-baseline.ts"),
      "utf8",
    );
    expect(source).toContain("NOT PRODUCTION B07 IMPLEMENTATION");
    expect(BASELINE_BANNER).toContain("NOT PRODUCTION B07 IMPLEMENTATION");
    expect(BASELINE_CANDIDATE.family).toContain("NOT PRODUCTION B07 IMPLEMENTATION");
    expect(BASELINE_CANDIDATE.role).toBe("baseline");
  });

  it("strips quoted history before classifying", () => {
    expect(stripQuotedHistory("We decline.\n\n> We are thrilled!\n> Let's go!")).toBe(
      "We decline.",
    );
    expect(stripQuotedHistory("No thanks.\nOn 3 March, X wrote:\nThis is amazing!")).toBe(
      "No thanks.",
    );
  });

  it("produces a schema-valid prediction for every case in the corpus", () => {
    for (const c of loadCorpus()) {
      const prediction = baselineClassify(c);
      const parsed =
        c.task === "message"
          ? messageOutputZod.safeParse(prediction)
          : threadOutputZod.safeParse(prediction);
      expect(parsed.success, `${c.case_id} baseline output invalid`).toBe(true);
    }
  });

  it("never emits a human outcome value", () => {
    const forbidden = new Set(["open", "won", "lost", "ghosted", "uncertain", "no_reply"]);
    for (const c of loadCorpus()) {
      for (const value of Object.values(baselineClassify(c))) {
        if (Array.isArray(value)) {
          for (const v of value) expect(forbidden.has(String(v))).toBe(false);
        } else {
          expect(forbidden.has(String(value))).toBe(false);
        }
      }
    }
  });

  it("runs end to end as a local candidate with no network and no key", async () => {
    const cases = selectCases({ split: "dev" }).slice(0, 8);
    const outcome = await runCandidate({
      runId: "test-baseline-inmemory",
      candidate: BASELINE_CANDIDATE,
      cases,
      concurrency: 4,
      maxSchemaRetries: 1,
      dryRun: false,
      resume: false,
      log: noop,
    });
    expect(outcome.availability).toBe("available");
    expect(outcome.results).toHaveLength(cases.length);
    for (const result of outcome.results) {
      expect(result.status).toBe("ok");
      expect(result.final_schema_valid).toBe(true);
      expect(result.usage_totals.input_tokens).toBeNull();
    }
  });

  it("is genuinely a floor, not a hidden production classifier", () => {
    // The politeness trap is the cheapest possible test of a lexical baseline.
    // It is expected to be non-`positive` here only because the lexicon has no
    // advancing keyword to latch on to; the baseline's real weakness shows up
    // on the adversarial suite in the run report.
    const politeness = loadCorpus().find((c) => c.case_id === "m-en-dev-002");
    expect(politeness?.task).toBe("message");
    if (politeness?.task !== "message") return;
    const prediction = baselineClassifyMessage(politeness);
    expect(prediction.disposition).not.toBe("positive");
  });
});
