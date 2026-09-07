import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  commitInterpretation,
  getThreadEvidence,
  interpretOneThread,
  purgeForDeletion,
} from "@/lib/gmail/reply/service";
import { interpretThread } from "@/lib/gmail/reply/interpreter";
import {
  connectedMailbox,
  insertMessage,
  insertObservedHorizon,
  messageObservationsOf,
  randomProviderId,
  replyDeps,
  setOutreachHumanDecision,
  setOutreachMachineStatus,
  startDeletion,
  threadSummaryOf,
  updateMessage,
  withdrawConsent,
} from "./harness";

/**
 * B06 real-Postgres integration proofs — machine/observed boundary, the
 * consent/deletion fence (reused from B05), the source-evidence CAS, stable-
 * anchor survival across a B04 rebuild, B05 eligibility, the observation
 * horizon, and zero CRM/canonical/G3 writes. A mocked database would test
 * none of what actually matters (0040's own constraints/triggers/RPCs).
 */

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_DB);

let client: Client;

beforeAll(async () => {
  if (!TEST_DB) return;
  client = new Client({ connectionString: TEST_DB });
  await client.connect();
});

afterAll(async () => {
  if (client) await client.end();
});

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A connected mailbox with a fresh provider thread id, no messages yet. */
async function mailboxFixture(label: string) {
  const { userId, mailAccountId } = await connectedMailbox(client, label);
  return {
    userId,
    mailAccountId,
    providerThreadId: randomProviderId("thread"),
    t0: Date.now() - 30 * DAY,
  };
}

/** A mailbox with one creator-SENT message, machine-eligible via `qualified_outreach`. */
async function eligibleThread(label: string) {
  const fixture = await mailboxFixture(label);
  const sent = await insertMessage(client, {
    userId: fixture.userId,
    mailAccountId: fixture.mailAccountId,
    providerMessageId: randomProviderId("sent"),
    providerThreadId: fixture.providerThreadId,
    internalDateMs: fixture.t0,
    sent: true,
    messageId: `<${randomProviderId("mid")}@creator.example>`,
    subject: "Collaboration idea",
    bodyText: "I would love to collaborate with your hotel.",
  });
  await setOutreachMachineStatus(client, {
    userId: fixture.userId,
    mailAccountId: fixture.mailAccountId,
    normalizedThreadId: sent.normalizedThreadId,
    outreachStatus: "qualified_outreach",
  });
  return { ...fixture, normalizedThreadId: sent.normalizedThreadId };
}

