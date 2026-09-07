import { createHash } from "node:crypto";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  getCatalogSnapshot,
  getCurrentCatalogEpoch,
  getOutreachStatus,
  interpretBatch,
  interpretOneThread,
  type OutreachDeps,
} from "@/lib/gmail/outreach/service";
import { classifyOutreach as classifyOutreachReal } from "@/lib/gmail/outreach/interpreter";
import { matchTargetObservation as matchTargetObservationReal } from "@/lib/gmail/outreach/target-extraction";
import { normalizeOneCandidate } from "@/lib/gmail/normalize/service";
import {
  buildSanitizedMessage,
  insertRawMessage,
  updateRawMessage,
} from "../gmail-normalize/harness";
import { createRpcClient } from "../gmail/rpc-harness";
import {
  connectedMailbox,
  observedRecipientsOf,
  outreachDeps,
  randomProviderId,
  recordCreatorDecisionAs,
  startDeletion,
  withdrawConsent,
} from "./harness";

/**
 * B05 EXTERNAL AUDIT AMENDMENT #2 — direct proofs for Findings 1, 2, 3, 4 and
 * 8. Each test exercises the REAL migration 0039 functions/constraints
 * against real PostgreSQL — never a reimplementation of the guarantee under
 * test. D070 remains ACCEPTED; nothing here reopens a product decision.
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

async function normalizeFixture(input: {
  userId: string;
  mailAccountId: string;
  providerMessageId: string;
  providerThreadId: string;
  internalDateMs: number;
  to: string;
}) {
  const normalizeDeps = {
    db: createRpcClient(
      client,
    ) as unknown as import("@/lib/gmail/normalize/service").NormalizeDeps["db"],
  };
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
      body: {
        size: 40,
        data: Buffer.from("I'd love to collaborate on a partnership", "utf8").toString("base64url"),
      },
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
  return { normalizedThreadId: normalized.normalizedThreadId, payloadSha256: raw.payloadSha256 };
}

async function rebuildFixture(input: {
  mailAccountId: string;
  userId: string;
  providerMessageId: string;
  providerThreadId: string;
  internalDateMs: number;
  to: string;
}) {
  const normalizeDeps = {
    db: createRpcClient(
      client,
    ) as unknown as import("@/lib/gmail/normalize/service").NormalizeDeps["db"],
  };
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
      body: {
        size: 40,
        data: Buffer.from("I'd love to collaborate on a partnership", "utf8").toString("base64url"),
      },
    },
  });
  const raw = await updateRawMessage(client, {
    mailAccountId: input.mailAccountId,
    providerMessageId: input.providerMessageId,
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
  if (normalized.result !== "ok") throw new Error("rebuild normalization failed");
  return normalized.normalizedThreadId;
}

d(
  "B05 Finding 1: a materially different recipient at the same coordinate forks a NEW private observation",
  () => {
    it("same coordinate + same evidence reconciles the SAME row; same coordinate + DIFFERENT evidence forks a NEW row and leaves the old confirmation untouched; explicit deletion purges both", async () => {
      const { userId, mailAccountId } = await connectedMailbox(client, "b05-f1-fork");
      const deps = outreachDeps(client);
      const providerMessageId = randomProviderId("msg");
      const providerThreadId = randomProviderId("thread");

      // 1. Original evidence: a single `to` recipient at hotel-a.
      const { normalizedThreadId } = await normalizeFixture({
        userId,
        mailAccountId,
        providerMessageId,
        providerThreadId,
        internalDateMs: 1_700_000_000_000,
        to: "marketing@hotel-a.example",
      });
      const outcome1 = await interpretOneThread(deps, {
        userId,
        mailAccountId,
        normalizedThreadId,
      });
      expect(outcome1.result).toBe("ok");

      const recipientsV1 = await observedRecipientsOf(client, normalizedThreadId);
      expect(recipientsV1).toHaveLength(1);
      expect(recipientsV1[0]!.addr_spec).toBe("marketing@hotel-a.example");
      expect(recipientsV1[0]!.is_current).toBe(true);
      const originalRowId = recipientsV1[0]!.id;

      // 2. Human confirms THIS row as a target contact.
      const confirm = await recordCreatorDecisionAs(client, userId, deps, {
        mailAccountId,
        normalizedThreadId,
        axis: "target_contact",
        targetAction: "confirm",
        observedRecipientId: originalRowId,
      });
      expect(confirm.result).toBe("ok");

      // 3. A B04 rebuild with IDENTICAL recipient evidence (e.g. an unrelated
      // payload correction) reconciles the SAME row — Finding 1's baseline.
      const normalizedThreadIdReconciled = await rebuildFixture({
        userId,
        mailAccountId,
        providerMessageId,
        providerThreadId,
        internalDateMs: 1_700_000_001_000,
        to: "marketing@hotel-a.example",
      });
      expect(normalizedThreadIdReconciled).toBe(normalizedThreadId);
      const outcome2 = await interpretOneThread(deps, {
        userId,
        mailAccountId,
        normalizedThreadId,
      });
      expect(outcome2.result).toBe("ok");

      const recipientsV2 = await observedRecipientsOf(client, normalizedThreadId);
      expect(recipientsV2).toHaveLength(1); // still ONE row
      expect(recipientsV2[0]!.id).toBe(originalRowId); // SAME row
      expect(recipientsV2[0]!.is_current).toBe(true);

      // 4. A B04 rebuild whose recipient evidence is MATERIALLY DIFFERENT at
      // the EXACT SAME structural coordinate (one `to` header, one address) —
      // e.g. a raw-payload correction that changes who the message was
      // actually sent to.
      await rebuildFixture({
        userId,
        mailAccountId,
        providerMessageId,
        providerThreadId,
        internalDateMs: 1_700_000_002_000,
        to: "manager@hotel-b.example",
      });
      const outcome3 = await interpretOneThread(deps, {
        userId,
        mailAccountId,
        normalizedThreadId,
      });
      expect(outcome3.result).toBe("ok");

      const recipientsV3 = await observedRecipientsOf(client, normalizedThreadId);
      expect(recipientsV3).toHaveLength(2); // a NEW row alongside the old one

      const oldRow = recipientsV3.find((r) => r.id === originalRowId)!;
      const newRow = recipientsV3.find((r) => r.id !== originalRowId)!;
      expect(oldRow).toBeTruthy();
      expect(newRow).toBeTruthy();

      // 5. The OLD row is untouched (still the old address) and marked stale;
      // the NEW row carries the new address and is the current one.
      expect(oldRow.addr_spec).toBe("marketing@hotel-a.example");
      expect(oldRow.is_current).toBe(false);
      expect(oldRow.current_source_participant_id).toBeNull();
      expect(newRow.addr_spec).toBe("manager@hotel-b.example");
      expect(newRow.is_current).toBe(true);

      // 6. NO human event was fabricated: the OLD confirmation still says
      // exactly what the creator decided, about the OLD (now superseded)
      // evidence — never silently reassigned to the new one.
      const oldConfirmation = await client.query(
        "select is_confirmed from private.gmail_outreach_target_contact_confirmed_members where observed_recipient_id = $1",
        [originalRowId],
      );
      expect(oldConfirmation.rows[0]?.is_confirmed).toBe(true);
      const newConfirmation = await client.query(
        "select 1 from private.gmail_outreach_target_contact_confirmed_members where observed_recipient_id = $1",
        [newRow.id],
      );
      expect(newConfirmation.rows).toHaveLength(0); // never decided

      const decisionEvents = await client.query(
        "select count(*)::int as n from private.gmail_outreach_creator_decision_events where normalized_thread_id = $1 and axis = 'target_contact'",
        [normalizedThreadId],
      );
      expect(decisionEvents.rows[0].n).toBe(1); // only the ONE real human decision ever made

      // 7. Explicit account deletion purges BOTH rows (old and new) together.
      const deletionRequestId = await startDeletion(client, mailAccountId, userId);
      const purge = await deps.db.rpc("gmail_outreach_purge_for_deletion", {
        p_user_id: userId,
        p_mail_account_id: mailAccountId,
        p_deletion_request_id: deletionRequestId,
      });
      expect((purge.data as { result: string }).result).toBe("ok");
      const afterPurge = await observedRecipientsOf(client, normalizedThreadId);
      expect(afterPurge).toHaveLength(0);
    });
  },
);

d("B05 Finding 2: the actual private_gmail_processing consent gate", () => {
  it("consent withdrawal refuses NEW processing (list/evidence/commit) but never deletes EXISTING B05 history", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-f2-consent");
    const deps = outreachDeps(client);
    const providerMessageId = randomProviderId("msg");
    const providerThreadId = randomProviderId("thread");
    const { normalizedThreadId } = await normalizeFixture({
      userId,
      mailAccountId,
      providerMessageId,
      providerThreadId,
      internalDateMs: Date.now(),
      to: "marketing@hotel-consent.example",
    });

    const before = await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    expect(before.result).toBe("ok");
    const statusBefore = await getOutreachStatus(deps, { userId, mailAccountId });
    if (statusBefore.result !== "ok") throw new Error("expected ok status");
    expect(statusBefore.counts.threadsClassified).toBe(1);

    await withdrawConsent(client, mailAccountId, userId);

    const candidates = await deps.db.rpc("gmail_outreach_list_candidates", {
      p_user_id: userId,
      p_mail_account_id: mailAccountId,
      p_detector_version: "gmail_outreach_rules_v3",
      p_matcher_version: "gmail_outreach_match_rules_v3",
      p_current_catalog_epoch: await getCurrentCatalogEpoch(deps),
      p_limit: 25,
      p_exclude_normalized_thread_ids: [],
    });
    expect((candidates.data as { result: string }).result).toBe("consent_missing");
    expect((candidates.data as { candidates: unknown[] }).candidates).toEqual([]);

    const evidence = await deps.db.rpc("gmail_outreach_get_thread_evidence", {
      p_user_id: userId,
      p_mail_account_id: mailAccountId,
      p_normalized_thread_id: normalizedThreadId,
    });
    expect((evidence.data as { result: string }).result).toBe("consent_missing");

    const afterWithdrawal = await interpretOneThread(deps, {
      userId,
      mailAccountId,
      normalizedThreadId,
    });
    expect(afterWithdrawal.result).toBe("consent_missing");

    // RETENTION: existing history is untouched by the withdrawal — only NEW
    // processing is refused.
    const statusAfter = await getOutreachStatus(deps, { userId, mailAccountId });
    if (statusAfter.result !== "ok") throw new Error("expected ok status");
    expect(statusAfter.counts.threadsClassified).toBe(1);
    const signalStillThere = await client.query(
      "select 1 from private.gmail_outreach_thread_signals where normalized_thread_id = $1",
      [normalizedThreadId],
    );
    expect(signalStillThere.rows).toHaveLength(1);
  });

  it("a mailbox in deletion_pending refuses new processing distinctly from consent_missing", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-f2-deletion-pending");
    const deps = outreachDeps(client);
    await startDeletion(client, mailAccountId, userId, "gmail_derived_data");

    const evidence = await deps.db.rpc("gmail_outreach_get_thread_evidence", {
      p_user_id: userId,
      p_mail_account_id: mailAccountId,
      p_normalized_thread_id: "00000000-0000-0000-0000-000000000000",
    });
    expect((evidence.data as { result: string }).result).toBe("deletion_pending");
  });

  it("REAL RACE: a commit already under way completes honestly even as a concurrent withdrawal is waiting on the SAME consent row", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-f2-race-a");
    const deps = outreachDeps(client);
    const providerMessageId = randomProviderId("msg");
    const providerThreadId = randomProviderId("thread");
    const { normalizedThreadId } = await normalizeFixture({
      userId,
      mailAccountId,
      providerMessageId,
      providerThreadId,
      internalDateMs: Date.now(),
      to: "marketing@hotel-race.example",
    });

    const evidenceResult = await deps.db.rpc("gmail_outreach_get_thread_evidence", {
      p_user_id: userId,
      p_mail_account_id: mailAccountId,
      p_normalized_thread_id: normalizedThreadId,
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
    const expectedDigest = createHash("sha256").update(digestInput).digest("hex");
    const catalogEpoch = await getCurrentCatalogEpoch(deps);

    const t1 = await session();
    const t2 = await session();

    await t1.query("begin");
    const t1Pid = await backendPid(t1);
    // T1 starts the commit — its `for share` on the consent row is acquired
    // WHILE consent is still granted, then the whole statement (including
    // this SELECT's row lock) is held open by the surrounding transaction.
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

    // T2 attempts to withdraw consent concurrently. The receipt insert
    // (a different table) never blocks; the PROJECTION update below is the
    // one that needs T1's `for share` row and must block on it. The pid is
    // captured BEFORE issuing that blocking query — node-pg serializes
    // queries per connection, so fetching it afterward would queue behind
    // the still-pending blocked query and never resolve.
    await t2.query("begin");
    const t2Pid = await backendPid(t2);
    const receipt = await t2.query(
      `insert into public.mail_account_consent_receipts
         (mail_account_id, user_id, consent_kind, decision, policy_version, consent_text_digest,
          granted_scopes_at_decision, decided_by_user_id, decided_at, receipt_digest)
       values ($1, $2, 'private_gmail_processing', 'withdrawn', 'p/1', $3,
               (select granted_scopes from public.mail_accounts where id = $1), $2, now(), $4)
       returning id, event_seq`,
      [mailAccountId, userId, "a".repeat(64), "d".repeat(64)],
    );
    const withdrawPromise = t2.query(
      `update public.mail_account_consents
          set state = 'withdrawn', current_receipt_id = $2, current_event_seq = $3
        where mail_account_id = $1 and consent_kind = 'private_gmail_processing'`,
      [mailAccountId, receipt.rows[0].id, receipt.rows[0].event_seq],
    );
    const blockers = await waitUntilBlocked(t2Pid);
    expect(blockers).toContain(t1Pid);

    // T1 finishes and commits — it was entitled to complete, since consent
    // was granted for the entirety of its transaction.
    const commitResult = await commitPromise;
    await t1.query("commit");
    expect((commitResult.rows[0].result as { result: string }).result).toBe("ok");

    // Only NOW can T2's withdrawal proceed. B01's own coherence rule
    // requires a `connected` mailbox to carry granted consent, so the same
    // withdrawal transaction also moves the mailbox to `consent_required`
    // (exactly `withdrawConsent()`'s own real-world shape).
    await withdrawPromise;
    await t2.query(
      "update public.mail_accounts set connection_state = 'consent_required' where id = $1",
      [mailAccountId],
    );
    await t2.query("commit");

    const consentNow = await client.query(
      "select state from public.mail_account_consents where mail_account_id = $1 and consent_kind = 'private_gmail_processing'",
      [mailAccountId],
    );
    expect(consentNow.rows[0].state).toBe("withdrawn");
  });
});

d("B05 Finding 3: a REAL transactional catalog-epoch fence (no TOCTOU)", () => {
  it("a catalog mutation racing DURING a commit (not merely before it) is still caught — proven via pg_blocking_pids, never a sleep", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-f3-real-race");
    const deps = outreachDeps(client);
    const providerMessageId = randomProviderId("msg");
    const providerThreadId = randomProviderId("thread");
    const { normalizedThreadId } = await normalizeFixture({
      userId,
      mailAccountId,
      providerMessageId,
      providerThreadId,
      internalDateMs: Date.now(),
      to: "marketing@hotel-fence.example",
    });

    const evidenceResult = await deps.db.rpc("gmail_outreach_get_thread_evidence", {
      p_user_id: userId,
      p_mail_account_id: mailAccountId,
      p_normalized_thread_id: normalizedThreadId,
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
    const expectedDigest = createHash("sha256").update(digestInput).digest("hex");
    const staleEpoch = await getCurrentCatalogEpoch(deps);

    const t1 = await session();
    const t2 = await session();

    // T2 starts a catalog mutation FIRST and holds it open (uncommitted) —
    // its trigger has already taken the exclusive lock on the epoch-lock row.
    await t2.query("begin");
    const t2Pid = await backendPid(t2);
    const dest = await t2.query(
      `insert into public.destinations (id, name, slug, type) values (gen_random_uuid(), 'F3 Dest', $1, 'city') returning id`,
      [randomProviderId("dest")],
    );
    await t2.query(
      `insert into public.hotels (name, slug, destination_id) values ('F3 Race Hotel', $1, $2)`,
      [randomProviderId("hotel"), dest.rows[0].id],
    );

    // T1 attempts its commit with the OLD (pre-race) epoch. Its `for share`
    // on the epoch-lock row must now BLOCK on T2's in-flight exclusive lock
    // — the real fence, not a bare unlocked read that could slip between.
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
      [userId, mailAccountId, normalizedThreadId, expectedDigest, "0".repeat(64), staleEpoch],
    );

    const blockers = await waitUntilBlocked(t1Pid);
    expect(blockers).toContain(t2Pid);

    // T2 commits, finally advancing the epoch.
    await t2.query("commit");
    const newEpoch = await getCurrentCatalogEpoch(deps);
    expect(newEpoch).toBeGreaterThan(staleEpoch);

    // T1 unblocks, re-reads the NOW-current epoch (not the stale one it
    // started with), and correctly refuses as stale — proving the race was
    // caught DURING the check, not merely before it.
    const commitResult = await commitPromise;
    await t1.query("commit");
    const parsed = commitResult.rows[0].result as { result: string; current_catalog_epoch: number };
    expect(parsed.result).toBe("stale_catalog");
    expect(parsed.current_catalog_epoch).toBe(newEpoch);

    const signal = await client.query(
      "select 1 from private.gmail_outreach_thread_signals where normalized_thread_id = $1",
      [normalizedThreadId],
    );
    expect(signal.rows).toHaveLength(0); // nothing written from the stale attempt
  });
});

d(
  "B05 Finding 4: the two-level fast path really skips the classifier/matcher (proven by counting adapters, not inferred from output)",
  () => {
    it("an epoch bump from an IRRELEVANT catalog change never reruns the classifier or the matcher; a RELEVANT change reruns matching only", async () => {
      const { userId, mailAccountId } = await connectedMailbox(client, "b05-f4-fast-path");
      let classifyCalls = 0;
      let matchCalls = 0;
      const deps: OutreachDeps = {
        ...outreachDeps(client),
        classifyOutreach: (input) => {
          classifyCalls += 1;
          return classifyOutreachReal(input);
        },
        matchTargetObservation: (observation, addresses, catalog) => {
          matchCalls += 1;
          return matchTargetObservationReal(observation, addresses, catalog);
        },
      };

      const dest = await client.query(
        `insert into public.destinations (id, name, slug, type) values (gen_random_uuid(), 'F4 Dest', $1, 'city') returning id`,
        [randomProviderId("dest")],
      );
      const hotel = await client.query(
        `insert into public.hotels (name, slug, destination_id, website_url) values ('F4 Real Hotel', $1, $2, 'https://f4realhotel.example') returning id`,
        [randomProviderId("hotel"), dest.rows[0].id],
      );
      const hotelId = hotel.rows[0].id as string;

      const providerMessageId = randomProviderId("msg");
      const providerThreadId = randomProviderId("thread");
      await normalizeFixture({
        userId,
        mailAccountId,
        providerMessageId,
        providerThreadId,
        internalDateMs: Date.now(),
        to: "marketing@f4realhotel.example",
      });

      // PASS 1 — never evaluated before: full path, both run exactly once.
      const pass1 = await interpretBatch(deps, { userId, mailAccountId, limit: 10 });
      expect(pass1.interpreted).toBe(1);
      expect(classifyCalls).toBe(1);
      expect(matchCalls).toBe(1);

      // An IRRELEVANT catalog mutation (unrelated hotel, unrelated domain)
      // still bumps the coarse epoch, so the thread is offered again — but
      // the RELEVANT candidate universe for THIS thread's own addresses/
      // domains has not changed at all.
      const irrelevantDest = await client.query(
        `insert into public.destinations (id, name, slug, type) values (gen_random_uuid(), 'F4 Irrelevant Dest', $1, 'city') returning id`,
        [randomProviderId("dest")],
      );
      await client.query(
        `insert into public.hotels (name, slug, destination_id, website_url) values ('F4 Unrelated Hotel', $1, $2, 'https://totallyunrelated.example')`,
        [randomProviderId("hotel"), irrelevantDest.rows[0].id],
      );

      const pass2 = await interpretBatch(deps, { userId, mailAccountId, limit: 10 });
      expect(pass2.interpreted).toBe(1);
      expect(classifyCalls).toBe(1); // NEVER rerun — source is fresh
      expect(matchCalls).toBe(1); // NEVER rerun — the relevant fingerprint is unchanged

      // A RELEVANT catalog change: a new canonical-contact record for the
      // EXACT address this thread's evidence associates with the target —
      // this changes the relevant candidate-set fingerprint.
      await client.query(
        `insert into public.hotel_contacts (hotel_id, email) values ($1, 'marketing@f4realhotel.example')`,
        [hotelId],
      );

      const pass3 = await interpretBatch(deps, { userId, mailAccountId, limit: 10 });
      expect(pass3.interpreted).toBe(1);
      expect(classifyCalls).toBe(1); // still never rerun — source never changed
      expect(matchCalls).toBe(2); // matching DID rerun — the relevant universe actually changed
    });
  },
);

d("B05 Finding 8: exact catalog matching — no ILIKE wildcard broadening", () => {
  it("an observed domain containing a literal `_` never wildcard-matches an unrelated website_url via unescaped ILIKE", async () => {
    const dest = await client.query(
      `insert into public.destinations (id, name, slug, type) values (gen_random_uuid(), 'F8 Dest', $1, 'city') returning id`,
      [randomProviderId("dest")],
    );
    // A real hotel whose domain does NOT contain an underscore.
    await client.query(
      `insert into public.hotels (name, slug, destination_id, website_url) values ('F8 Lookalike Hotel', $1, $2, 'https://acmexhotel.example')`,
      [randomProviderId("hotel"), dest.rows[0].id],
    );

    // Observed domain DOES contain a literal underscore. Under an unescaped
    // ILIKE `%acme_hotel.example%`, `_` means "any single character" and
    // would wildcard-match "acmexhotel.example" above — a false positive
    // lookalike match this fix must not produce.
    const catalog = await getCatalogSnapshot(outreachDeps(client), {
      associatedAddresses: [],
      observedDomains: ["acme_hotel.example"],
    });
    expect(catalog.hotels.find((h) => h.name === "F8 Lookalike Hotel")).toBeUndefined();
  });

  it("an observed address containing a literal `_` is matched EXACTLY, never as a single-character wildcard", async () => {
    const dest = await client.query(
      `insert into public.destinations (id, name, slug, type) values (gen_random_uuid(), 'F8 Contact Dest', $1, 'city') returning id`,
      [randomProviderId("dest")],
    );
    const hotel = await client.query(
      `insert into public.hotels (name, slug, destination_id) values ('F8 Contact Hotel', $1, $2) returning id`,
      [randomProviderId("hotel"), dest.rows[0].id],
    );
    // A canonical contact whose email contains a literal underscore.
    await client.query(
      `insert into public.hotel_contacts (hotel_id, email) values ($1, 'a_b@example.com')`,
      [hotel.rows[0].id],
    );

    // An observed address that would match under UNESCAPED ILIKE (`_` as
    // wildcard: "a_b" matches "axb") but must NOT match under exact equality.
    const catalog = await getCatalogSnapshot(outreachDeps(client), {
      associatedAddresses: ["axb@example.com"],
      observedDomains: [],
    });
    expect(catalog.hotelIdByContactEmail.size).toBe(0);
  });
});
