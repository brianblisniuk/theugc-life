import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  commitInterpretation,
  getStatus,
  getThreadEvidence,
  listCandidates,
} from "@/lib/gmail/reply/service";
import { interpretThread } from "@/lib/gmail/reply/interpreter";
import {
  CLASSIFICATION_RULE_VERSION,
  RELATION_RULE_VERSION,
  TEXT_TRANSFORM_VERSION,
} from "@/lib/gmail/reply/contract";
import {
  connectedMailbox,
  insertMessage,
  insertObservedHorizon,
  messageObservationsOf,
  randomProviderId,
  replyDeps,
  setOutreachHumanDecision,
  setOutreachMachineStatus,
  threadSummaryOf,
} from "./harness";

/**
 * B06 CONSOLIDATED CLOSURE PASS — direct-RPC adversarial proofs, real
 * multi-session concurrency, and cross-user hostile-RPC hardening that the
 * happy-path suites in db-core/concurrency.test.ts do not exercise. Every
 * test here attacks the COMMIT RPC's trust boundary directly, bypassing
 * `commitInterpretation`'s normal TS-computed payload where a specific
 * adversarial shape is the point.
 */

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_DB);

let client: Client;
const openSessions: Client[] = [];

beforeAll(async () => {
  if (!TEST_DB) return;
  client = new Client({ connectionString: TEST_DB });
  await client.connect();
});

afterEach(async () => {
  while (openSessions.length > 0) {
    const c = openSessions.pop()!;
    await c.query("rollback").catch(() => undefined);
    await c.end().catch(() => undefined);
  }
});

afterAll(async () => {
  if (client) await client.end();
});

async function session(): Promise<Client> {
  const c = new Client({ connectionString: TEST_DB });
  await c.connect();
  openSessions.push(c);
  return c;
}

const backendPid = async (c: Client): Promise<number> =>
  Number((await c.query("select pg_backend_pid() as pid")).rows[0].pid);