d("B06 machine/observed boundary + qualifying human reply", () => {
  it("a direct in-reply-to human reply from an external sender with new text becomes the first qualifying reply, with both timing clocks", async () => {
    const { userId, mailAccountId, providerThreadId, t0 } = await mailboxFixture("b06-happy-path");
    const sentProviderMessageId = randomProviderId("sent");
    const sentMid = `<sent-${randomProviderId("mid")}@creator.example>`;
    const replyProviderMessageId = randomProviderId("reply");

    const sent = await insertMessage(client, {
      userId,
      mailAccountId,
      providerMessageId: sentProviderMessageId,
      providerThreadId,
      internalDateMs: t0,
      sent: true,
      messageId: sentMid,
      subject: "Collaboration idea",
      bodyText: "I would love to collaborate with your hotel.",
    });
    await setOutreachMachineStatus(client, {
      userId,
      mailAccountId,
      normalizedThreadId: sent.normalizedThreadId,
      outreachStatus: "qualified_outreach",
    });

    await insertMessage(client, {
      userId,
      mailAccountId,
      providerMessageId: replyProviderMessageId,
      providerThreadId,
      internalDateMs: t0 + 4 * HOUR,
      sent: false,
      from: "manager@hotel.example",
      inReplyTo: sentMid,
      subject: "Re: Collaboration idea",
      bodyText: "Sounds great, let's set up a call!",
    });

    const deps = replyDeps(client);
    const result = await interpretOneThread(deps, {
      userId,
      mailAccountId,
      normalizedThreadId: sent.normalizedThreadId,
    });
    expect(result).toEqual({ result: "ok", committed: true });

    const observations = await messageObservationsOf(client, sent.normalizedThreadId);
    expect(observations).toHaveLength(2);
    const replyObs = observations.find((o) => o.provider_message_id === replyProviderMessageId)!;
    expect(replyObs.response_class).toBe("qualifying_human_reply");
    expect(replyObs.relation_status).toBe("direct_in_reply_to");
    expect(replyObs.referenced_creator_sent_provider_message_id).toBe(sentProviderMessageId);

    const summary = await threadSummaryOf(client, sent.normalizedThreadId);
    expect(summary.observation_state).toBe("qualifying_human_reply_observed");
    expect(summary.first_qualifying_human_reply_provider_message_id).toBe(replyProviderMessageId);
    expect(Number(summary.latency_from_first_creator_sent_ms)).toBe(4 * HOUR);
    expect(Number(summary.latency_from_latest_creator_sent_ms)).toBe(4 * HOUR);
    expect(summary.creator_sent_count_before_first_human_reply).toBe(1);
  });

  it("exact replay converges to the SAME summary row without fabricating new state", async () => {
    const { userId, mailAccountId, normalizedThreadId } = await eligibleThread("b06-replay");
    const deps = replyDeps(client);

    const first = await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    expect(first.result).toBe("ok");
    const summary1 = await threadSummaryOf(client, normalizedThreadId);

    const second = await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    expect(second.result).toBe("ok");
    const summary2 = await threadSummaryOf(client, normalizedThreadId);

    expect(summary2.id).toBe(summary1.id);
    expect(summary2.evidence_digest).toBe(summary1.evidence_digest);
    expect(summary2.observation_state).toBe(summary1.observation_state);
  });
});

d("B06 eligibility (contract §3/§5)", () => {
  it("machine not_outreach is not eligible; a human outreach_confirmed override makes it eligible", async () => {
    const { userId, mailAccountId } = await mailboxFixture("b06-eligibility-override");
    const sent = await insertMessage(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("sent"),
      providerThreadId: randomProviderId("thread"),
      internalDateMs: Date.now() - DAY,
      sent: true,
    });
    await setOutreachMachineStatus(client, {
      userId,
      mailAccountId,
      normalizedThreadId: sent.normalizedThreadId,
      outreachStatus: "not_outreach",
    });

    const deps = replyDeps(client);
    const notEligible = await interpretOneThread(deps, {
      userId,
      mailAccountId,
      normalizedThreadId: sent.normalizedThreadId,
    });
    expect(notEligible.result).toBe("not_eligible");

    await setOutreachHumanDecision(client, {
      userId,
      mailAccountId,
      normalizedThreadId: sent.normalizedThreadId,
      outreachDecision: "outreach_confirmed",
    });

    const nowEligible = await interpretOneThread(deps, {
      userId,
      mailAccountId,
      normalizedThreadId: sent.normalizedThreadId,
    });
    expect(nowEligible).toEqual({ result: "ok", committed: true });
  });

  it("a human outreach_rejected suppresses NEW processing even when the machine says qualified_outreach", async () => {
    const { userId, mailAccountId, normalizedThreadId } =
      await eligibleThread("b06-eligibility-reject");
    await setOutreachHumanDecision(client, {
      userId,
      mailAccountId,
      normalizedThreadId,
      outreachDecision: "not_outreach_confirmed",
    });

    const deps = replyDeps(client);
    const result = await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    expect(result.result).toBe("not_eligible");
  });

  it("machine needs_review is eligible for private advisory chronology", async () => {
    const { userId, mailAccountId } = await mailboxFixture("b06-eligibility-needs-review");
    const sent = await insertMessage(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("sent"),
      providerThreadId: randomProviderId("thread"),
      internalDateMs: Date.now() - DAY,
      sent: true,
    });
    await setOutreachMachineStatus(client, {
      userId,
      mailAccountId,
      normalizedThreadId: sent.normalizedThreadId,
      outreachStatus: "needs_review",
    });

    const deps = replyDeps(client);
    const result = await interpretOneThread(deps, {
      userId,
      mailAccountId,
      normalizedThreadId: sent.normalizedThreadId,
    });
    expect(result).toEqual({ result: "ok", committed: true });
  });
});

