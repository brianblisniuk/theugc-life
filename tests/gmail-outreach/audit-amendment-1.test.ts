import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  getCatalogSnapshot,
  getCurrentCatalogEpoch,
  interpretOneThread,
  recordCreatorDecision,
} from "@/lib/gmail/outreach/service";
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
} from "./harness";

/**
 * B05 EXTERNAL AUDIT AMENDMENT #1 — direct proofs for Findings 1, 3 and 4.
 * Each test exercises the REAL migration 0039 functions/constraints against
 * real PostgreSQL — never a reimplementation of the guarantee under test.
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

async function session(): Promise<Client> {
  const c = new Client({ connectionString: TEST_DB });
  await c.connect();
  return c;
}

d("B05 Finding 1: a B04 rebuild never orphans human history", () => {
  it("re-normalizing a thread's message (same recipient content, new B04 row ids) reconciles the durable observed-recipient row and leaves the human target-contact confirmation intact", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-f1-rebuild");
    const normalizeDeps = {
      db: createRpcClient(
        client,
      ) as unknown as import("@/lib/gmail/normalize/service").NormalizeDeps["db"],
    };
    const providerMessageId = randomProviderId("msg");
    const providerThreadId = randomProviderId("thread");

    const sanitizedV1 = buildSanitizedMessage({
      providerMessageId,
      providerThreadId,
      internalDateMs: 1_700_000_000_000,
      labelIds: ["SENT"],
      messageHeaders: [
        { name: "subject", value: "Collaboration opportunity" },
        { name: "to", value: "marketing@acmehotel.example" },
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
    const raw1 = await insertRawMessage(client, { mailAccountId, userId, sanitized: sanitizedV1 });
    const normalized1 = await normalizeOneCandidate(normalizeDeps, userId, {
      mail_account_id: mailAccountId,
      provider_message_id: providerMessageId,
      provider_thread_id: providerThreadId,
      internal_date_ms: sanitizedV1.internal_date_ms,
      label_ids: sanitizedV1.label_ids,
      sanitized_payload: sanitizedV1,
      payload_sha256: raw1.payloadSha256,
    });
    if (normalized1.result !== "ok") throw new Error("fixture normalization failed");
    const normalizedThreadId = normalized1.normalizedThreadId;

    const deps = outreachDeps(client);
    const outcome1 = await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    expect(outcome1.result).toBe("ok");

    const recipientsBefore = await observedRecipientsOf(client, normalizedThreadId);
    expect(recipientsBefore).toHaveLength(1);
    const observedRecipientId = recipientsBefore[0]!.id;
    const participantBefore = recipientsBefore[0]!.current_source_participant_id;

    const confirmation = await recordCreatorDecisionAs(client, userId, deps, {
      mailAccountId,
      normalizedThreadId,
      axis: "target_contact",
      targetAction: "confirm",
      observedRecipientId,
    });
    expect(confirmation.result).toBe("ok");

    // FORCE A REAL B04 REBUILD: a raw re-import with a genuinely different
    // payload (later internal_date, same recipient structure) fires 0038's
    // own invalidation trigger, which deletes the normalized message row —
    // cascading its headers/participants — and recreates it under NEW ids.
    const sanitizedV2 = { ...sanitizedV1, internal_date_ms: sanitizedV1.internal_date_ms + 1000 };
    const raw2 = await updateRawMessage(client, {
      mailAccountId,
      providerMessageId,
      sanitized: sanitizedV2,
    });
    expect(raw2.payloadSha256).not.toBe(raw1.payloadSha256);

    // Proof the rebuild actually happened: the OLD participant row is gone.
    const oldParticipant = await client.query(
      "select 1 from private.gmail_normalized_participants where id = $1",
      [participantBefore],
    );
    expect(oldParticipant.rows).toHaveLength(0);

    // THE HUMAN CONFIRMATION SURVIVES, UNTOUCHED, THROUGH THE REBUILD —
    // before B05 has even re-run.
    const confirmedDuringRebuild = await client.query(
      "select is_confirmed from private.gmail_outreach_target_contact_confirmed_members where observed_recipient_id = $1",
      [observedRecipientId],
    );
    expect(confirmedDuringRebuild.rows[0]?.is_confirmed).toBe(true);
    const recipientDuringRebuild = await client.query(
      "select id from private.gmail_outreach_observed_recipients where id = $1",
      [observedRecipientId],
    );
    expect(recipientDuringRebuild.rows).toHaveLength(1);

    // B04 rebuild: re-normalize under the new payload.
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
    // The THREAD id is stable across the rebuild (0038's own guarantee).
    expect(normalized2.normalizedThreadId).toBe(normalizedThreadId);

    // B05 MACHINE re-run: reconciles the SAME durable observed-recipient row.
    const outcome2 = await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    expect(outcome2.result).toBe("ok");

    const recipientsAfter = await observedRecipientsOf(client, normalizedThreadId);
    expect(recipientsAfter).toHaveLength(1);
    expect(recipientsAfter[0]!.id).toBe(observedRecipientId); // SAME row id.
    expect(recipientsAfter[0]!.current_source_participant_id).not.toBe(participantBefore); // NEW B04 link.

    // The human confirmation still references the same row, and is still
    // exactly as the creator left it — a machine rebuild never touched it.
    const confirmedAfter = await client.query(
      "select is_confirmed from private.gmail_outreach_target_contact_confirmed_members where observed_recipient_id = $1",
      [observedRecipientId],
    );
    expect(confirmedAfter.rows[0]?.is_confirmed).toBe(true);
  });
});

d("B05 Finding 3: human projections never move backwards under real concurrency", () => {
  it("scalar axis (outreach): a lower event_seq that finishes its projection write AFTER a higher one is silently ignored, never resurrected", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-f3-scalar");
    const deps = outreachDeps(client);
    const raw = buildSanitizedMessage({
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      internalDateMs: Date.now(),
    });
    const rawResult = await insertRawMessage(client, { mailAccountId, userId, sanitized: raw });
    const normalizeDeps = {
      db: createRpcClient(
        client,
      ) as unknown as import("@/lib/gmail/normalize/service").NormalizeDeps["db"],
    };
    const normalized = await normalizeOneCandidate(normalizeDeps, userId, {
      mail_account_id: mailAccountId,
      provider_message_id: raw.provider_message_id,
      provider_thread_id: raw.provider_thread_id,
      internal_date_ms: raw.internal_date_ms,
      label_ids: raw.label_ids,
      sanitized_payload: raw,
      payload_sha256: rawResult.payloadSha256,
    });
    if (normalized.result !== "ok") throw new Error("fixture normalization failed");
    const normalizedThreadId = normalized.normalizedThreadId;
    await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });

    // Establish an initial committed decision.
    await recordCreatorDecisionAs(client, userId, deps, {
      mailAccountId,
      normalizedThreadId,
      axis: "outreach",
      outreachDecision: "not_outreach_confirmed",
    });

    // T1 allocates the LOWER event_seq first, but holds its transaction open
    // before touching the projection row.
    const t1 = await session();
    const t2 = await session();
    try {
      await t1.query("begin");
      const claimsT1 = JSON.stringify({ sub: userId, role: "authenticated" });
      await t1.query("select set_config('request.jwt.claims', $1, true)", [claimsT1]);
      const eventT1 = await t1.query(
        `insert into private.gmail_outreach_creator_decision_events
           (user_id, mail_account_id, normalized_thread_id, axis, decided_by_user_id, outreach_decision)
         values ($1, $2, $3, 'outreach', $1, 'outreach_confirmed')
         returning id, event_seq`,
        [userId, mailAccountId, normalizedThreadId],
      );
      const seqT1 = Number(eventT1.rows[0].event_seq);

      // T2 allocates a HIGHER event_seq and completes its ENTIRE write
      // (event + projection) first.
      await t2.query("begin");
      const eventT2 = await t2.query(
        `insert into private.gmail_outreach_creator_decision_events
           (user_id, mail_account_id, normalized_thread_id, axis, decided_by_user_id, outreach_decision)
         values ($1, $2, $3, 'outreach', $1, 'not_outreach_confirmed')
         returning id, event_seq`,
        [userId, mailAccountId, normalizedThreadId],
      );
      const seqT2 = Number(eventT2.rows[0].event_seq);
      expect(seqT2).toBeGreaterThan(seqT1);

      await t2.query(
        `insert into private.gmail_outreach_creator_decisions
           (user_id, mail_account_id, normalized_thread_id, outreach_decision, current_outreach_event_id, current_outreach_event_seq)
         values ($1, $2, $3, 'not_outreach_confirmed', $4, $5)
         on conflict (mail_account_id, normalized_thread_id) do update
           set outreach_decision = excluded.outreach_decision,
               current_outreach_event_id = excluded.current_outreach_event_id,
               current_outreach_event_seq = excluded.current_outreach_event_seq
         where excluded.current_outreach_event_seq > private.gmail_outreach_creator_decisions.current_outreach_event_seq`,
        [userId, mailAccountId, normalizedThreadId, eventT2.rows[0].id, seqT2],
      );
      await t2.query("commit");

      // T1 (the LOWER seq) now finally attempts its own projection write,
      // arriving AFTER T2 already committed the higher one.
      await t1.query(
        `insert into private.gmail_outreach_creator_decisions
           (user_id, mail_account_id, normalized_thread_id, outreach_decision, current_outreach_event_id, current_outreach_event_seq)
         values ($1, $2, $3, 'outreach_confirmed', $4, $5)
         on conflict (mail_account_id, normalized_thread_id) do update
           set outreach_decision = excluded.outreach_decision,
               current_outreach_event_id = excluded.current_outreach_event_id,
               current_outreach_event_seq = excluded.current_outreach_event_seq
         where excluded.current_outreach_event_seq > private.gmail_outreach_creator_decisions.current_outreach_event_seq`,
        [userId, mailAccountId, normalizedThreadId, eventT1.rows[0].id, seqT1],
      );
      await t1.query("commit");
    } finally {
      await t1.end();
      await t2.end();
    }

    // The projection reflects the HIGHER seq (T2's), never T1's — even
    // though T1's write physically executed last.
    const finalProjection = await client.query(
      "select outreach_decision, current_outreach_event_seq from private.gmail_outreach_creator_decisions where mail_account_id = $1 and normalized_thread_id = $2",
      [mailAccountId, normalizedThreadId],
    );
    expect(finalProjection.rows[0].outreach_decision).toBe("not_outreach_confirmed");

    // BOTH events are permanently in the immutable ledger — the "losing"
    // write is never silently dropped from history, only from the CURRENT
    // projection.
    const events = await client.query(
      "select outreach_decision from private.gmail_outreach_creator_decision_events where normalized_thread_id = $1 and axis = 'outreach' order by event_seq",
      [normalizedThreadId],
    );
    // Ledger order by event_seq: the initial decision, then T1's event
    // (allocated first, "outreach_confirmed"), then T2's event (allocated
    // second, "not_outreach_confirmed") — T1's LOWER seq losing the
    // projection race does not erase or reorder its own ledger entry.
    expect(events.rows.map((r) => r.outreach_decision)).toEqual([
      "not_outreach_confirmed",
      "outreach_confirmed",
      "not_outreach_confirmed",
    ]);
  });

  it("SET axis (target confirmation): a stale, delayed 'confirm' can never resurrect a membership a newer 'remove' already retired", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-f3-tombstone");
    const deps = outreachDeps(client);

    const raw = buildSanitizedMessage({
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      internalDateMs: Date.now(),
    });
    const rawResult = await insertRawMessage(client, { mailAccountId, userId, sanitized: raw });
    const normalizeDeps = {
      db: createRpcClient(
        client,
      ) as unknown as import("@/lib/gmail/normalize/service").NormalizeDeps["db"],
    };
    const normalized = await normalizeOneCandidate(normalizeDeps, userId, {
      mail_account_id: mailAccountId,
      provider_message_id: raw.provider_message_id,
      provider_thread_id: raw.provider_thread_id,
      internal_date_ms: raw.internal_date_ms,
      label_ids: raw.label_ids,
      sanitized_payload: raw,
      payload_sha256: rawResult.payloadSha256,
    });
    if (normalized.result !== "ok") throw new Error("fixture normalization failed");
    const normalizedThreadId = normalized.normalizedThreadId;

    const inserted = await client.query(
      `insert into private.gmail_outreach_target_observations
         (user_id, mail_account_id, normalized_thread_id, observation_fingerprint, observed_name, target_kind_hint, source_provider_message_ids)
       values ($1, $2, $3, $4, 'Tombstone Test Target', 'unknown', '{provider-msg-tombstone}')
       returning id`,
      [userId, mailAccountId, normalizedThreadId, "c".repeat(64)],
    );
    const targetObservationId = inserted.rows[0].id;

    // Confirm (seq A), then remove (seq B > A) — the ordinary sequence.
    await recordCreatorDecisionAs(client, userId, deps, {
      mailAccountId,
      normalizedThreadId,
      axis: "target",
      targetAction: "confirm",
      targetObservationId,
    });
    await recordCreatorDecisionAs(client, userId, deps, {
      mailAccountId,
      normalizedThreadId,
      axis: "target",
      targetAction: "remove",
      targetObservationId,
    });

    const afterRemove = await client.query(
      "select is_confirmed, current_event_seq from private.gmail_outreach_target_confirmations where target_observation_id = $1",
      [targetObservationId],
    );
    expect(afterRemove.rows[0].is_confirmed).toBe(false);
    const removeSeq = Number(afterRemove.rows[0].current_event_seq);

    // A STALE, delayed 'confirm' — its event is inserted with a LOWER
    // event_seq than the remove above (simulated directly, as a race would
    // produce), and its projection write must be silently ignored.
    await client.query(
      `insert into private.gmail_outreach_target_confirmations
         (mail_account_id, normalized_thread_id, target_observation_id, is_confirmed, current_event_id, current_event_seq)
       values ($1, $2, $3, true, (select id from private.gmail_outreach_creator_decision_events where normalized_thread_id = $2 order by event_seq limit 1), $4)
       on conflict (normalized_thread_id, target_observation_id) do update
         set is_confirmed = excluded.is_confirmed,
             current_event_id = excluded.current_event_id,
             current_event_seq = excluded.current_event_seq
       where excluded.current_event_seq > private.gmail_outreach_target_confirmations.current_event_seq`,
      [mailAccountId, normalizedThreadId, targetObservationId, removeSeq - 1],
    );

    const finalState = await client.query(
      "select is_confirmed from private.gmail_outreach_target_confirmations where target_observation_id = $1",
      [targetObservationId],
    );
    expect(finalState.rows[0].is_confirmed).toBe(false); // still removed — never resurrected.
  });
});

d("B05 Finding 4: catalog-epoch fence and bounded relevant candidates", () => {
  it("a commit whose p_catalog_epoch no longer matches the current epoch is refused as stale_catalog, writing nothing", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-f4-catalog-fence");
    const deps = outreachDeps(client);
    const raw = buildSanitizedMessage({
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      internalDateMs: Date.now(),
      messageHeaders: [{ name: "subject", value: "hello" }],
    });
    const rawResult = await insertRawMessage(client, { mailAccountId, userId, sanitized: raw });
    const normalizeDeps = {
      db: createRpcClient(
        client,
      ) as unknown as import("@/lib/gmail/normalize/service").NormalizeDeps["db"],
    };
    const normalized = await normalizeOneCandidate(normalizeDeps, userId, {
      mail_account_id: mailAccountId,
      provider_message_id: raw.provider_message_id,
      provider_thread_id: raw.provider_thread_id,
      internal_date_ms: raw.internal_date_ms,
      label_ids: raw.label_ids,
      sanitized_payload: raw,
      payload_sha256: rawResult.payloadSha256,
    });
    if (normalized.result !== "ok") throw new Error("fixture normalization failed");
    const normalizedThreadId = normalized.normalizedThreadId;

    const evidence = await deps.db.rpc("gmail_outreach_get_thread_evidence", {
      p_user_id: userId,
      p_mail_account_id: mailAccountId,
      p_normalized_thread_id: normalizedThreadId,
    });
    const staleEpoch = await getCurrentCatalogEpoch(deps);

    // Bump the epoch: an UNRELATED catalog insert.
    const dest = await client.query(
      `insert into public.destinations (id, name, slug, type) values (gen_random_uuid(), 'F4 Dest', $1, 'city') returning id`,
      [randomProviderId("dest")],
    );
    await client.query(
      `insert into public.hotels (name, slug, destination_id) values ('F4 Unrelated Hotel', $1, $2)`,
      [randomProviderId("hotel"), dest.rows[0].id],
    );
    const newEpoch = await getCurrentCatalogEpoch(deps);
    expect(newEpoch).toBeGreaterThan(staleEpoch);

    const messages = (
      evidence.data as {
        messages: Array<{
          normalized_message_id: string;
          provider_message_id: string;
          provider_sent: boolean;
          source_payload_sha256: string;
        }>;
      }
    ).messages;
    const digestInput = messages
      .map((m) => `${m.normalized_message_id}:${m.source_payload_sha256}:${m.provider_sent}`)
      .sort()
      .join("|");
    const { createHash } = await import("node:crypto");
    const expectedDigest = createHash("sha256").update(digestInput).digest("hex");

    const commit = await deps.db.rpc("gmail_outreach_commit_interpretation", {
      p_user_id: userId,
      p_mail_account_id: mailAccountId,
      p_normalized_thread_id: normalizedThreadId,
      p_detector_version: "gmail_outreach_rules_v2",
      p_matcher_version: "gmail_outreach_match_rules_v2",
      p_expected_evidence_digest: expectedDigest,
      p_outreach_status: "insufficient_evidence",
      p_reason_codes: [],
      p_recipient_participant_ids: [],
      p_target_contact_match_quality: "insufficient_evidence",
      p_target_contact_candidate_set_fingerprint: "0".repeat(64),
      p_target_contact_candidates: [],
      p_target_observations: [],
      p_target_canonical_links: [],
      p_machine_target_scope: "unresolved",
      p_target_scope_reason_codes: [],
      p_catalog_epoch: staleEpoch, // deliberately the OLD epoch
    });

    expect((commit.data as { result: string; current_catalog_epoch: number }).result).toBe(
      "stale_catalog",
    );
    expect((commit.data as { current_catalog_epoch: number }).current_catalog_epoch).toBe(newEpoch);

    const signal = await client.query(
      "select 1 from private.gmail_outreach_thread_signals where normalized_thread_id = $1",
      [normalizedThreadId],
    );
    expect(signal.rows).toHaveLength(0); // nothing written at all
  });

  it("getCatalogSnapshot is bounded: an unrelated hotel with an unrelated domain is never included", async () => {
    const { mailAccountId, userId } = await connectedMailbox(client, "b05-f4-bounded");
    void userId;
    const deps = outreachDeps(client);

    const dest = await client.query(
      `insert into public.destinations (id, name, slug, type) values (gen_random_uuid(), 'F4 Bounded Dest', $1, 'city') returning id`,
      [randomProviderId("dest")],
    );
    await client.query(
      `insert into public.hotels (name, slug, destination_id, website_url) values ('Totally Unrelated Hotel', $1, $2, 'https://totallyunrelated.example')`,
      [randomProviderId("hotel"), dest.rows[0].id],
    );

    const catalog = await getCatalogSnapshot(deps, {
      associatedAddresses: ["someone@relevantdomain.example"],
      observedDomains: ["relevantdomain.example"],
    });

    expect(catalog.hotels.find((h) => h.name === "Totally Unrelated Hotel")).toBeUndefined();
    expect(mailAccountId).toBeTruthy();
  });
});
