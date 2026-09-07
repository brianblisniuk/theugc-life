import { createHash } from "node:crypto";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  getCurrentCatalogEpoch,
  getOutreachStatus,
  interpretOneThread,
} from "@/lib/gmail/outreach/service";
import { normalizeOneCandidate } from "@/lib/gmail/normalize/service";
import { buildSanitizedMessage, insertRawMessage } from "../gmail-normalize/harness";
import { createRpcClient } from "../gmail/rpc-harness";
import {
  connectedMailbox,
  insertHotel,
  observedRecipientsOf,
  outreachDeps,
  randomProviderId,
  recordCreatorDecisionAs,
  startDeletion,
  targetObservationsOf,
  withdrawConsent,
} from "./harness";

/**
 * B05 EXTERNAL AUDIT AMENDMENT #3 — direct proofs for Findings 1, 2 and 3.
 * D070 remains ACCEPTED; nothing here reopens Amendment #2's already-passed
 * findings (recipient forking, the machine consent gate, the catalog-epoch
 * lock, the fast path, semantic scope, contact corroboration, authored-text
 * uncertainty, exact catalog lookups).
 */

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_DB);

let client: Client;
const openSessions: Client[] = [];
const openPids: number[] = [];

beforeAll(async () => {
  if (!TEST_DB) return;
  client = new Client({ connectionString: TEST_DB });
  await client.connect();

  // Warm the PL/pgSQL plan cache and page cache for the exact functions the
  // timed two-session race tests below exercise, on a throwaway fixture that
  // is never asserted on. The first real invocation of a large function in a
  // freshly started process/connection can be materially slower than every
  // subsequent one (planning, catalog cache population, disk reads for cold
  // pages) — paying that cost here, outside any `waitUntilBlocked` deadline,
  // keeps the timing-sensitive tests measuring lock contention only, not
  // one-time cold-start cost.
  const warm = await connectedMailbox(client, "b05-a3-warmup");
  const warmThread = await normalizeFixture({
    userId: warm.userId,
    mailAccountId: warm.mailAccountId,
    providerMessageId: randomProviderId("warm-msg"),
    providerThreadId: randomProviderId("warm-thread"),
    internalDateMs: Date.now(),
    to: "marketing@warmup.example",
  });
  const warmDeps = outreachDeps(client);
  const warmDigest = await computeExpectedDigest(warmDeps, {
    userId: warm.userId,
    mailAccountId: warm.mailAccountId,
    normalizedThreadId: warmThread.normalizedThreadId,
  });
  const warmEpoch = await getCurrentCatalogEpoch(warmDeps);
  await client.query(
    `select public.gmail_outreach_commit_interpretation(
       p_user_id := $1, p_mail_account_id := $2, p_normalized_thread_id := $3,
       p_detector_version := 'gmail_outreach_rules_v3', p_matcher_version := 'gmail_outreach_match_rules_v3',
       p_expected_evidence_digest := $4, p_outreach_status := 'insufficient_evidence', p_reason_codes := '{}',
       p_recipient_participant_ids := '{}'::uuid[], p_target_contact_match_quality := 'insufficient_evidence',
       p_target_contact_candidate_set_fingerprint := $5, p_target_contact_candidates := '[]'::jsonb,
       p_target_observations := '[]'::jsonb, p_target_canonical_links := '[]'::jsonb,
       p_machine_target_scope := 'unresolved', p_target_scope_reason_codes := '{}', p_catalog_epoch := $6
     )`,
    [
      warm.userId,
      warm.mailAccountId,
      warmThread.normalizedThreadId,
      warmDigest,
      "0".repeat(64),
      warmEpoch,
    ],
  );
  // `is_local := false` (session-level, not transaction-local) since these
  // two statements are each their own implicit auto-committed transaction on
  // this connection — a `true`/local setting would vanish before the second
  // statement runs.
  await client.query("select set_config('request.jwt.claims', $1, false)", [
    JSON.stringify({ sub: warm.userId, role: "authenticated" }),
  ]);
  await client.query(
    `select public.gmail_outreach_record_creator_decision(
       p_mail_account_id := $1, p_normalized_thread_id := $2, p_axis := 'outreach',
       p_outreach_decision := 'not_outreach_confirmed'
     )`,
    [warm.mailAccountId, warmThread.normalizedThreadId],
  );
});