d("B06 consent/deletion fence (contract §4, reused from B05)", () => {
  it("withdrawing private_gmail_processing consent refuses a NEW commit", async () => {
    const { userId, mailAccountId, normalizedThreadId } =
      await eligibleThread("b06-consent-withdrawal");
    await withdrawConsent(client, mailAccountId, userId);

    const deps = replyDeps(client);
    const result = await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    expect(result.result).toBe("consent_missing");
  });

  it("a deletion in progress refuses a NEW commit", async () => {
    const { userId, mailAccountId, normalizedThreadId } =
      await eligibleThread("b06-deletion-pending");
    await startDeletion(client, mailAccountId, userId, "gmail_derived_data");

    const deps = replyDeps(client);
    const result = await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    expect(result.result).toBe("deletion_pending");
  });
});

d("B06 stable message-observation anchor survives a B04 rebuild (contract §9)", () => {
  it("the SAME observation row (same id) reconciles after the raw message is replaced and re-normalized", async () => {
    const { userId, mailAccountId, providerThreadId, t0, normalizedThreadId } =
      await eligibleThread("b06-rebuild-survival");
    const replyId = randomProviderId("reply");
    await insertMessage(client, {
      userId,
      mailAccountId,
      providerMessageId: replyId,
      providerThreadId,
      internalDateMs: t0 + HOUR,
      sent: false,
      from: "person@hotel.example",
      subject: "Re: hello",
      bodyText: "Sounds interesting, tell me more.",
    });

    const deps = replyDeps(client);
    const first = await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    expect(first.result).toBe("ok");

    const before = await messageObservationsOf(client, normalizedThreadId);
    const replyObsBefore = before.find((o) => o.provider_message_id === replyId)!;
    expect(replyObsBefore.current_normalized_message_id).not.toBeNull();

    // Replace the raw message (bump the digest) — B04's own invalidation
    // trigger deletes the old normalized_messages row for this exact
    // provider_message_id in the SAME transaction.
    await updateMessage(client, {
      userId,
      mailAccountId,
      providerMessageId: replyId,
      providerThreadId,
      internalDateMs: t0 + HOUR,
      sent: false,
      from: "person@hotel.example",
      subject: "Re: hello",
      bodyText: "Sounds interesting, tell me a lot more please!",
    });

    const afterRebuildRaw = await client.query(
      "select id from private.gmail_normalized_messages where mail_account_id = $1 and provider_message_id = $2",
      [mailAccountId, replyId],
    );
    expect(afterRebuildRaw.rows).toHaveLength(1);
    expect(afterRebuildRaw.rows[0].id).not.toBe(replyObsBefore.current_normalized_message_id);

    // Re-evaluate: the SAME stable observation row (same id) reconciles,
    // now pointing at the NEW normalized_message_id.
    const second = await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    expect(second.result).toBe("ok");

    const after = await messageObservationsOf(client, normalizedThreadId);
    const replyObsAfter = after.find((o) => o.provider_message_id === replyId)!;
    expect(replyObsAfter.id).toBe(replyObsBefore.id);
    expect(replyObsAfter.current_normalized_message_id).toBe(afterRebuildRaw.rows[0].id);
  });
});