async function waitUntilBlocked(pid: number, timeoutMs = 10_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await client.query("select pg_blocking_pids($1) as blockers", [pid]);
    const blockers: number[] = res.rows[0].blockers ?? [];
    if (blockers.length > 0) return blockers;
    if (Date.now() > deadline) throw new Error(`backend ${pid} never blocked`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const DAY = 86_400_000;

/** Directly invokes the commit RPC with a raw payload — bypassing TS's own construction, for adversarial shapes. */
async function commitRaw(
  c: Client,
  args: {
    userId: string;
    mailAccountId: string;
    normalizedThreadId: string;
    expectedEvidenceDigest: string;
    expectedRoutingContextDigest: string;
    observations: unknown[];
    /** FINAL CLOSURE §D: lets the unified-staleness-matrix test simulate a rule-version bump without recompiling. */
    relationVersion?: string;
    classificationVersion?: string;
    textTransformVersion?: string;
  },
) {
  return c.query(
    `select public.gmail_reply_commit_interpretation(
       p_user_id := $1::uuid, p_mail_account_id := $2::uuid, p_normalized_thread_id := $3::uuid,
       p_relation_version := $4, p_classification_version := $5, p_text_transform_version := $6,
       p_expected_evidence_digest := $7, p_expected_routing_context_digest := $8,
       p_message_observations := $9::jsonb
     ) as result`,
    [
      args.userId,
      args.mailAccountId,
      args.normalizedThreadId,
      args.relationVersion ?? RELATION_RULE_VERSION,
      args.classificationVersion ?? CLASSIFICATION_RULE_VERSION,
      args.textTransformVersion ?? TEXT_TRANSFORM_VERSION,
      args.expectedEvidenceDigest,
      args.expectedRoutingContextDigest,
      JSON.stringify(args.observations),
    ],
  );
}

/** Direct RPC access to `gmail_reply_list_candidates` with overridable versions (FINAL CLOSURE §D). */
async function listCandidatesRaw(
  c: Client,
  args: {
    userId: string;
    mailAccountId: string;
    relationVersion?: string;
    classificationVersion?: string;
    textTransformVersion?: string;
    limit?: number;
  },
): Promise<{ result: string; candidates: Array<{ normalized_thread_id: string }> }> {
  const res = await c.query(
    `select public.gmail_reply_list_candidates(
       p_user_id := $1::uuid, p_mail_account_id := $2::uuid,
       p_relation_version := $3, p_classification_version := $4, p_text_transform_version := $5,
       p_limit := $6
     ) as result`,
    [
      args.userId,
      args.mailAccountId,
      args.relationVersion ?? RELATION_RULE_VERSION,
      args.classificationVersion ?? CLASSIFICATION_RULE_VERSION,
      args.textTransformVersion ?? TEXT_TRANSFORM_VERSION,
      args.limit ?? 10,
    ],
  );
  return res.rows[0].result;
}

/** Direct RPC access to `gmail_reply_get_thread_evidence` with overridable versions (FINAL CLOSURE §D). */
async function getThreadEvidenceRaw(
  c: Client,
  args: {
    userId: string;
    mailAccountId: string;
    normalizedThreadId: string;
    relationVersion?: string;
    classificationVersion?: string;
    textTransformVersion?: string;
  },
): Promise<{ result: string; current_summary_is_stale?: boolean }> {
  const res = await c.query(
    `select public.gmail_reply_get_thread_evidence(
       p_user_id := $1::uuid, p_mail_account_id := $2::uuid, p_normalized_thread_id := $3::uuid,
       p_relation_version := $4, p_classification_version := $5, p_text_transform_version := $6
     ) as result`,
    [
      args.userId,
      args.mailAccountId,
      args.normalizedThreadId,
      args.relationVersion ?? RELATION_RULE_VERSION,
      args.classificationVersion ?? CLASSIFICATION_RULE_VERSION,
      args.textTransformVersion ?? TEXT_TRANSFORM_VERSION,
    ],
  );
  return res.rows[0].result;
}

/** Direct RPC access to `gmail_reply_status` with overridable versions (FINAL CLOSURE §D). */
async function statusRaw(
  c: Client,
  args: {
    userId: string;
    mailAccountId: string;
    relationVersion?: string;
    classificationVersion?: string;
    textTransformVersion?: string;
  },
): Promise<{ stale_thread_summaries: number }> {
  const res = await c.query(
    `select public.gmail_reply_status(
       p_user_id := $1::uuid, p_mail_account_id := $2::uuid,
       p_relation_version := $3, p_classification_version := $4, p_text_transform_version := $5
     ) as result`,
    [
      args.userId,
      args.mailAccountId,
      args.relationVersion ?? RELATION_RULE_VERSION,
      args.classificationVersion ?? CLASSIFICATION_RULE_VERSION,
      args.textTransformVersion ?? TEXT_TRANSFORM_VERSION,
    ],
  );
  return res.rows[0].result;
}

/**
 * FINAL CLOSURE, BLOCKER C: asserts `list_candidates`/`get_thread_evidence`/
 * `status` agree — all three read surfaces must report the SAME
 * current-vs-stale verdict for one thread, since all three call the ONE
 * shared `private.gmail_reply_thread_summary_is_stale` definition. `versions`
 * lets a test simulate "the version actually running now differs from what
 * is stored" without recompiling a new TS constant.
 */
async function assertUnifiedStaleness(
  ctx: { userId: string; mailAccountId: string; normalizedThreadId: string },
  expectedStale: boolean,
  versions: {
    relationVersion?: string;
    classificationVersion?: string;
    textTransformVersion?: string;
  } = {},
): Promise<void> {
  const candidates = await listCandidatesRaw(client, {
    userId: ctx.userId,
    mailAccountId: ctx.mailAccountId,
    limit: 50,
    ...versions,
  });
  const offered = (candidates.candidates ?? []).some(
    (c) => c.normalized_thread_id === ctx.normalizedThreadId,
  );
  expect(offered, "list_candidates offer").toBe(expectedStale);

  const evidence = await getThreadEvidenceRaw(client, {
    userId: ctx.userId,
    mailAccountId: ctx.mailAccountId,
    normalizedThreadId: ctx.normalizedThreadId,
    ...versions,
  });
  expect(evidence.result).toBe("ok");
  expect(evidence.current_summary_is_stale, "get_thread_evidence current_summary_is_stale").toBe(
    expectedStale,
  );

  const status = await statusRaw(client, {
    userId: ctx.userId,
    mailAccountId: ctx.mailAccountId,
    ...versions,
  });
  // Each fixture below uses its own freshly-connected mailbox with exactly
  // one thread, so the account-scoped stale count is unambiguous.
  expect(status.stale_thread_summaries, "status stale_thread_summaries").toBe(
    expectedStale ? 1 : 0,
  );
}

/** Re-reads evidence and commits a fresh interpretation — the "reevaluation" half of each matrix case. */
async function reevaluateAndCommit(
  ctx: { userId: string; mailAccountId: string; normalizedThreadId: string },
  versions: {
    relationVersion?: string;
    classificationVersion?: string;
    textTransformVersion?: string;
  } = {},
): Promise<void> {
  const deps = replyDeps(client);
  const evidence = await getThreadEvidence(deps, ctx);
  if (evidence.result !== "ok") throw new Error("unreachable");
  const interpretation = interpretThread({
    messages: evidence.evidence.messages,
    referenceTokens: evidence.evidence.referenceTokens,
    participants: evidence.evidence.participants,
    subjects: evidence.evidence.subjects,
    textParts: evidence.evidence.textParts,
    mailAccountEmail: evidence.evidence.mailAccountEmail,
    observedThroughAtMs: evidence.evidence.observedThroughAt
      ? Date.parse(evidence.evidence.observedThroughAt)
      : null,
  });
  const observations = interpretation.messageObservations.map((o) => ({
    provider_message_id: o.providerMessageId,
    response_class: o.responseClass,
    relation_status: o.relationStatus,
    referenced_creator_sent_provider_message_id: o.referencedCreatorSentProviderMessageId,
  }));
  const res = await commitRaw(client, {
    userId: ctx.userId,
    mailAccountId: ctx.mailAccountId,
    normalizedThreadId: ctx.normalizedThreadId,
    expectedEvidenceDigest: evidence.evidence.evidenceDigest,
    expectedRoutingContextDigest: evidence.evidence.routingContextDigest,
    observations,
    relationVersion: versions.relationVersion,
    classificationVersion: versions.classificationVersion,
    textTransformVersion: versions.textTransformVersion,
  });
  expect(res.rows[0].result.result, JSON.stringify(res.rows[0].result)).toBe("ok");
}

/**
 * AUDIT CORRECTION, FINDING 1: the zero-write proof shared by every
 * already-current/mismatch adversarial test below — deep equality (not
 * merely row counts) of every id/`evaluated_at`/`updated_at`/`xmin` proves a
 * rejected commit attempt touched NOTHING.
 */
async function snapshotThreadRows(normalizedThreadId: string) {
  return {
    observations: (
      await client.query(
        `select id, evaluated_at, updated_at, xmin::text as xmin
           from private.gmail_reply_message_observations
          where normalized_thread_id = $1
          order by provider_message_id`,
        [normalizedThreadId],
      )
    ).rows,
    summary: (
      await client.query(
        `select id, evaluated_at, updated_at, xmin::text as xmin
           from private.gmail_reply_thread_summaries
          where normalized_thread_id = $1`,
        [normalizedThreadId],
      )
    ).rows,
  };
}

/** One creator-SENT message + one qualifying human reply, machine-eligible, ready to commit. */
async function eligibleThreadWithReply(label: string) {
  const { userId, mailAccountId } = await connectedMailbox(client, label);
  const providerThreadId = randomProviderId("thread");
  const t0 = Date.now() - DAY;
  const sentProviderMessageId = randomProviderId("sent");
  const sentMid = `<${randomProviderId("mid")}@creator.example>`;

  const sent = await insertMessage(client, {
    userId,
    mailAccountId,
    providerMessageId: sentProviderMessageId,
    providerThreadId,
    internalDateMs: t0,
    sent: true,
    messageId: sentMid,
    subject: "Collaboration idea",
    bodyText: "I would love to collaborate.",
  });
  const replyProviderMessageId = randomProviderId("reply");
  await insertMessage(client, {
    userId,
    mailAccountId,
    providerMessageId: replyProviderMessageId,
    providerThreadId,
    internalDateMs: t0 + 3_600_000,
    sent: false,
    from: "brand@example.com",
    inReplyTo: sentMid,
    subject: "Re: Collaboration idea",
    bodyText: "Sounds great, let's talk rates.",
  });
  await setOutreachMachineStatus(client, {
    userId,
    mailAccountId,
    normalizedThreadId: sent.normalizedThreadId,
    outreachStatus: "qualified_outreach",
  });

  const deps = replyDeps(client);
  const evidence = await getThreadEvidence(deps, {
    userId,
    mailAccountId,
    normalizedThreadId: sent.normalizedThreadId,
  });
  if (evidence.result !== "ok") throw new Error("unreachable");
  const interpretation = interpretThread({
    messages: evidence.evidence.messages,
    referenceTokens: evidence.evidence.referenceTokens,
    participants: evidence.evidence.participants,
    subjects: evidence.evidence.subjects,
    textParts: evidence.evidence.textParts,
    mailAccountEmail: evidence.evidence.mailAccountEmail,
    observedThroughAtMs: null,
  });

  return {
    userId,
    mailAccountId,
    normalizedThreadId: sent.normalizedThreadId,
    providerThreadId,
    sentProviderMessageId,
    sentMid,
    replyProviderMessageId,
    evidenceDigest: evidence.evidence.evidenceDigest,
    routingContextDigest: evidence.evidence.routingContextDigest,
    /** Full TS-side interpretation, for `commitInterpretation` (the service wrapper). */
    messageObservations: interpretation.messageObservations,
    /** The raw wire shape, for `commitRaw` (direct adversarial RPC calls). */
    observations: interpretation.messageObservations.map((o) => ({
      provider_message_id: o.providerMessageId,
      response_class: o.responseClass,
      relation_status: o.relationStatus,
      referenced_creator_sent_provider_message_id: o.referencedCreatorSentProviderMessageId,
    })),
  };
}

d("B06 closure pass: commit RPC fail-before-write (§12)", () => {
  it("a provider_sent/response_class mismatch on the SECOND observation rejects the WHOLE commit — nothing from the FIRST, valid observation is written", async () => {
    const fixture = await eligibleThreadWithReply("b06-cp-fail-before-write");

    // Sabotage the SECOND element (the reply) with an impossible class for a
    // non-SENT message. The FIRST element (the creator-sent touch) is left
    // perfectly valid — if this function wrote row-by-row instead of
    // validating everything first, the first row would survive.
    const sabotaged = fixture.observations.map((o) =>
      o.provider_message_id === fixture.replyProviderMessageId
        ? { ...o, response_class: "creator_sent_touch", relation_status: null }
        : o,
    );

    await expect(
      commitRaw(client, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        normalizedThreadId: fixture.normalizedThreadId,
        expectedEvidenceDigest: fixture.evidenceDigest,
        expectedRoutingContextDigest: fixture.routingContextDigest,
        observations: sabotaged,
      }),
    ).rejects.toThrow(/response_class does not match/);

    const observations = await messageObservationsOf(client, fixture.normalizedThreadId);
    expect(observations).toHaveLength(0);
    expect(await threadSummaryOf(client, fixture.normalizedThreadId)).toBeNull();
  });

  it("a SENT message impersonated as a reply class is refused, not silently coerced", async () => {
    const fixture = await eligibleThreadWithReply("b06-cp-sent-impersonation");
    const sabotaged = fixture.observations.map((o) =>
      o.provider_message_id === fixture.sentProviderMessageId
        ? {
            ...o,
            response_class: "qualifying_human_reply",
            relation_status: "thread_sequence_only",
          }
        : o,
    );

    await expect(
      commitRaw(client, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        normalizedThreadId: fixture.normalizedThreadId,
        expectedEvidenceDigest: fixture.evidenceDigest,
        expectedRoutingContextDigest: fixture.routingContextDigest,
        observations: sabotaged,
      }),
    ).rejects.toThrow(/response_class does not match/);

    expect(await messageObservationsOf(client, fixture.normalizedThreadId)).toHaveLength(0);
  });
});

d("B06 closure pass: exact set equality (§13)", () => {
  it("a missing observation refuses the whole commit as stale_source, nothing written", async () => {
    const fixture = await eligibleThreadWithReply("b06-cp-missing-obs");
    const incomplete = fixture.observations.filter(
      (o) => o.provider_message_id !== fixture.replyProviderMessageId,
    );

    const res = await commitRaw(client, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
      expectedEvidenceDigest: fixture.evidenceDigest,
      expectedRoutingContextDigest: fixture.routingContextDigest,
      observations: incomplete,
    });
    expect(res.rows[0].result.result).toBe("stale_source");
    expect(await messageObservationsOf(client, fixture.normalizedThreadId)).toHaveLength(0);
  });

  it("a duplicate observation for the same provider_message_id refuses the whole commit", async () => {
    const fixture = await eligibleThreadWithReply("b06-cp-duplicate-obs");
    const duplicated = [
      ...fixture.observations,
      fixture.observations.find((o) => o.provider_message_id === fixture.replyProviderMessageId)!,
    ];

    const res = await commitRaw(client, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
      expectedEvidenceDigest: fixture.evidenceDigest,
      expectedRoutingContextDigest: fixture.routingContextDigest,
      observations: duplicated,
    });
    expect(res.rows[0].result.result).toBe("stale_source");
    expect(await messageObservationsOf(client, fixture.normalizedThreadId)).toHaveLength(0);
  });

  it("a foreign provider_message_id from ANOTHER thread refuses the whole commit", async () => {
    const fixture = await eligibleThreadWithReply("b06-cp-foreign-id");
    const other = await eligibleThreadWithReply("b06-cp-foreign-id-donor");
    const withForeign = [
      ...fixture.observations,
      {
        provider_message_id: other.sentProviderMessageId,
        response_class: "creator_sent_touch",
        relation_status: null,
        referenced_creator_sent_provider_message_id: null,
      },
    ];

    const res = await commitRaw(client, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
      expectedEvidenceDigest: fixture.evidenceDigest,
      expectedRoutingContextDigest: fixture.routingContextDigest,
      observations: withForeign,
    });
    expect(res.rows[0].result.result).toBe("stale_source");
    expect(await messageObservationsOf(client, fixture.normalizedThreadId)).toHaveLength(0);
    // The donor thread's own observations must be untouched by the attempt.
    expect(await messageObservationsOf(client, other.normalizedThreadId)).toHaveLength(0);
  });
});