afterEach(async () => {
  // A test that throws mid-race (e.g. a timed-out `waitUntilBlocked`) never
  // reaches its own `commit`/`rollback` — its session is left with an open
  // transaction and its locks held, and possibly a query still in flight.
  // Issuing `rollback` on that SAME connection would just queue behind
  // whatever is still pending (node-pg serializes per connection) and could
  // wait forever. Terminate each known backend from the shared, always-idle
  // `client` connection instead — that releases its locks immediately
  // regardless of what its own connection was doing — before closing the
  // sockets, so one failed test can never leave a zombie lock holder for the
  // next test to block on.
  while (openPids.length > 0) {
    const pid = openPids.pop()!;
    await client.query("select pg_terminate_backend($1)", [pid]).catch(() => undefined);
  }
  while (openSessions.length > 0) {
    const c = openSessions.pop()!;
    await c.end().catch(() => undefined);
  }
});

afterAll(async () => {
  if (client) await client.end();
});

async function session(): Promise<Client> {
  const c = new Client({ connectionString: TEST_DB });
  // `afterEach` may forcibly terminate this backend from another connection
  // (see above) — node-pg emits an 'error' event on an unexpected server-side
  // close, which is otherwise unhandled and reported as a spurious test-run
  // error even though the test itself already passed.
  c.on("error", () => undefined);
  await c.connect();
  openSessions.push(c);
  return c;
}

const backendPid = async (c: Client): Promise<number> => {
  const pid = Number((await c.query("select pg_backend_pid() as pid")).rows[0].pid);
  openPids.push(pid);
  return pid;
};