d("B06 source-evidence CAS (contract §13/§19)", () => {
  it("a new message arriving after evidence was read makes the stale commit fail with stale_source", async () => {
    const { userId, mailAccountId, providerThreadId, t0, normalizedThreadId } =
      await eligibleThread("b06-stale-source");
    const deps = replyDeps(client);

    const evidence = await getThreadEvidence(deps, { userId, mailAccountId, normalizedThreadId });
    expect(evidence.result).toBe("ok");
    if (evidence.result !== "ok") throw new Error("unreachable");

    // A new message arrives (changing the thread's evidence) AFTER the read above.
    await insertMessage(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("late"),
      providerThreadId,
      internalDateMs: t0 + HOUR,
      sent: false,
      subject: "Re:",
      bodyText: "hi",
    });

    const interpretation = interpretThread({
      messages: evidence.evidence.messages,
      referenceTokens: evidence.evidence.referenceTokens,
      participants: evidence.evidence.participants,
      subjects: evidence.evidence.subjects,
      textParts: evidence.evidence.textParts,
      mailAccountEmail: evidence.evidence.mailAccountEmail,
      observedThroughAtMs: null,
    });
    const commit = await commitInterpretation(deps, {
      userId,
      mailAccountId,
      normalizedThreadId,
      expectedEvidenceDigest: evidence.evidence.evidenceDigest,
      messageObservations: interpretation.messageObservations,
    });
    expect(commit.result).toBe("stale_source");
  });
});

d("B06 observation horizon (contract §11/§18)", () => {
  it("no proven horizon -> observation_horizon_unknown; a proven horizon -> no_qualifying_response_observed_in_window", async () => {
    const { userId, mailAccountId, providerThreadId, normalizedThreadId } =
      await eligibleThread("b06-horizon");
    const deps = replyDeps(client);

    const first = await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    expect(first.result).toBe("ok");
    let summary = await threadSummaryOf(client, normalizedThreadId);
    expect(summary.observation_state).toBe("observation_horizon_unknown");
    expect(summary.observed_through_at).toBeNull();

    await insertObservedHorizon(client, {
      userId,
      mailAccountId,
      providerThreadId,
      windowStartAt: new Date(Date.now() - 60 * DAY),
      windowEndAt: new Date(Date.now() - 1 * DAY),
    });

    const second = await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    expect(second.result).toBe("ok");
    summary = await threadSummaryOf(client, normalizedThreadId);
    expect(summary.observation_state).toBe("no_qualifying_response_observed_in_window");
    expect(summary.observed_through_at).not.toBeNull();
  });
});