d("B06 closure pass: referenced-creator-send validation (§15)", () => {
  it("a referenced_creator_sent_provider_message_id that does not exist in this thread is refused", async () => {
    const fixture = await eligibleThreadWithReply("b06-cp-bad-reference");
    const sabotaged = fixture.observations.map((o) =>
      o.provider_message_id === fixture.replyProviderMessageId
        ? {
            ...o,
            relation_status: "direct_in_reply_to",
            referenced_creator_sent_provider_message_id: randomProviderId("nonexistent"),
          }
        : o,
    );

    await expect(
      commitRaw(client, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        normalizedThreadId: fixture.normalizedThreadId,
        expectedEvidenceDigest: fixture.evidenceDigest,
        expectedRoutingContextDigest: fixture.routingContextDigest,
        observations: sabotaged,
      }),
    ).rejects.toThrow(/does not resolve to a current creator-sent message/);
    expect(await messageObservationsOf(client, fixture.normalizedThreadId)).toHaveLength(0);
  });

  it("a referenced id pointing at a NON-creator-sent message in the same thread is refused", async () => {
    const fixture = await eligibleThreadWithReply("b06-cp-reference-not-sent");
    const sabotaged = fixture.observations.map((o) =>
      o.provider_message_id === fixture.replyProviderMessageId
        ? {
            ...o,
            relation_status: "direct_in_reply_to",
            // Points at ITSELF — a non-SENT message — never a valid creator-sent target.
            referenced_creator_sent_provider_message_id: fixture.replyProviderMessageId,
          }
        : o,
    );

    await expect(
      commitRaw(client, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        normalizedThreadId: fixture.normalizedThreadId,
        expectedEvidenceDigest: fixture.evidenceDigest,
        expectedRoutingContextDigest: fixture.routingContextDigest,
        observations: sabotaged,
      }),
    ).rejects.toThrow(/does not resolve to a current creator-sent message/);
    expect(await messageObservationsOf(client, fixture.normalizedThreadId)).toHaveLength(0);
  });

  it("direct_in_reply_to with a null referenced id is refused by the table's own biconditional shape", async () => {
    const fixture = await eligibleThreadWithReply("b06-cp-direct-null-ref");
    const sabotaged = fixture.observations.map((o) =>
      o.provider_message_id === fixture.replyProviderMessageId
        ? {
            ...o,
            relation_status: "direct_in_reply_to",
            referenced_creator_sent_provider_message_id: null,
          }
        : o,
    );

    await expect(
      commitRaw(client, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        normalizedThreadId: fixture.normalizedThreadId,
        expectedEvidenceDigest: fixture.evidenceDigest,
        expectedRoutingContextDigest: fixture.routingContextDigest,
        observations: sabotaged,
      }),
    ).rejects.toThrow();
    expect(await messageObservationsOf(client, fixture.normalizedThreadId)).toHaveLength(0);
  });
});

d("B06 closure pass: real B05-eligibility race (§6)", () => {
  it("a human rejection that commits WHILE this commit is mid-transaction is seen by the fresh re-check, never written past", async () => {
    const fixture = await eligibleThreadWithReply("b06-cp-eligibility-race");

    // Session A: hold the SAME `for share` lock on mail_accounts that a
    // concurrent decision-write's own `assert_may_process_locked` call would
    // hold mid-transaction — simulating "the decision's transaction is open,
    // not yet committed."
    const sA = await session();
    await sA.query("begin");
    await sA.query("select 1 from public.mail_accounts where id = $1 for share", [
      fixture.mailAccountId,
    ]);

    // Session B: the REAL commit RPC. `assert_may_process_locked`'s own
    // `for share` is compatible with A's — granted immediately — but the
    // commit's OWN `for update` upgrade (this function's real fence) must
    // block behind A's held share lock.
    const sB = await session();
    const pidB = await backendPid(sB);
    const commitPromise = commitRaw(sB, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
      expectedEvidenceDigest: fixture.evidenceDigest,
      expectedRoutingContextDigest: fixture.routingContextDigest,
      observations: fixture.observations,
    });

    const blockers = await waitUntilBlocked(pidB, 8000);
    const pidA = await backendPid(sA);
    expect(blockers).toContain(pidA);

    // WHILE B is blocked: A performs the decision write's actual effect
    // (inside A's own still-open transaction) and commits.
    await sA.query(
      `insert into private.gmail_outreach_creator_decisions
         (user_id, mail_account_id, normalized_thread_id, outreach_decision)
       values ($1, $2, $3, 'not_outreach_confirmed')`,
      [fixture.userId, fixture.mailAccountId, fixture.normalizedThreadId],
    );
    await sA.query("commit");

    // B's `for update` now succeeds; its FRESH eligibility re-check must see
    // the just-committed rejection — never write past it.
    const result = await commitPromise;
    expect(result.rows[0].result.result).toBe("not_eligible");
    expect(await messageObservationsOf(client, fixture.normalizedThreadId)).toHaveLength(0);
  });

  it("a real setOutreachHumanDecision call blocks behind an in-flight commit, and wins once the commit finishes", async () => {
    const fixture = await eligibleThreadWithReply("b06-cp-decision-blocks-behind-commit");

    // Session A holds `for update` on mail_accounts, simulating "a commit is
    // mid-transaction, past its own eligibility check."
    const sA = await session();
    await sA.query("begin");
    await sA.query("select 1 from public.mail_accounts where id = $1 for update", [
      fixture.mailAccountId,
    ]);

    const sB = await session();
    const pidB = await backendPid(sB);
    const decisionPromise = setOutreachHumanDecision(sB, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
      outreachDecision: "not_outreach_confirmed",
    });

    const blockers = await waitUntilBlocked(pidB, 8000);
    expect(blockers).toContain(await backendPid(sA));

    await sA.query("commit");
    await decisionPromise;

    const row = await client.query(
      `select outreach_decision from private.gmail_outreach_creator_decisions
        where mail_account_id = $1 and normalized_thread_id = $2`,
      [fixture.mailAccountId, fixture.normalizedThreadId],
    );
    expect(row.rows[0].outreach_decision).toBe("not_outreach_confirmed");
  });
});

d("B06 closure pass: observation-horizon staleness scheduling (§5)", () => {
  it("a thread stuck at observation_horizon_unknown is re-offered by list_candidates once a real B03 run proves a horizon — with zero message-evidence change", async () => {
    const fixture = await eligibleThreadWithReply("b06-cp-horizon-schedule");
    const deps = replyDeps(client);

    const commit1 = await commitInterpretation(deps, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
      expectedEvidenceDigest: fixture.evidenceDigest,
      expectedRoutingContextDigest: fixture.routingContextDigest,
      messageObservations: fixture.messageObservations,
    });
    expect(commit1.result).toBe("ok");

    const beforeCandidates = await listCandidates(deps, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      limit: 10,
    });
    const beforeEntry = beforeCandidates.candidates.find(
      (c) => c.normalizedThreadId === fixture.normalizedThreadId,
    );
    // Immediately after a fresh commit with unknown horizon, the thread is
    // NOT offered again (nothing about source/rules/horizon has moved yet).
    expect(beforeEntry).toBeUndefined();

    // A real B03 run now proves a horizon for the EXACT provider thread — no
    // message evidence changes at all.
    await insertObservedHorizon(client, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      providerThreadId: fixture.providerThreadId,
      windowStartAt: new Date(Date.now() - DAY),
      windowEndAt: new Date(),
    });

    const afterCandidates = await listCandidates(deps, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      limit: 10,
    });
    const afterEntry = afterCandidates.candidates.find(
      (c) => c.normalizedThreadId === fixture.normalizedThreadId,
    );
    expect(afterEntry).toBeDefined();
    expect(afterEntry!.staleness.horizonStale).toBe(true);
    expect(afterEntry!.staleness.sourceStale).toBe(false);
  });
});