async function waitUntilBlocked(pid: number, timeoutMs = 20_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await client.query("select pg_blocking_pids($1) as blockers", [pid]);
    const blockers: number[] = res.rows[0].blockers ?? [];
    if (blockers.length > 0) return blockers;
    if (Date.now() > deadline) throw new Error(`backend ${pid} never blocked`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Poll until `pid` actually holds a GRANTED lock on `relation` — used to make
 * "the first transaction wins the fence" deterministic. Firing a query
 * unawaited and merely assuming it reaches its lock before a second session's
 * conflicting statement races it is exactly the check-then-act ordering
 * assumption this whole amendment exists to eliminate in production code; the
 * test itself must not rely on it either; it must observe the lock is
 * actually held before the second session is allowed to contend for it.
 */
async function waitUntilLockHeld(pid: number, relation: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await client.query(
      `select 1 from pg_locks where pid = $1 and granted and relation = $2::regclass`,
      [pid, relation],
    );
    if (res.rows.length > 0) return;
    if (Date.now() > deadline) {
      throw new Error(`backend ${pid} never acquired a granted lock on ${relation}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function normalizeFixture(input: {
  userId: string;
  mailAccountId: string;
  providerMessageId: string;
  providerThreadId: string;
  internalDateMs: number;
  to: string;
  body?: string;
}) {
  const normalizeDeps = {
    db: createRpcClient(
      client,
    ) as unknown as import("@/lib/gmail/normalize/service").NormalizeDeps["db"],
  };
  const bodyText = input.body ?? "I'd love to collaborate on a partnership";
  const sanitized = buildSanitizedMessage({
    providerMessageId: input.providerMessageId,
    providerThreadId: input.providerThreadId,
    internalDateMs: input.internalDateMs,
    labelIds: ["SENT"],
    messageHeaders: [
      { name: "subject", value: "Collaboration opportunity" },
      { name: "to", value: input.to },
    ],
    payload: {
      mimeType: "text/plain",
      body: { size: bodyText.length, data: Buffer.from(bodyText, "utf8").toString("base64url") },
    },
  });
  const raw = await insertRawMessage(client, {
    mailAccountId: input.mailAccountId,
    userId: input.userId,
    sanitized,
  });
  const normalized = await normalizeOneCandidate(normalizeDeps, input.userId, {
    mail_account_id: input.mailAccountId,
    provider_message_id: input.providerMessageId,
    provider_thread_id: input.providerThreadId,
    internal_date_ms: input.internalDateMs,
    label_ids: sanitized.label_ids,
    sanitized_payload: sanitized,
    payload_sha256: raw.payloadSha256,
  });
  if (normalized.result !== "ok") throw new Error("fixture normalization failed");
  return { normalizedThreadId: normalized.normalizedThreadId };
}

/** Reproduces `startDeletion`'s exact real statement sequence, but lets the caller control the transaction boundary so blocking can be proven. */
async function beginDeletionStart(
  c: Client,
  input: { mailAccountId: string; userId: string },
): Promise<void> {
  await c.query("delete from private.gmail_oauth_credentials where mail_account_id = $1", [
    input.mailAccountId,
  ]);
  const request = await c.query(
    `insert into public.mail_account_deletion_requests
       (mail_account_id, user_id, scope, requested_by_user_id, requested_at, status)
     values ($1, $2, 'account_and_gmail_derived_data', $2, now(), 'in_progress') returning id`,
    [input.mailAccountId, input.userId],
  );
  await c.query(
    `update public.mail_accounts
        set connection_state = 'deletion_pending',
            current_deletion_request_id = $2,
            disconnected_at = now(),
            granted_scopes = '{}'
      where id = $1`,
    [input.mailAccountId, request.rows[0].id],
  );
}

async function computeExpectedDigest(
  deps: ReturnType<typeof outreachDeps>,
  input: { userId: string; mailAccountId: string; normalizedThreadId: string },
): Promise<string> {
  const evidenceResult = await deps.db.rpc("gmail_outreach_get_thread_evidence", {
    p_user_id: input.userId,
    p_mail_account_id: input.mailAccountId,
    p_normalized_thread_id: input.normalizedThreadId,
  });
  const messages = (
    evidenceResult.data as {
      messages: Array<{
        normalized_message_id: string;
        source_payload_sha256: string;
        provider_sent: boolean;
      }>;
    }
  ).messages;
  const digestInput = messages
    .map((m) => `${m.normalized_message_id}:${m.source_payload_sha256}:${m.provider_sent}`)
    .sort()
    .join("|");
  return createHash("sha256").update(digestInput).digest("hex");
}

d(
  "B05 Finding 1: a deletion-start racing a commit is caught under a real lock, not a stale unlocked read",
  () => {
    it("B05 wins the fence first: its commit completes honestly, THEN the deletion transition takes effect", async () => {
      const { userId, mailAccountId } = await connectedMailbox(client, "b05-a3-f1-b05-wins");
      const deps = outreachDeps(client);
      const providerMessageId = randomProviderId("msg");
      const providerThreadId = randomProviderId("thread");
      const { normalizedThreadId } = await normalizeFixture({
        userId,
        mailAccountId,
        providerMessageId,
        providerThreadId,
        internalDateMs: Date.now(),
        to: "marketing@hotel-a3f1a.example",
      });
      const expectedDigest = await computeExpectedDigest(deps, {
        userId,
        mailAccountId,
        normalizedThreadId,
      });
      const catalogEpoch = await getCurrentCatalogEpoch(deps);

      const t1 = await session();
      const t2 = await session();

      await t1.query("begin");
      const t1Pid = await backendPid(t1);
      const commitPromise = t1.query(
        `select public.gmail_outreach_commit_interpretation(
         p_user_id := $1, p_mail_account_id := $2, p_normalized_thread_id := $3,
         p_detector_version := 'gmail_outreach_rules_v3', p_matcher_version := 'gmail_outreach_match_rules_v3',
         p_expected_evidence_digest := $4, p_outreach_status := 'insufficient_evidence', p_reason_codes := '{}',
         p_recipient_participant_ids := '{}'::uuid[], p_target_contact_match_quality := 'insufficient_evidence',
         p_target_contact_candidate_set_fingerprint := $5, p_target_contact_candidates := '[]'::jsonb,
         p_target_observations := '[]'::jsonb, p_target_canonical_links := '[]'::jsonb,
         p_machine_target_scope := 'unresolved', p_target_scope_reason_codes := '{}', p_catalog_epoch := $6
       ) as result`,
        [userId, mailAccountId, normalizedThreadId, expectedDigest, "0".repeat(64), catalogEpoch],
      );

      // Don't just assume the unawaited commit above has already reached its
      // lock by the time T2 issues a conflicting statement — observe it: T2's
      // whole point is to contend for a lock T1 actually holds, not to race
      // T1's own query dispatch.
      await waitUntilLockHeld(t1Pid, "public.mail_accounts");

      await t2.query("begin");
      const t2Pid = await backendPid(t2);
      const deletionPromise = beginDeletionStart(t2, { mailAccountId, userId });
      const blockers = await waitUntilBlocked(t2Pid);
      expect(blockers).toContain(t1Pid);

      const commitResult = await commitPromise;
      await t1.query("commit");
      expect((commitResult.rows[0].result as { result: string }).result).toBe("ok");

      await deletionPromise;
      await t2.query("commit");

      const stateAfter = await client.query(
        "select connection_state from public.mail_accounts where id = $1",
        [mailAccountId],
      );
      expect(stateAfter.rows[0].connection_state).toBe("deletion_pending");
    });

    it("deletion wins the fence first: the commit blocks, then observes deletion_pending and refuses, writing nothing", async () => {
      const { userId, mailAccountId } = await connectedMailbox(client, "b05-a3-f1-deletion-wins");
      const deps = outreachDeps(client);
      const providerMessageId = randomProviderId("msg");
      const providerThreadId = randomProviderId("thread");
      const { normalizedThreadId } = await normalizeFixture({
        userId,
        mailAccountId,
        providerMessageId,
        providerThreadId,
        internalDateMs: Date.now(),
        to: "marketing@hotel-a3f1b.example",
      });
      const expectedDigest = await computeExpectedDigest(deps, {
        userId,
        mailAccountId,
        normalizedThreadId,
      });
      const catalogEpoch = await getCurrentCatalogEpoch(deps);

      const t1 = await session();
      const t2 = await session();

      // T2 (deletion-start) begins FIRST and holds its mail_accounts UPDATE
      // in-flight, uncommitted — it never touches the consent row at all.
      await t2.query("begin");
      await beginDeletionStart(t2, { mailAccountId, userId });

      // T1 (B05 commit) acquires its consent lock uncontended (deletion never
      // touches it), then blocks acquiring the mail_accounts lock T2 holds.
      await t1.query("begin");
      const t1Pid = await backendPid(t1);
      const commitPromise = t1.query(
        `select public.gmail_outreach_commit_interpretation(
         p_user_id := $1, p_mail_account_id := $2, p_normalized_thread_id := $3,
         p_detector_version := 'gmail_outreach_rules_v3', p_matcher_version := 'gmail_outreach_match_rules_v3',
         p_expected_evidence_digest := $4, p_outreach_status := 'insufficient_evidence', p_reason_codes := '{}',
         p_recipient_participant_ids := '{}'::uuid[], p_target_contact_match_quality := 'insufficient_evidence',
         p_target_contact_candidate_set_fingerprint := $5, p_target_contact_candidates := '[]'::jsonb,
         p_target_observations := '[]'::jsonb, p_target_canonical_links := '[]'::jsonb,
         p_machine_target_scope := 'unresolved', p_target_scope_reason_codes := '{}', p_catalog_epoch := $6
       ) as result`,
        [userId, mailAccountId, normalizedThreadId, expectedDigest, "0".repeat(64), catalogEpoch],
      );

      const t2Pid = await backendPid(t2);
      const blockers = await waitUntilBlocked(t1Pid);
      expect(blockers).toContain(t2Pid);

      await t2.query("commit");

      const commitResult = await commitPromise;
      await t1.query("commit");
      expect((commitResult.rows[0].result as { result: string }).result).toBe("deletion_pending");

      const signal = await client.query(
        "select 1 from private.gmail_outreach_thread_signals where normalized_thread_id = $1",
        [normalizedThreadId],
      );
      expect(signal.rows).toHaveLength(0);
    });
  },
);

d("B05 Finding 2: a creator decision is ALSO new processing, gated identically", () => {
  it("granted consent: a creator decision succeeds normally", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-a3-f2-granted");
    const deps = outreachDeps(client);
    const { normalizedThreadId } = await normalizeFixture({
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      internalDateMs: Date.now(),
      to: "marketing@hotel-a3f2a.example",
    });
    await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });

    const result = await recordCreatorDecisionAs(client, userId, deps, {
      mailAccountId,
      normalizedThreadId,
      axis: "outreach",
      outreachDecision: "not_outreach_confirmed",
    });
    expect(result.result).toBe("ok");
  });

  it("after withdrawal: existing history remains, but the decision RPC refuses and writes no new event", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-a3-f2-withdrawn");
    const deps = outreachDeps(client);
    const { normalizedThreadId } = await normalizeFixture({
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      internalDateMs: Date.now(),
      to: "marketing@hotel-a3f2b.example",
    });
    await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    const before = await getOutreachStatus(deps, { userId, mailAccountId });
    if (before.result !== "ok") throw new Error("expected ok status");

    await withdrawConsent(client, mailAccountId, userId);

    const result = await recordCreatorDecisionAs(client, userId, deps, {
      mailAccountId,
      normalizedThreadId,
      axis: "outreach",
      outreachDecision: "outreach_confirmed",
    });
    expect(result.result).toBe("consent_missing");

    const events = await client.query(
      "select count(*)::int as n from private.gmail_outreach_creator_decision_events where normalized_thread_id = $1",
      [normalizedThreadId],
    );
    expect(events.rows[0].n).toBe(0);

    const after = await getOutreachStatus(deps, { userId, mailAccountId });
    if (after.result !== "ok") throw new Error("expected ok status");
    expect(after.counts.threadsClassified).toBe(before.counts.threadsClassified);
  });

  it("deletion_pending: the decision RPC refuses and writes no new event", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-a3-f2-deletion-pending");
    const deps = outreachDeps(client);
    const { normalizedThreadId } = await normalizeFixture({
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      internalDateMs: Date.now(),
      to: "marketing@hotel-a3f2c.example",
    });
    await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    await startDeletion(client, mailAccountId, userId, "gmail_derived_data");

    const result = await recordCreatorDecisionAs(client, userId, deps, {
      mailAccountId,
      normalizedThreadId,
      axis: "outreach",
      outreachDecision: "outreach_confirmed",
    });
    expect(result.result).toBe("deletion_pending");

    const events = await client.query(
      "select count(*)::int as n from private.gmail_outreach_creator_decision_events where normalized_thread_id = $1",
      [normalizedThreadId],
    );
    expect(events.rows[0].n).toBe(0);
  });

  it("network_intelligence_contribution=false does NOT block an otherwise-permitted creator decision", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-a3-f2-network-consent");
    // `connectedMailbox` only ever grants `private_gmail_processing` —
    // `network_intelligence_contribution` is never touched, so it is
    // ABSENT for this mailbox. B01's own invariant is that absence means
    // NOT GRANTED (never a fabricated `false` row) — proving the gate
    // reads ONLY `private_gmail_processing` and never conflates the two
    // consent kinds.
    const networkConsent = await client.query(
      "select 1 from public.mail_account_consents where mail_account_id = $1 and consent_kind = 'network_intelligence_contribution'",
      [mailAccountId],
    );
    expect(networkConsent.rows).toHaveLength(0);

    const deps = outreachDeps(client);
    const { normalizedThreadId } = await normalizeFixture({
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      internalDateMs: Date.now(),
      to: "marketing@hotel-a3f2d.example",
    });
    await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });

    const result = await recordCreatorDecisionAs(client, userId, deps, {
      mailAccountId,
      normalizedThreadId,
      axis: "outreach",
      outreachDecision: "not_outreach_confirmed",
    });
    expect(result.result).toBe("ok");
  });

  it("REAL RACE: creator-decision vs consent withdrawal — mutually exclusive via the same locked fence", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-a3-f2-race-withdraw");
    const deps = outreachDeps(client);
    const { normalizedThreadId } = await normalizeFixture({
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      internalDateMs: Date.now(),
      to: "marketing@hotel-a3f2e.example",
    });
    await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });

    const t1 = await session();
    const t2 = await session();

    await t1.query("begin");
    const t1Pid = await backendPid(t1);
    await t1.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    const decisionPromise = t1.query(
      `select public.gmail_outreach_record_creator_decision(
         p_mail_account_id := $1, p_normalized_thread_id := $2, p_axis := 'outreach',
         p_outreach_decision := 'not_outreach_confirmed'
       ) as result`,
      [mailAccountId, normalizedThreadId],
    );

    // See the identical guard in "B05 wins the fence first": don't assume
    // the unawaited decision call above has already reached its lock by the
    // time T2 issues a conflicting statement — observe it.
    await waitUntilLockHeld(t1Pid, "public.mail_account_consents");

    await t2.query("begin");
    const t2Pid = await backendPid(t2);
    const receipt = await t2.query(
      `insert into public.mail_account_consent_receipts
         (mail_account_id, user_id, consent_kind, decision, policy_version, consent_text_digest,
          granted_scopes_at_decision, decided_by_user_id, decided_at, receipt_digest)
       values ($1, $2, 'private_gmail_processing', 'withdrawn', 'p/1', $3,
               (select granted_scopes from public.mail_accounts where id = $1), $2, now(), $4)
       returning id, event_seq`,
      [mailAccountId, userId, "a".repeat(64), "f".repeat(64)],
    );
    const withdrawPromise = t2.query(
      `update public.mail_account_consents
          set state = 'withdrawn', current_receipt_id = $2, current_event_seq = $3
        where mail_account_id = $1 and consent_kind = 'private_gmail_processing'`,
      [mailAccountId, receipt.rows[0].id, receipt.rows[0].event_seq],
    );
    const blockers = await waitUntilBlocked(t2Pid);
    expect(blockers).toContain(t1Pid);

    const decisionResult = await decisionPromise;
    await t1.query("commit");
    expect((decisionResult.rows[0].result as { result: string }).result).toBe("ok");

    await withdrawPromise;
    await t2.query(
      "update public.mail_accounts set connection_state = 'consent_required' where id = $1",
      [mailAccountId],
    );
    await t2.query("commit");
  });

  it("REAL RACE: creator-decision vs deletion-start — mutually exclusive via the same locked fence", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-a3-f2-race-deletion");
    const deps = outreachDeps(client);
    const { normalizedThreadId } = await normalizeFixture({
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      internalDateMs: Date.now(),
      to: "marketing@hotel-a3f2f.example",
    });
    await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });

    const t1 = await session();
    const t2 = await session();

    // T2 (deletion-start) begins first, holds the mail_accounts UPDATE open.
    await t2.query("begin");
    await beginDeletionStart(t2, { mailAccountId, userId });

    await t1.query("begin");
    const t1Pid = await backendPid(t1);
    await t1.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    const decisionPromise = t1.query(
      `select public.gmail_outreach_record_creator_decision(
         p_mail_account_id := $1, p_normalized_thread_id := $2, p_axis := 'outreach',
         p_outreach_decision := 'not_outreach_confirmed'
       ) as result`,
      [mailAccountId, normalizedThreadId],
    );

    const t2Pid = await backendPid(t2);
    const blockers = await waitUntilBlocked(t1Pid);
    expect(blockers).toContain(t2Pid);

    await t2.query("commit");

    const decisionResult = await decisionPromise;
    await t1.query("commit");
    expect((decisionResult.rows[0].result as { result: string }).result).toBe("deletion_pending");

    const events = await client.query(
      "select count(*)::int as n from private.gmail_outreach_creator_decision_events where normalized_thread_id = $1",
      [normalizedThreadId],
    );
    expect(events.rows[0].n).toBe(0);
  });
});

d(
  "B05 Finding 3: private target observations are provenance-stable — material evidence changes fork a NEW fact",
  () => {
    it("A: a material change in the authored-text target name forks a NEW fact; the old confirmed fact is untouched; canonical links never cross-contaminate; no creator event is fabricated", async () => {
      // EXTERNAL AUDIT AMENDMENT #6, Finding 2: `recipient_domain` observation
      // identity no longer depends on any name at all (a recipient's display
      // name is contact/person evidence, never business identity — see
      // unit.test.ts) — a `recipient_domain` observation at the SAME domain
      // can no longer fork on a "name" change, because it never carried a
      // business name in the first place. The fork-on-material-evidence-
      // change PRINCIPLE this test proves now lives on the authored-text-name
      // observation path instead (EXTERNAL AUDIT AMENDMENT #5, Finding 1) — a
      // freemail recipient isolates the test to that path alone, exactly like
      // the analogous case in audit-amendment-5.test.ts.
      const { userId, mailAccountId } = await connectedMailbox(client, "b05-a3-f3-fork");
      const deps = outreachDeps(client);
      const providerThreadId = randomProviderId("thread");
      const providerMessageId = randomProviderId("msg");
      await insertHotel(client, { name: "A3F3 Hotel Alpha" });
      await insertHotel(client, { name: "A3F3 Hotel Beta" });

      const { normalizedThreadId } = await normalizeFixture({
        userId,
        mailAccountId,
        providerMessageId,
        providerThreadId,
        internalDateMs: 1_700_000_000_000,
        to: "someone@gmail.com",
        body: "I'd love to collaborate with A3F3 Hotel Alpha on a partnership",
      });
      const outcome1 = await interpretOneThread(deps, {
        userId,
        mailAccountId,
        normalizedThreadId,
      });
      expect(outcome1.result).toBe("ok");

      const observationsV1 = await targetObservationsOf(client, normalizedThreadId);
      expect(observationsV1).toHaveLength(1);
      expect(observationsV1[0]!.observed_name).toBe("A3F3 Hotel Alpha");
      expect(observationsV1[0]!.observation_source_kind).toBe("authored_text_name");
      const originalObservationId = observationsV1[0]!.id;

      const confirm = await recordCreatorDecisionAs(client, userId, deps, {
        mailAccountId,
        normalizedThreadId,
        axis: "target",
        targetAction: "confirm",
        targetObservationId: originalObservationId,
      });
      expect(confirm.result).toBe("ok");

      // SOURCE REBUILD/CHANGE (the audit's own scenario): the SAME message is
      // corrected — a real B04 invalidation-and-rebuild (0038 §7) — and the
      // corrected evidence names a MATERIALLY DIFFERENT authored target. This
      // is not a second message; it is the existing message's own evidence
      // changing underneath the same durable thread.
      const { updateRawMessage } = await import("../gmail-normalize/harness");
      const bodyV2 = "Actually, I'd love to collaborate with A3F3 Hotel Beta instead.";
      const sanitizedV2 = buildSanitizedMessage({
        providerMessageId,
        providerThreadId,
        internalDateMs: 1_700_000_001_000,
        labelIds: ["SENT"],
        messageHeaders: [
          { name: "subject", value: "Collaboration opportunity" },
          { name: "to", value: "someone@gmail.com" },
        ],
        payload: {
          mimeType: "text/plain",
          body: { size: bodyV2.length, data: Buffer.from(bodyV2, "utf8").toString("base64url") },
        },
      });
      const raw2 = await updateRawMessage(client, {
        mailAccountId,
        providerMessageId,
        sanitized: sanitizedV2,
      });
      const normalizeDeps = {
        db: createRpcClient(
          client,
        ) as unknown as import("@/lib/gmail/normalize/service").NormalizeDeps["db"],
      };
      const normalized2 = await normalizeOneCandidate(normalizeDeps, userId, {
        mail_account_id: mailAccountId,
        provider_message_id: providerMessageId,
        provider_thread_id: providerThreadId,
        internal_date_ms: sanitizedV2.internal_date_ms,
        label_ids: sanitizedV2.label_ids,
        sanitized_payload: sanitizedV2,
        payload_sha256: raw2.payloadSha256,
      });
      if (normalized2.result !== "ok") throw new Error("rebuild normalization failed");

      const outcome2 = await interpretOneThread(deps, {
        userId,
        mailAccountId,
        normalizedThreadId,
      });
      expect(outcome2.result).toBe("ok");

      const observationsV2 = await targetObservationsOf(client, normalizedThreadId);
      expect(observationsV2).toHaveLength(2); // a NEW fact, old one untouched

      const oldFact = observationsV2.find((o) => o.id === originalObservationId)!;
      const newFact = observationsV2.find((o) => o.id !== originalObservationId)!;
      expect(oldFact.observed_name).toBe("A3F3 Hotel Alpha"); // identity never rewritten
      expect(newFact.observed_name).toBe("A3F3 Hotel Beta");
      // EXTERNAL AUDIT AMENDMENT #6, Finding 3: the superseded fact is
      // preserved for history but is no longer part of the machine's CURRENT
      // interpretation; the new fact is.
      expect(oldFact.machine_is_current).toBe(false);
      expect(newFact.machine_is_current).toBe(true);

      // The old fact's confirmation is untouched.
      const oldConfirmation = await client.query(
        "select is_confirmed from private.gmail_outreach_target_confirmations where target_observation_id = $1",
        [originalObservationId],
      );
      expect(oldConfirmation.rows[0]?.is_confirmed).toBe(true);
      const newConfirmation = await client.query(
        "select 1 from private.gmail_outreach_target_confirmations where target_observation_id = $1",
        [newFact.id],
      );
      expect(newConfirmation.rows).toHaveLength(0); // never decided

      // Only the ONE real human decision event ever exists.
      const events = await client.query(
        "select count(*)::int as n from private.gmail_outreach_creator_decision_events where normalized_thread_id = $1 and axis = 'target'",
        [normalizedThreadId],
      );
      expect(events.rows[0].n).toBe(1);

      // Canonical links for the new fact are never attached to the old fact
      // and vice versa — each has exactly its OWN matched hotel, never both.
      const oldLinks = await client.query(
        "select target_hotel_id from private.gmail_outreach_target_canonical_links where target_observation_id = $1",
        [originalObservationId],
      );
      const newLinks = await client.query(
        "select target_hotel_id from private.gmail_outreach_target_canonical_links where target_observation_id = $1",
        [newFact.id],
      );
      expect(oldLinks.rows).toHaveLength(1);
      expect(newLinks.rows).toHaveLength(1);
      expect(oldLinks.rows[0].target_hotel_id).not.toBe(newLinks.rows[0].target_hotel_id);
    });

    it("B: the SAME target named again in an additional SENT follow-up reconciles onto the SAME fact, and its provenance honestly grows", async () => {
      const { userId, mailAccountId } = await connectedMailbox(client, "b05-a3-f3-followup");
      const deps = outreachDeps(client);
      const providerThreadId = randomProviderId("thread");
      const providerMessageId1 = randomProviderId("msg");

      const { normalizedThreadId } = await normalizeFixture({
        userId,
        mailAccountId,
        providerMessageId: providerMessageId1,
        providerThreadId,
        internalDateMs: Date.now(),
        to: "Hotel Chain <marketing@a3f3-followup.example>",
      });
      await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });

      const observationsV1 = await targetObservationsOf(client, normalizedThreadId);
      expect(observationsV1).toHaveLength(1);
      const factId = observationsV1[0]!.id;
      expect(observationsV1[0]!.source_provider_message_ids).toEqual([providerMessageId1]);

      const providerMessageId2 = randomProviderId("msg");
      await normalizeFixture({
        userId,
        mailAccountId,
        providerMessageId: providerMessageId2,
        providerThreadId,
        internalDateMs: Date.now() + 1000,
        to: "Hotel Chain <marketing@a3f3-followup.example>", // SAME target evidence
      });
      await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });

      const observationsV2 = await targetObservationsOf(client, normalizedThreadId);
      expect(observationsV2).toHaveLength(1); // still the SAME fact, no duplicate
      expect(observationsV2[0]!.id).toBe(factId);
      expect(new Set(observationsV2[0]!.source_provider_message_ids)).toEqual(
        new Set([providerMessageId1, providerMessageId2]), // provenance GREW
      );
    });

    it("C: a B04 row-id-only rebuild (identical evidence) leaves the target fact perfectly stable", async () => {
      const { userId, mailAccountId } = await connectedMailbox(client, "b05-a3-f3-rebuild");
      const deps = outreachDeps(client);
      const providerMessageId = randomProviderId("msg");
      const providerThreadId = randomProviderId("thread");

      const { normalizedThreadId } = await normalizeFixture({
        userId,
        mailAccountId,
        providerMessageId,
        providerThreadId,
        internalDateMs: 1_700_000_000_000,
        to: "Hotel Chain <marketing@a3f3-rebuild.example>",
      });
      await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
      const before = await targetObservationsOf(client, normalizedThreadId);
      expect(before).toHaveLength(1);
      const factId = before[0]!.id;

      // An unrelated payload correction (same recipient content) forces a real
      // B04 rebuild (new normalized-message/participant row ids) without
      // changing any target evidence.
      const { updateRawMessage } = await import("../gmail-normalize/harness");
      const sanitizedV2 = buildSanitizedMessage({
        providerMessageId,
        providerThreadId,
        internalDateMs: 1_700_000_001_000,
        labelIds: ["SENT"],
        messageHeaders: [
          { name: "subject", value: "Collaboration opportunity" },
          { name: "to", value: "Hotel Chain <marketing@a3f3-rebuild.example>" },
        ],
        payload: {
          mimeType: "text/plain",
          body: {
            size: 40,
            data: Buffer.from("I'd love to collaborate on a partnership", "utf8").toString(
              "base64url",
            ),
          },
        },
      });
      const raw2 = await updateRawMessage(client, {
        mailAccountId,
        providerMessageId,
        sanitized: sanitizedV2,
      });
      const normalizeDeps = {
        db: createRpcClient(
          client,
        ) as unknown as import("@/lib/gmail/normalize/service").NormalizeDeps["db"],
      };
      const normalized2 = await normalizeOneCandidate(normalizeDeps, userId, {
        mail_account_id: mailAccountId,
        provider_message_id: providerMessageId,
        provider_thread_id: providerThreadId,
        internal_date_ms: sanitizedV2.internal_date_ms,
        label_ids: sanitizedV2.label_ids,
        sanitized_payload: sanitizedV2,
        payload_sha256: raw2.payloadSha256,
      });
      if (normalized2.result !== "ok") throw new Error("rebuild normalization failed");

      await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
      const after = await targetObservationsOf(client, normalizedThreadId);
      expect(after).toHaveLength(1);
      expect(after[0]!.id).toBe(factId); // SAME target fact — perfectly stable
    });

    it("D: explicit account deletion purges every target-observation row", async () => {
      const { userId, mailAccountId } = await connectedMailbox(client, "b05-a3-f3-deletion");
      const deps = outreachDeps(client);
      const { normalizedThreadId } = await normalizeFixture({
        userId,
        mailAccountId,
        providerMessageId: randomProviderId("msg"),
        providerThreadId: randomProviderId("thread"),
        internalDateMs: Date.now(),
        to: "Hotel Chain <marketing@a3f3-deletion.example>",
      });
      await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
      expect(await targetObservationsOf(client, normalizedThreadId)).toHaveLength(1);

      const deletionRequestId = await startDeletion(client, mailAccountId, userId);
      const purge = await deps.db.rpc("gmail_outreach_purge_for_deletion", {
        p_user_id: userId,
        p_mail_account_id: mailAccountId,
        p_deletion_request_id: deletionRequestId,
      });
      expect((purge.data as { result: string }).result).toBe("ok");
      expect(await targetObservationsOf(client, normalizedThreadId)).toHaveLength(0);
    });
  },
);