d("B06 zero CRM/canonical/G3 writes (contract §15/§22)", () => {
  it("interpretOneThread never writes pipeline_items, outreach_events, collaborations or hotels", async () => {
    const { userId, mailAccountId, providerThreadId, t0, normalizedThreadId } =
      await eligibleThread("b06-no-crm");
    await insertMessage(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("reply-crm"),
      providerThreadId,
      internalDateMs: t0 + HOUR,
      sent: false,
      from: "person@hotel.example",
      bodyText: "Sounds good, let's talk!",
    });

    const before = await client.query(`
      select
        (select count(*) from public.pipeline_items) as pipeline_items,
        (select count(*) from public.outreach_events) as outreach_events,
        (select count(*) from public.collaborations) as collaborations,
        (select count(*) from public.hotels) as hotels
    `);

    const deps = replyDeps(client);
    const result = await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    expect(result.result).toBe("ok");

    const after = await client.query(`
      select
        (select count(*) from public.pipeline_items) as pipeline_items,
        (select count(*) from public.outreach_events) as outreach_events,
        (select count(*) from public.collaborations) as collaborations,
        (select count(*) from public.hotels) as hotels
    `);

    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});

d("B06 deletion purge extends D067's invariant (contract §4)", () => {
  it("a mail account cannot reach `deleted` while ANY Gmail-derived layer's data survives, B06 included", async () => {
    const { userId, mailAccountId, normalizedThreadId } =
      await eligibleThread("b06-absent-when-deleted");
    const deps = replyDeps(client);
    const result = await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    expect(result.result).toBe("ok");

    // The real B01 lifecycle: `connected` -> `deletion_pending` -> `deleted`.
    await startDeletion(client, mailAccountId, userId, "gmail_derived_data");

    // B01/B03/B04's OWN absence checks fire first (they were installed in
    // earlier migrations and still have raw/normalized data at this point);
    // B06's `assert_gmail_reply_data_absent_when_deleted` is the same
    // deferred-constraint-trigger pattern, extending the identical invariant
    // to its own layer. Either way, the transition to `deleted` must fail
    // while ANY layer's Gmail-derived rows remain.
    await expect(
      client.query("update public.mail_accounts set connection_state = 'deleted' where id = $1", [
        mailAccountId,
      ]),
    ).rejects.toThrow(/must not survive|remain/);
  });

  it("explicit Gmail-derived deletion purges B06 state, and the account can then become `deleted` once every layer is clear", async () => {
    const { userId, mailAccountId, normalizedThreadId } =
      await eligibleThread("b06-deletion-purge");
    const deps = replyDeps(client);
    const result = await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    expect(result.result).toBe("ok");

    const requestId = await startDeletion(
      client,
      mailAccountId,
      userId,
      "account_and_gmail_derived_data",
    );

    const purge = await purgeForDeletion(deps, {
      userId,
      mailAccountId,
      deletionRequestId: requestId,
    });
    expect(purge.result).toBe("ok");
    expect(purge.messageObservationsRemoved).toBeGreaterThanOrEqual(1);
    expect(purge.threadSummariesRemoved).toBe(1);

    expect(await messageObservationsOf(client, normalizedThreadId)).toHaveLength(0);
    expect(await threadSummaryOf(client, normalizedThreadId)).toBeNull();

    // B06's own layer is now clear, but B01/B03/B04's raw/normalized data
    // still exists — out of B06's scope to purge (that is each layer's own
    // job in the real orchestrator). Clear it directly here so this test can
    // prove the FULL chain reaches `deleted` once every layer, B06 included,
    // is actually empty.
    await client.query("delete from private.gmail_raw_messages where mail_account_id = $1", [
      mailAccountId,
    ]);
    await client.query("delete from private.gmail_normalized_threads where mail_account_id = $1", [
      mailAccountId,
    ]);

    // The request's completion and the account's terminal state move
    // together, in one transaction — a deferred coherence check rejects
    // either one settling ahead of the other.
    await client.query("begin");
    await client.query(
      "update public.mail_account_deletion_requests set status = 'completed', completed_at = now() where id = $1",
      [requestId],
    );
    await client.query(
      "update public.mail_accounts set connection_state = 'deleted' where id = $1",
      [mailAccountId],
    );
    await client.query("commit");
  });
});

d("B06 credential boundary (B02-B05's own pattern)", () => {
  it("every gmail_reply_* definer-rights function pins its search_path", async () => {
    const res = await client.query(`
      select p.proname, p.prosecdef, p.proconfig
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'gmail\\_reply\\_%'
    `);
    // 5: list_candidates, get_thread_evidence, commit_interpretation,
    // status, purge_for_deletion. No creator-decision RPC exists in B06.
    expect(res.rows.length).toBe(5);
    for (const row of res.rows) {
      expect(row.prosecdef, row.proname).toBe(true);
      expect(
        (row.proconfig ?? []).some((c: string) => c.startsWith("search_path=")),
        row.proname,
      ).toBe(true);
    }
  });

  it("every gmail_reply_* function is service_role-only — never authenticated, never anon", async () => {
    const functions = [
      "public.gmail_reply_list_candidates(uuid,uuid,text,text,text,integer,uuid[])",
      "public.gmail_reply_get_thread_evidence(uuid,uuid,uuid)",
      "public.gmail_reply_commit_interpretation(uuid,uuid,uuid,text,text,text,text,jsonb)",
      "public.gmail_reply_status(uuid,uuid)",
      "public.gmail_reply_purge_for_deletion(uuid,uuid,uuid)",
    ];
    for (const fn of functions) {
      const res = await client.query(
        `select has_function_privilege('service_role', $1, 'EXECUTE') as svc,
                has_function_privilege('authenticated', $1, 'EXECUTE') as auth,
                has_function_privilege('anon', $1, 'EXECUTE') as anon`,
        [fn],
      );
      expect([fn, res.rows[0].svc, res.rows[0].auth, res.rows[0].anon]).toEqual([
        fn,
        true,
        false,
        false,
      ]);
    }
  });
});