d("B06 closure pass: cross-user/cross-account hostile RPC (§22)", () => {
  it("user A cannot read user B's thread evidence via gmail_reply_get_thread_evidence", async () => {
    const a = await eligibleThreadWithReply("b06-cp-cross-user-a");
    const b = await eligibleThreadWithReply("b06-cp-cross-user-b");
    const deps = replyDeps(client);

    const crossRead = await getThreadEvidence(deps, {
      userId: a.userId,
      mailAccountId: a.mailAccountId,
      normalizedThreadId: b.normalizedThreadId,
    });
    expect(crossRead.result).toBe("not_found");
  });

  it("a commit payload naming a provider id from ANOTHER mailbox is refused, not cross-account written", async () => {
    const a = await eligibleThreadWithReply("b06-cp-cross-account-a");
    const b = await eligibleThreadWithReply("b06-cp-cross-account-b");

    const withCrossAccountId = [
      ...a.observations,
      {
        provider_message_id: b.sentProviderMessageId,
        response_class: "creator_sent_touch",
        relation_status: null,
        referenced_creator_sent_provider_message_id: null,
      },
    ];

    const res = await commitRaw(client, {
      userId: a.userId,
      mailAccountId: a.mailAccountId,
      normalizedThreadId: a.normalizedThreadId,
      expectedEvidenceDigest: a.evidenceDigest,
      expectedRoutingContextDigest: a.routingContextDigest,
      observations: withCrossAccountId,
    });
    expect(res.rows[0].result.result).toBe("stale_source");
    expect(await messageObservationsOf(client, a.normalizedThreadId)).toHaveLength(0);
    expect(await messageObservationsOf(client, b.normalizedThreadId)).toHaveLength(0);
  });

  it("account A's user_id cannot commit against account B's mail_account_id/thread", async () => {
    const a = await eligibleThreadWithReply("b06-cp-wrong-account-a");
    const b = await eligibleThreadWithReply("b06-cp-wrong-account-b");

    // `assert_may_process_locked` authorizes purely on `mail_account_id`
    // (consent/lifecycle), so the mismatched pair reaches the INSERT —
    // where the `(mail_account_id, user_id)` foreign key to `mail_accounts`
    // has no matching row for A's user_id under B's account, and the whole
    // statement is refused with a hard error. Never a successful, let alone
    // silent, cross-user write.
    await expect(
      commitRaw(client, {
        userId: a.userId,
        mailAccountId: b.mailAccountId,
        normalizedThreadId: b.normalizedThreadId,
        expectedEvidenceDigest: b.evidenceDigest,
        expectedRoutingContextDigest: b.routingContextDigest,
        observations: b.observations,
      }),
    ).rejects.toThrow(/foreign key constraint/);
    expect(await messageObservationsOf(client, b.normalizedThreadId)).toHaveLength(0);
  });
});

d("B06 closure pass: equal-time/tie semantics, DB round-trip (§17)", () => {
  it("two creator sends tied for earliest: timestamp known, identity null, at both the message and thread level", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b06-cp-tie-first-creator");
    const providerThreadId = randomProviderId("thread");
    const t0 = Date.now() - DAY;

    const sentA = await insertMessage(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("sentA"),
      providerThreadId,
      internalDateMs: t0,
      sent: true,
    });
    await insertMessage(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("sentB"),
      providerThreadId,
      internalDateMs: t0,
      sent: true,
    });
    await setOutreachMachineStatus(client, {
      userId,
      mailAccountId,
      normalizedThreadId: sentA.normalizedThreadId,
      outreachStatus: "qualified_outreach",
    });

    const deps = replyDeps(client);
    const evidence = await getThreadEvidence(deps, {
      userId,
      mailAccountId,
      normalizedThreadId: sentA.normalizedThreadId,
    });
    if (evidence.result !== "ok") throw new Error("unreachable");
    const interpretation = interpretThread({
      messages: evidence.evidence.messages,
      referenceTokens: evidence.evidence.referenceTokens,
      participants: evidence.evidence.participants,
      subjects: evidence.evidence.subjects,
      textParts: evidence.evidence.textParts,
      mailAccountEmail: evidence.evidence.mailAccountEmail,
      observedThroughAtMs: null,
    });
    expect(interpretation.threadSummary.firstCreatorSentTied).toBe(true);
    expect(interpretation.threadSummary.firstCreatorSentProviderMessageId).toBeNull();
    expect(interpretation.threadSummary.firstCreatorSentAtMs).toBe(t0);

    const commit = await commitInterpretation(deps, {
      userId,
      mailAccountId,
      normalizedThreadId: sentA.normalizedThreadId,
      expectedEvidenceDigest: evidence.evidence.evidenceDigest,
      expectedRoutingContextDigest: evidence.evidence.routingContextDigest,
      messageObservations: interpretation.messageObservations,
    });
    expect(commit.result).toBe("ok");

    const summary = await threadSummaryOf(client, sentA.normalizedThreadId);
    expect(summary.first_creator_sent_tied).toBe(true);
    expect(summary.first_creator_sent_provider_message_id).toBeNull();
    expect(new Date(summary.first_creator_sent_at).getTime()).toBe(t0);
  });

  it("two qualifying replies tied for earliest: reply-observed state holds, timestamp/count known, identity null — replay with reversed provider-id lexical order converges to the SAME epistemic result", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b06-cp-tie-first-reply");
    const providerThreadId = randomProviderId("thread");
    const t0 = Date.now() - DAY;
    const sentMid = `<${randomProviderId("mid")}@creator.example>`;

    const sent = await insertMessage(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("sent"),
      providerThreadId,
      internalDateMs: t0,
      sent: true,
      messageId: sentMid,
    });
    const replyT = t0 + 3_600_000;
    // Two DIFFERENT reply identities intentionally chosen so a naive lexical
    // sort would pick a different "first" depending on id ordering — the
    // point is that neither should ever be reported as the identity.
    const replyIds = ["zzz-" + randomProviderId("reply"), "aaa-" + randomProviderId("reply")];
    for (const id of replyIds) {
      await insertMessage(client, {
        userId,
        mailAccountId,
        providerMessageId: id,
        providerThreadId,
        internalDateMs: replyT,
        sent: false,
        from: `brand-${id}@example.com`,
        subject: "Re:",
        bodyText: `reply text ${id}`,
      });
    }
    await setOutreachMachineStatus(client, {
      userId,
      mailAccountId,
      normalizedThreadId: sent.normalizedThreadId,
      outreachStatus: "qualified_outreach",
    });

    const deps = replyDeps(client);
    const evidence = await getThreadEvidence(deps, {
      userId,
      mailAccountId,
      normalizedThreadId: sent.normalizedThreadId,
    });
    if (evidence.result !== "ok") throw new Error("unreachable");
    const interpretation = interpretThread({
      messages: evidence.evidence.messages,
      referenceTokens: evidence.evidence.referenceTokens,
      participants: evidence.evidence.participants,
      subjects: evidence.evidence.subjects,
      textParts: evidence.evidence.textParts,
      mailAccountEmail: evidence.evidence.mailAccountEmail,
      observedThroughAtMs: null,
    });

    expect(interpretation.threadSummary.observationState).toBe("qualifying_human_reply_observed");
    expect(interpretation.threadSummary.firstQualifyingHumanReplyTied).toBe(true);
    expect(interpretation.threadSummary.firstQualifyingHumanReplyProviderMessageId).toBeNull();
    expect(interpretation.threadSummary.firstQualifyingHumanReplyAtMs).toBe(replyT);
    // The known timestamp must not destroy CLOCK A's latency even though
    // the reply's own singular identity is ambiguous.
    expect(interpretation.threadSummary.latencyFromFirstCreatorSentMs).toBe(replyT - t0);

    const commit = await commitInterpretation(deps, {
      userId,
      mailAccountId,
      normalizedThreadId: sent.normalizedThreadId,
      expectedEvidenceDigest: evidence.evidence.evidenceDigest,
      expectedRoutingContextDigest: evidence.evidence.routingContextDigest,
      messageObservations: interpretation.messageObservations,
    });
    expect(commit.result).toBe("ok");

    const summary = await threadSummaryOf(client, sent.normalizedThreadId);
    expect(summary.observation_state).toBe("qualifying_human_reply_observed");
    expect(summary.first_qualifying_human_reply_tied).toBe(true);
    expect(summary.first_qualifying_human_reply_provider_message_id).toBeNull();
    expect(Number(summary.latency_from_first_creator_sent_ms)).toBe(replyT - t0);
  });
});

d("B06 closure pass: zero side-effect boundary, comprehensive (§24)", () => {
  it("committing a real interpretation touches none of the forbidden product tables", async () => {
    const forbiddenTables = [
      "public.pipeline_items",
      "public.outreach_events",
      "public.collaborations",
      "public.hotels",
      "public.organizations",
      "public.hotel_contacts",
      "public.organization_contacts",
      "private.gmail_outreach_creator_decisions",
      "private.gmail_outreach_creator_decision_events",
    ];
    const before: Record<string, number> = {};
    for (const table of forbiddenTables) {
      const res = await client.query(`select count(*)::int as n from ${table}`);
      before[table] = res.rows[0].n;
    }

    const fixture = await eligibleThreadWithReply("b06-cp-zero-side-effect");
    const deps = replyDeps(client);
    const commit = await commitInterpretation(deps, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
      expectedEvidenceDigest: fixture.evidenceDigest,
      expectedRoutingContextDigest: fixture.routingContextDigest,
      messageObservations: fixture.messageObservations,
    });
    expect(commit.result).toBe("ok");

    for (const table of forbiddenTables) {
      const res = await client.query(`select count(*)::int as n from ${table}`);
      // `gmail_outreach_creator_decisions`/`_events` are B05 HUMAN tables —
      // B06 must create zero rows in them even incidentally; any OTHER
      // pre-existing rows from fixture setup are untouched (exact count, not
      // just "no increase", since B06 must never even READ-then-rewrite one).
      expect(res.rows[0].n, table).toBe(before[table]);
    }
  });
});

