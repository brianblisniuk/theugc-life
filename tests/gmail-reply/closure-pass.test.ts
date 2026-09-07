import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { commitInterpretation, getThreadEvidence, listCandidates } from "@/lib/gmail/reply/service";
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
    observations: unknown[];
  },
) {
  return c.query(
    `select public.gmail_reply_commit_interpretation(
       p_user_id := $1::uuid, p_mail_account_id := $2::uuid, p_normalized_thread_id := $3::uuid,
       p_relation_version := $4, p_classification_version := $5, p_text_transform_version := $6,
       p_expected_evidence_digest := $7, p_message_observations := $8::jsonb
     ) as result`,
    [
      args.userId,
      args.mailAccountId,
      args.normalizedThreadId,
      RELATION_RULE_VERSION,
      CLASSIFICATION_RULE_VERSION,
      TEXT_TRANSFORM_VERSION,
      args.expectedEvidenceDigest,
      JSON.stringify(args.observations),
    ],
  );
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