// =============================================================================
// B06 FINAL CLOSURE — three remaining external-review invariants
// =============================================================================
// Blocker A: the mailbox's own routing address is a classification
// DEPENDENCY (contract §8.1) that lives entirely outside the B04
// message-evidence digest — a routing change must be fenced exactly like a
// source-evidence change. Blocker B: an EXACT replay (identical source,
// routing, horizon, eligibility, and all three rule/transform versions) must
// perform ZERO writes. Blocker C: `list_candidates`/`get_thread_evidence`/
// `status` must agree on current-vs-stale for EVERY dependency, because all
// three now call the ONE shared `private.gmail_reply_thread_summary_is_stale`.

d("B06 FINAL CLOSURE §A: routing-context fence (real sessions)", () => {
  it("a routing-address change committed WHILE a commit is blocked on mail_accounts is seen by the fresh re-check — the stale, A-computed commit is refused with zero mutation, then list_candidates re-offers and a fresh B-computed evaluation succeeds", async () => {
    const fixture = await eligibleThreadWithReply("b06-fc-routing-race");

    // Session A: hold `for update` on mail_accounts, simulating "the routing
    // change's own transaction is open, not yet committed" — the SAME shape
    // as the existing B05-eligibility-race test above.
    const sA = await session();
    await sA.query("begin");
    await sA.query("select 1 from public.mail_accounts where id = $1 for update", [
      fixture.mailAccountId,
    ]);

    // Session B: the REAL commit RPC, carrying the STALE routing digest
    // `fixture` read BEFORE any change — this is "Session A" from the
    // prompt's own naming (the commit computed under the OLD routing
    // address); it must block behind the row lock above.
    const sB = await session();
    const pidB = await backendPid(sB);
    const staleCommitPromise = commitRaw(sB, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
      expectedEvidenceDigest: fixture.evidenceDigest,
      expectedRoutingContextDigest: fixture.routingContextDigest,
      observations: fixture.observations,
    });

    const blockers = await waitUntilBlocked(pidB, 8000);
    expect(blockers).toContain(await backendPid(sA));

    // WHILE the stale commit is blocked: the routing address actually
    // changes and that change commits.
    const newEmail = `${fixture.mailAccountId}-changed@example.invalid`;
    await sA.query("update public.mail_accounts set email_address = $2 where id = $1", [
      fixture.mailAccountId,
      newEmail,
    ]);
    await sA.query("commit");

    // The stale commit's `for update` now succeeds; its FRESH routing digest
    // (recomputed from the just-committed row) no longer matches what it was
    // told to expect — refused, zero mutation.
    const staleResult = await staleCommitPromise;
    expect(staleResult.rows[0].result.result).toBe("stale_source");
    expect(await messageObservationsOf(client, fixture.normalizedThreadId)).toHaveLength(0);
    expect(await threadSummaryOf(client, fixture.normalizedThreadId)).toBeNull();

    // `list_candidates` must re-offer the thread. No summary was ever
    // successfully committed (the stale attempt above wrote nothing), so
    // every per-dimension flag reports true trivially (`sm.id is null`) —
    // the dedicated "zero B04 message change" proof, with an EXISTING
    // summary to compare against, lives in the §C routing matrix case below.
    const deps = replyDeps(client);
    const candidates = await listCandidates(deps, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      limit: 10,
    });
    const entry = candidates.candidates.find(
      (c) => c.normalizedThreadId === fixture.normalizedThreadId,
    );
    expect(entry).toBeDefined();
    expect(entry!.staleness.routingStale).toBe(true);

    // A fresh evaluation under the NEW routing address succeeds and commits.
    const freshEvidence = await getThreadEvidence(deps, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
    });
    if (freshEvidence.result !== "ok") throw new Error("unreachable");
    expect(freshEvidence.evidence.mailAccountEmail).toBe(newEmail);
    expect(freshEvidence.evidence.routingContextDigest).not.toBe(fixture.routingContextDigest);

    const freshInterpretation = interpretThread({
      messages: freshEvidence.evidence.messages,
      referenceTokens: freshEvidence.evidence.referenceTokens,
      participants: freshEvidence.evidence.participants,
      subjects: freshEvidence.evidence.subjects,
      textParts: freshEvidence.evidence.textParts,
      mailAccountEmail: freshEvidence.evidence.mailAccountEmail,
      observedThroughAtMs: null,
    });
    const freshCommit = await commitInterpretation(deps, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
      expectedEvidenceDigest: freshEvidence.evidence.evidenceDigest,
      expectedRoutingContextDigest: freshEvidence.evidence.routingContextDigest,
      messageObservations: freshInterpretation.messageObservations,
    });
    expect(freshCommit).toEqual({
      result: "ok",
      evidenceDigest: freshEvidence.evidence.evidenceDigest,
      committed: true,
    });
    expect(await threadSummaryOf(client, fixture.normalizedThreadId)).not.toBeNull();
  });

  it("A -> NULL routing email: a commit carrying the OLD (non-null) routing digest is refused as stale", async () => {
    const fixture = await eligibleThreadWithReply("b06-fc-routing-to-null");
    await client.query("update public.mail_accounts set email_address = null where id = $1", [
      fixture.mailAccountId,
    ]);

    const res = await commitRaw(client, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
      expectedEvidenceDigest: fixture.evidenceDigest,
      expectedRoutingContextDigest: fixture.routingContextDigest,
      observations: fixture.observations,
    });
    expect(res.rows[0].result.result).toBe("stale_source");
    expect(await messageObservationsOf(client, fixture.normalizedThreadId)).toHaveLength(0);
  });

  it("NULL -> A routing email: a commit carrying the OLD (null-sentinel) routing digest is refused as stale", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b06-fc-routing-from-null");
    await client.query("update public.mail_accounts set email_address = null where id = $1", [
      mailAccountId,
    ]);
    const providerThreadId = randomProviderId("thread");
    const sent = await insertMessage(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("sent"),
      providerThreadId,
      internalDateMs: Date.now() - DAY,
      sent: true,
    });
    await setOutreachMachineStatus(client, {
      userId,
      mailAccountId,
      normalizedThreadId: sent.normalizedThreadId,
      outreachStatus: "qualified_outreach",
    });

    const deps = replyDeps(client);
    const evidence = await getThreadEvidence(deps, {
      userId,
      mailAccountId,
      normalizedThreadId: sent.normalizedThreadId,
    });
    if (evidence.result !== "ok") throw new Error("unreachable");
    expect(evidence.evidence.mailAccountEmail).toBeNull();
    const staleRoutingDigest = evidence.evidence.routingContextDigest;
    const interpretation = interpretThread({
      messages: evidence.evidence.messages,
      referenceTokens: evidence.evidence.referenceTokens,
      participants: evidence.evidence.participants,
      subjects: evidence.evidence.subjects,
      textParts: evidence.evidence.textParts,
      mailAccountEmail: evidence.evidence.mailAccountEmail,
      observedThroughAtMs: null,
    });

    await client.query("update public.mail_accounts set email_address = $2 where id = $1", [
      mailAccountId,
      "creator@example.invalid",
    ]);

    const res = await commitRaw(client, {
      userId,
      mailAccountId,
      normalizedThreadId: sent.normalizedThreadId,
      expectedEvidenceDigest: evidence.evidence.evidenceDigest,
      expectedRoutingContextDigest: staleRoutingDigest,
      observations: interpretation.messageObservations.map((o) => ({
        provider_message_id: o.providerMessageId,
        response_class: o.responseClass,
        relation_status: o.relationStatus,
        referenced_creator_sent_provider_message_id: o.referencedCreatorSentProviderMessageId,
      })),
    });
    expect(res.rows[0].result.result).toBe("stale_source");
    expect(await messageObservationsOf(client, sent.normalizedThreadId)).toHaveLength(0);
  });

  it("a case/whitespace-only routing-address change normalizes to the SAME digest — no stale refusal", async () => {
    const fixture = await eligibleThreadWithReply("b06-fc-routing-case-only");
    const original = await client.query(
      "select email_address from public.mail_accounts where id = $1",
      [fixture.mailAccountId],
    );
    const changedCase = `  ${(original.rows[0].email_address as string).toUpperCase()}  `;
    await client.query("update public.mail_accounts set email_address = $2 where id = $1", [
      fixture.mailAccountId,
      changedCase,
    ]);

    const commit = await commitRaw(client, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
      expectedEvidenceDigest: fixture.evidenceDigest,
      expectedRoutingContextDigest: fixture.routingContextDigest,
      observations: fixture.observations,
    });
    expect(commit.rows[0].result.result).toBe("ok");
    expect(commit.rows[0].result.committed).toBe(true);
  });
});

d("B06 FINAL CLOSURE §B: exact zero-write replay", () => {
  it("an EXACT replay (identical source/routing/horizon/eligibility/versions) is already_current/committed:false and performs ZERO writes — unchanged ids, evaluated_at, updated_at, and row version (xmin)", async () => {
    const fixture = await eligibleThreadWithReply("b06-fc-exact-replay");
    const deps = replyDeps(client);

    const first = await commitInterpretation(deps, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
      expectedEvidenceDigest: fixture.evidenceDigest,
      expectedRoutingContextDigest: fixture.routingContextDigest,
      messageObservations: fixture.messageObservations,
    });
    expect(first).toEqual({
      result: "ok",
      evidenceDigest: fixture.evidenceDigest,
      committed: true,
    });

    const rowSnapshot = async () => ({
      observations: (
        await client.query(
          `select id, evaluated_at, updated_at, xmin::text as xmin
             from private.gmail_reply_message_observations
            where normalized_thread_id = $1
            order by provider_message_id`,
          [fixture.normalizedThreadId],
        )
      ).rows,
      summary: (
        await client.query(
          `select id, evaluated_at, updated_at, xmin::text as xmin
             from private.gmail_reply_thread_summaries
            where normalized_thread_id = $1`,
          [fixture.normalizedThreadId],
        )
      ).rows,
    });

    const before = await rowSnapshot();
    expect(before.observations.length).toBeGreaterThan(0);
    expect(before.summary).toHaveLength(1);

    // Re-read fresh evidence exactly as a real caller would before ANY
    // commit attempt — identical source/routing/horizon/eligibility/versions.
    const evidence = await getThreadEvidence(deps, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
    });
    if (evidence.result !== "ok") throw new Error("unreachable");
    const interpretation = interpretThread({
      messages: evidence.evidence.messages,
      referenceTokens: evidence.evidence.referenceTokens,
      participants: evidence.evidence.participants,
      subjects: evidence.evidence.subjects,
      textParts: evidence.evidence.textParts,
      mailAccountEmail: evidence.evidence.mailAccountEmail,
      observedThroughAtMs: evidence.evidence.observedThroughAt
        ? Date.parse(evidence.evidence.observedThroughAt)
        : null,
    });

    const replay = await commitInterpretation(deps, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
      expectedEvidenceDigest: evidence.evidence.evidenceDigest,
      expectedRoutingContextDigest: evidence.evidence.routingContextDigest,
      messageObservations: interpretation.messageObservations,
    });
    // The DB's own already_current no-op verdict, surfaced as an ordinary
    // `ok` with `committed: false` — never a distinct result variant.
    expect(replay).toEqual({
      result: "ok",
      evidenceDigest: fixture.evidenceDigest,
      committed: false,
    });

    const after = await rowSnapshot();
    // Deep equality — not merely "same count" — proves every id, every
    // evaluated_at, every updated_at, and every row's own Postgres row
    // version (xmin) is byte-identical: the replay touched NOTHING.
    expect(after.observations).toEqual(before.observations);
    expect(after.summary).toEqual(before.summary);
  });
});

d(
  "B06 AUDIT CORRECTION, FINDING 1: already_current requires an IDENTICAL semantic payload, not merely a matching context",
  () => {
    it("case 1 — omitting one observation from an already-current thread is refused as stale_source, never already_current, zero writes", async () => {
      const fixture = await eligibleThreadWithReply("b06-ac1-omit");
      const deps = replyDeps(client);
      const commit1 = await commitInterpretation(deps, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        normalizedThreadId: fixture.normalizedThreadId,
        expectedEvidenceDigest: fixture.evidenceDigest,
        expectedRoutingContextDigest: fixture.routingContextDigest,
        messageObservations: fixture.messageObservations,
      });
      expect(commit1.result).toBe("ok");

      const before = await snapshotThreadRows(fixture.normalizedThreadId);
      const incomplete = fixture.observations.filter(
        (o) => o.provider_message_id !== fixture.replyProviderMessageId,
      );
      const res = await commitRaw(client, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        normalizedThreadId: fixture.normalizedThreadId,
        expectedEvidenceDigest: fixture.evidenceDigest,
        expectedRoutingContextDigest: fixture.routingContextDigest,
        observations: incomplete,
      });
      expect(res.rows[0].result.result).toBe("stale_source");
      expect(await snapshotThreadRows(fixture.normalizedThreadId)).toEqual(before);
    });

    it("case 2 — duplicating one observation on an already-current thread is refused as stale_source, never already_current, zero writes", async () => {
      const fixture = await eligibleThreadWithReply("b06-ac1-duplicate");
      const deps = replyDeps(client);
      const commit1 = await commitInterpretation(deps, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        normalizedThreadId: fixture.normalizedThreadId,
        expectedEvidenceDigest: fixture.evidenceDigest,
        expectedRoutingContextDigest: fixture.routingContextDigest,
        messageObservations: fixture.messageObservations,
      });
      expect(commit1.result).toBe("ok");

      const before = await snapshotThreadRows(fixture.normalizedThreadId);
      const duplicated = [
        ...fixture.observations,
        fixture.observations.find((o) => o.provider_message_id === fixture.replyProviderMessageId)!,
      ];
      const res = await commitRaw(client, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        normalizedThreadId: fixture.normalizedThreadId,
        expectedEvidenceDigest: fixture.evidenceDigest,
        expectedRoutingContextDigest: fixture.routingContextDigest,
        observations: duplicated,
      });
      expect(res.rows[0].result.result).toBe("stale_source");
      expect(await snapshotThreadRows(fixture.normalizedThreadId)).toEqual(before);
    });

    it("case 3 — a foreign provider_message_id from ANOTHER thread on an already-current thread is refused as stale_source, never already_current, zero writes", async () => {
      const fixture = await eligibleThreadWithReply("b06-ac1-foreign");
      const donor = await eligibleThreadWithReply("b06-ac1-foreign-donor");
      const deps = replyDeps(client);
      const commit1 = await commitInterpretation(deps, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        normalizedThreadId: fixture.normalizedThreadId,
        expectedEvidenceDigest: fixture.evidenceDigest,
        expectedRoutingContextDigest: fixture.routingContextDigest,
        messageObservations: fixture.messageObservations,
      });
      expect(commit1.result).toBe("ok");

      const before = await snapshotThreadRows(fixture.normalizedThreadId);
      const withForeign = [
        ...fixture.observations,
        {
          provider_message_id: donor.sentProviderMessageId,
          response_class: "creator_sent_touch",
          relation_status: null,
          referenced_creator_sent_provider_message_id: null,
        },
      ];
      const res = await commitRaw(client, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        normalizedThreadId: fixture.normalizedThreadId,
        expectedEvidenceDigest: fixture.evidenceDigest,
        expectedRoutingContextDigest: fixture.routingContextDigest,
        observations: withForeign,
      });
      expect(res.rows[0].result.result).toBe("stale_source");
      expect(await snapshotThreadRows(fixture.normalizedThreadId)).toEqual(before);
    });

    it("case 4 — changing a non-SENT response_class alone (structurally valid, semantically DIFFERENT) is refused as interpretation_mismatch, never already_current, zero writes", async () => {
      const fixture = await eligibleThreadWithReply("b06-ac1-response-class");
      const deps = replyDeps(client);
      const commit1 = await commitInterpretation(deps, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        normalizedThreadId: fixture.normalizedThreadId,
        expectedEvidenceDigest: fixture.evidenceDigest,
        expectedRoutingContextDigest: fixture.routingContextDigest,
        messageObservations: fixture.messageObservations,
      });
      expect(commit1.result).toBe("ok");

      const before = await snapshotThreadRows(fixture.normalizedThreadId);
      const sabotaged = fixture.observations.map((o) =>
        o.provider_message_id === fixture.replyProviderMessageId
          ? { ...o, response_class: "ambiguous_inbound" }
          : o,
      );
      await expect(
        commitRaw(client, {
          userId: fixture.userId,
          mailAccountId: fixture.mailAccountId,
          normalizedThreadId: fixture.normalizedThreadId,
          expectedEvidenceDigest: fixture.evidenceDigest,
          expectedRoutingContextDigest: fixture.routingContextDigest,
          observations: sabotaged,
        }),
      ).rejects.toThrow(/interpretation_mismatch/);
      expect(await snapshotThreadRows(fixture.normalizedThreadId)).toEqual(before);
    });

    it("case 5 — falsely reporting the SENT message's response_class as anything other than creator_sent_touch is refused via the existing shape check, never already_current, zero writes", async () => {
      const fixture = await eligibleThreadWithReply("b06-ac1-sent-shape");
      const deps = replyDeps(client);
      const commit1 = await commitInterpretation(deps, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        normalizedThreadId: fixture.normalizedThreadId,
        expectedEvidenceDigest: fixture.evidenceDigest,
        expectedRoutingContextDigest: fixture.routingContextDigest,
        messageObservations: fixture.messageObservations,
      });
      expect(commit1.result).toBe("ok");

      const before = await snapshotThreadRows(fixture.normalizedThreadId);
      const sabotaged = fixture.observations.map((o) =>
        o.provider_message_id === fixture.sentProviderMessageId
          ? {
              ...o,
              response_class: "qualifying_human_reply",
              relation_status: "thread_sequence_only",
            }
          : o,
      );
      await expect(
        commitRaw(client, {
          userId: fixture.userId,
          mailAccountId: fixture.mailAccountId,
          normalizedThreadId: fixture.normalizedThreadId,
          expectedEvidenceDigest: fixture.evidenceDigest,
          expectedRoutingContextDigest: fixture.routingContextDigest,
          observations: sabotaged,
        }),
      ).rejects.toThrow(/response_class does not match/);
      expect(await snapshotThreadRows(fixture.normalizedThreadId)).toEqual(before);
    });

    it("case 6 — changing relation_status alone (structurally valid, semantically DIFFERENT) is refused as interpretation_mismatch, never already_current, zero writes", async () => {
      const fixture = await eligibleThreadWithReply("b06-ac1-relation-status");
      const deps = replyDeps(client);
      const commit1 = await commitInterpretation(deps, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        normalizedThreadId: fixture.normalizedThreadId,
        expectedEvidenceDigest: fixture.evidenceDigest,
        expectedRoutingContextDigest: fixture.routingContextDigest,
        messageObservations: fixture.messageObservations,
      });
      expect(commit1.result).toBe("ok");

      const before = await snapshotThreadRows(fixture.normalizedThreadId);
      // Leaves `referenced_creator_sent_provider_message_id` untouched (still
      // resolving validly) so ONLY `relation_status` differs — proving this
      // is caught by the NEW semantic comparison, not the pre-existing
      // reference-resolution check.
      const sabotaged = fixture.observations.map((o) =>
        o.provider_message_id === fixture.replyProviderMessageId
          ? { ...o, relation_status: "thread_sequence_only" }
          : o,
      );
      await expect(
        commitRaw(client, {
          userId: fixture.userId,
          mailAccountId: fixture.mailAccountId,
          normalizedThreadId: fixture.normalizedThreadId,
          expectedEvidenceDigest: fixture.evidenceDigest,
          expectedRoutingContextDigest: fixture.routingContextDigest,
          observations: sabotaged,
        }),
      ).rejects.toThrow(/interpretation_mismatch/);
      expect(await snapshotThreadRows(fixture.normalizedThreadId)).toEqual(before);
    });

    it("case 7 — an invalid referenced creator-send id is refused via the existing reference-validation check, never already_current, zero writes", async () => {
      const fixture = await eligibleThreadWithReply("b06-ac1-bad-reference");
      const deps = replyDeps(client);
      const commit1 = await commitInterpretation(deps, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        normalizedThreadId: fixture.normalizedThreadId,
        expectedEvidenceDigest: fixture.evidenceDigest,
        expectedRoutingContextDigest: fixture.routingContextDigest,
        messageObservations: fixture.messageObservations,
      });
      expect(commit1.result).toBe("ok");

      const before = await snapshotThreadRows(fixture.normalizedThreadId);
      const sabotaged = fixture.observations.map((o) =>
        o.provider_message_id === fixture.replyProviderMessageId
          ? {
              ...o,
              referenced_creator_sent_provider_message_id: randomProviderId("nonexistent"),
            }
          : o,
      );
      await expect(
        commitRaw(client, {
          userId: fixture.userId,
          mailAccountId: fixture.mailAccountId,
          normalizedThreadId: fixture.normalizedThreadId,
          expectedEvidenceDigest: fixture.evidenceDigest,
          expectedRoutingContextDigest: fixture.routingContextDigest,
          observations: sabotaged,
        }),
      ).rejects.toThrow(/does not resolve to a current creator-sent message/);
      expect(await snapshotThreadRows(fixture.normalizedThreadId)).toEqual(before);
    });

    it("the genuinely IDENTICAL payload still returns already_current/committed:false, with the same zero-write proof", async () => {
      const fixture = await eligibleThreadWithReply("b06-ac1-true-replay");
      const deps = replyDeps(client);
      const commit1 = await commitInterpretation(deps, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        normalizedThreadId: fixture.normalizedThreadId,
        expectedEvidenceDigest: fixture.evidenceDigest,
        expectedRoutingContextDigest: fixture.routingContextDigest,
        messageObservations: fixture.messageObservations,
      });
      expect(commit1.result).toBe("ok");

      const before = await snapshotThreadRows(fixture.normalizedThreadId);
      const replay = await commitRaw(client, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        normalizedThreadId: fixture.normalizedThreadId,
        expectedEvidenceDigest: fixture.evidenceDigest,
        expectedRoutingContextDigest: fixture.routingContextDigest,
        observations: fixture.observations,
      });
      expect(replay.rows[0].result).toEqual({
        result: "already_current",
        evidence_digest: fixture.evidenceDigest,
        committed: false,
      });
      expect(await snapshotThreadRows(fixture.normalizedThreadId)).toEqual(before);
    });
  },
);

d("B06 AUDIT CORRECTION, FINDING 2: routing normalization parity (DB-level)", () => {
  it("C: a whitespace/case-only mailbox storage change leaves the routing digest, and the committed summary's currentness, UNCHANGED", async () => {
    const fixture = await eligibleThreadWithReply("b06-ac2-whitespace-case");
    const deps = replyDeps(client);
    const commit1 = await commitInterpretation(deps, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
      expectedEvidenceDigest: fixture.evidenceDigest,
      expectedRoutingContextDigest: fixture.routingContextDigest,
      messageObservations: fixture.messageObservations,
    });
    expect(commit1.result).toBe("ok");

    const original = await client.query(
      "select email_address from public.mail_accounts where id = $1",
      [fixture.mailAccountId],
    );
    const originalEmail = original.rows[0].email_address as string;
    const whitespaceVariant = `  ${originalEmail.toUpperCase()}  `;
    await client.query("update public.mail_accounts set email_address = $2 where id = $1", [
      fixture.mailAccountId,
      whitespaceVariant,
    ]);

    const evidence = await getThreadEvidence(deps, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
    });
    if (evidence.result !== "ok") throw new Error("unreachable");
    expect(evidence.evidence.routingContextDigest).toBe(fixture.routingContextDigest);
    expect(evidence.evidence.currentSummaryIsStale).toBe(false);

    const candidates = await listCandidates(deps, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      limit: 10,
    });
    expect(
      candidates.candidates.some((c) => c.normalizedThreadId === fixture.normalizedThreadId),
    ).toBe(false);

    const status = await getStatus(deps, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
    });
    expect(status.staleThreadSummaries).toBe(0);

    // No qualifying-human false positive: classification computed under
    // the whitespace/case-variant mailbox value is byte-identical to what
    // was computed (and committed) under the original value.
    const interpretation = interpretThread({
      messages: evidence.evidence.messages,
      referenceTokens: evidence.evidence.referenceTokens,
      participants: evidence.evidence.participants,
      subjects: evidence.evidence.subjects,
      textParts: evidence.evidence.textParts,
      mailAccountEmail: evidence.evidence.mailAccountEmail,
      observedThroughAtMs: null,
    });
    expect(interpretation.messageObservations).toEqual(fixture.messageObservations);

    // The now-current routing digest still commits as an ordinary replay
    // — it was never actually stale.
    const replay = await commitInterpretation(deps, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
      expectedEvidenceDigest: evidence.evidence.evidenceDigest,
      expectedRoutingContextDigest: evidence.evidence.routingContextDigest,
      messageObservations: interpretation.messageObservations,
    });
    expect(replay).toEqual({
      result: "ok",
      evidenceDigest: fixture.evidenceDigest,
      committed: false,
    });
  });

  it("D: a genuinely DIFFERENT mailbox address changes the routing digest, flips staleness, refuses the old interpretation, and a fresh evaluation uses the new identity", async () => {
    const fixture = await eligibleThreadWithReply("b06-ac2-genuine-change");
    const deps = replyDeps(client);
    const commit1 = await commitInterpretation(deps, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
      expectedEvidenceDigest: fixture.evidenceDigest,
      expectedRoutingContextDigest: fixture.routingContextDigest,
      messageObservations: fixture.messageObservations,
    });
    expect(commit1.result).toBe("ok");

    await client.query("update public.mail_accounts set email_address = $2 where id = $1", [
      fixture.mailAccountId,
      "genuinely-different@example.invalid",
    ]);

    const evidence = await getThreadEvidence(deps, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
    });
    if (evidence.result !== "ok") throw new Error("unreachable");
    expect(evidence.evidence.routingContextDigest).not.toBe(fixture.routingContextDigest);
    expect(evidence.evidence.currentSummaryIsStale).toBe(true);

    const candidates = await listCandidates(deps, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      limit: 10,
    });
    const entry = candidates.candidates.find(
      (c) => c.normalizedThreadId === fixture.normalizedThreadId,
    );
    expect(entry).toBeDefined();
    expect(entry!.staleness.routingStale).toBe(true);

    const status = await getStatus(deps, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
    });
    expect(status.staleThreadSummaries).toBe(1);

    // The OLD interpretation (computed under the OLD routing address) can
    // no longer commit.
    const staleAttempt = await commitInterpretation(deps, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
      expectedEvidenceDigest: fixture.evidenceDigest,
      expectedRoutingContextDigest: fixture.routingContextDigest,
      messageObservations: fixture.messageObservations,
    });
    expect(staleAttempt.result).toBe("stale_source");

    // A fresh evaluation under the NEW routing identity succeeds.
    const interpretation = interpretThread({
      messages: evidence.evidence.messages,
      referenceTokens: evidence.evidence.referenceTokens,
      participants: evidence.evidence.participants,
      subjects: evidence.evidence.subjects,
      textParts: evidence.evidence.textParts,
      mailAccountEmail: evidence.evidence.mailAccountEmail,
      observedThroughAtMs: null,
    });
    const freshCommit = await commitInterpretation(deps, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
      expectedEvidenceDigest: evidence.evidence.evidenceDigest,
      expectedRoutingContextDigest: evidence.evidence.routingContextDigest,
      messageObservations: interpretation.messageObservations,
    });
    expect(freshCommit).toEqual({
      result: "ok",
      evidenceDigest: evidence.evidence.evidenceDigest,
      committed: true,
    });
  });
});

d(
  "B06 FINAL CLOSURE §C: unified current/stale definition (parameterized dependency matrix)",
  () => {
    it("B04 source: a new normalized message alone flips staleness on all three read surfaces; reevaluation clears it", async () => {
      const fixture = await eligibleThreadWithReply("b06-fc-matrix-source");
      const deps = replyDeps(client);
      const commit1 = await commitInterpretation(deps, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        normalizedThreadId: fixture.normalizedThreadId,
        expectedEvidenceDigest: fixture.evidenceDigest,
        expectedRoutingContextDigest: fixture.routingContextDigest,
        messageObservations: fixture.messageObservations,
      });
      expect(commit1.result).toBe("ok");
      await assertUnifiedStaleness(fixture, false);

      await insertMessage(client, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        providerMessageId: randomProviderId("reply2"),
        providerThreadId: fixture.providerThreadId,
        internalDateMs: Date.now(),
        sent: false,
        from: "brand@example.com",
        subject: "Re: Collaboration idea",
        bodyText: "Following up!",
      });
      await assertUnifiedStaleness(fixture, true);

      await reevaluateAndCommit(fixture);
      await assertUnifiedStaleness(fixture, false);
    });

    it("B03 horizon: proving a horizon with ZERO message change flips staleness on all three read surfaces; reevaluation clears it", async () => {
      const fixture = await eligibleThreadWithReply("b06-fc-matrix-horizon");
      const deps = replyDeps(client);
      const commit1 = await commitInterpretation(deps, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        normalizedThreadId: fixture.normalizedThreadId,
        expectedEvidenceDigest: fixture.evidenceDigest,
        expectedRoutingContextDigest: fixture.routingContextDigest,
        messageObservations: fixture.messageObservations,
      });
      expect(commit1.result).toBe("ok");
      await assertUnifiedStaleness(fixture, false);

      await insertObservedHorizon(client, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        providerThreadId: fixture.providerThreadId,
        windowStartAt: new Date(Date.now() - DAY),
        windowEndAt: new Date(),
      });
      await assertUnifiedStaleness(fixture, true);

      await reevaluateAndCommit(fixture);
      await assertUnifiedStaleness(fixture, false);
    });

    it("B05 eligibility: an eligibility-changing human decision flips staleness on all three read surfaces; reevaluation clears it", async () => {
      const fixture = await eligibleThreadWithReply("b06-fc-matrix-eligibility");
      const deps = replyDeps(client);
      const commit1 = await commitInterpretation(deps, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        normalizedThreadId: fixture.normalizedThreadId,
        expectedEvidenceDigest: fixture.evidenceDigest,
        expectedRoutingContextDigest: fixture.routingContextDigest,
        messageObservations: fixture.messageObservations,
      });
      expect(commit1.result).toBe("ok");
      await assertUnifiedStaleness(fixture, false);

      await setOutreachHumanDecision(client, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        normalizedThreadId: fixture.normalizedThreadId,
        outreachDecision: "outreach_confirmed",
      });
      await assertUnifiedStaleness(fixture, true);

      await reevaluateAndCommit(fixture);
      await assertUnifiedStaleness(fixture, false);
    });

    it("routing context: a mailbox routing-address change with ZERO message mutation flips staleness on all three read surfaces; reevaluation clears it", async () => {
      const fixture = await eligibleThreadWithReply("b06-fc-matrix-routing");
      const deps = replyDeps(client);
      const commit1 = await commitInterpretation(deps, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        normalizedThreadId: fixture.normalizedThreadId,
        expectedEvidenceDigest: fixture.evidenceDigest,
        expectedRoutingContextDigest: fixture.routingContextDigest,
        messageObservations: fixture.messageObservations,
      });
      expect(commit1.result).toBe("ok");
      await assertUnifiedStaleness(fixture, false);

      const before = await messageObservationsOf(client, fixture.normalizedThreadId);
      await client.query("update public.mail_accounts set email_address = $2 where id = $1", [
        fixture.mailAccountId,
        "changed-routing@example.invalid",
      ]);
      await assertUnifiedStaleness(fixture, true);

      // ZERO B04 message change — this staleness comes purely from routing.
      const afterChange = await messageObservationsOf(client, fixture.normalizedThreadId);
      expect(afterChange.map((o) => o.last_evaluated_source_payload_sha256)).toEqual(
        before.map((o) => o.last_evaluated_source_payload_sha256),
      );

      await reevaluateAndCommit(fixture);
      await assertUnifiedStaleness(fixture, false);
    });

    it("relation rule version: a running-version bump with unchanged evidence flips staleness on all three read surfaces; reevaluation under the new version clears it", async () => {
      const fixture = await eligibleThreadWithReply("b06-fc-matrix-relation-version");
      const deps = replyDeps(client);
      const commit1 = await commitInterpretation(deps, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        normalizedThreadId: fixture.normalizedThreadId,
        expectedEvidenceDigest: fixture.evidenceDigest,
        expectedRoutingContextDigest: fixture.routingContextDigest,
        messageObservations: fixture.messageObservations,
      });
      expect(commit1.result).toBe("ok");
      await assertUnifiedStaleness(fixture, false);

      const bumped = { relationVersion: "gmail_reply_relation_rules_v2" };
      await assertUnifiedStaleness(fixture, true, bumped);

      await reevaluateAndCommit(fixture, bumped);
      await assertUnifiedStaleness(fixture, false, bumped);
    });

    it("classification rule version: a running-version bump with unchanged evidence flips staleness on all three read surfaces; reevaluation under the new version clears it", async () => {
      const fixture = await eligibleThreadWithReply("b06-fc-matrix-classification-version");
      const deps = replyDeps(client);
      const commit1 = await commitInterpretation(deps, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        normalizedThreadId: fixture.normalizedThreadId,
        expectedEvidenceDigest: fixture.evidenceDigest,
        expectedRoutingContextDigest: fixture.routingContextDigest,
        messageObservations: fixture.messageObservations,
      });
      expect(commit1.result).toBe("ok");
      await assertUnifiedStaleness(fixture, false);

      const bumped = { classificationVersion: "gmail_reply_classification_rules_v3" };
      await assertUnifiedStaleness(fixture, true, bumped);

      await reevaluateAndCommit(fixture, bumped);
      await assertUnifiedStaleness(fixture, false, bumped);
    });

    it("text-transform version: a running-version bump with unchanged evidence flips staleness on all three read surfaces; reevaluation under the new version clears it", async () => {
      const fixture = await eligibleThreadWithReply("b06-fc-matrix-text-transform-version");
      const deps = replyDeps(client);
      const commit1 = await commitInterpretation(deps, {
        userId: fixture.userId,
        mailAccountId: fixture.mailAccountId,
        normalizedThreadId: fixture.normalizedThreadId,
        expectedEvidenceDigest: fixture.evidenceDigest,
        expectedRoutingContextDigest: fixture.routingContextDigest,
        messageObservations: fixture.messageObservations,
      });
      expect(commit1.result).toBe("ok");
      await assertUnifiedStaleness(fixture, false);

      const bumped = {
        textTransformVersion: "gmail_reply_text_transform_v2+gmail_outreach_text_v5",
      };
      await assertUnifiedStaleness(fixture, true, bumped);

      await reevaluateAndCommit(fixture, bumped);
      await assertUnifiedStaleness(fixture, false, bumped);
    });
  },
);
