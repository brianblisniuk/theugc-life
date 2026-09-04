import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { interpretOneThread } from "@/lib/gmail/outreach/service";
import { normalizeOneCandidate } from "@/lib/gmail/normalize/service";
import { updateRawMessage } from "../gmail-normalize/harness";
import { createRpcClient } from "../gmail/rpc-harness";
import {
  connectedMailbox,
  insertNormalizedThread,
  outreachDeps,
  randomProviderId,
  targetObservationsOf,
  threadSignalRow,
} from "./harness";

/**
 * B05 EXTERNAL AUDIT AMENDMENT #4 — direct proofs for Findings 1, 2 and 4.
 * D070 remains ACCEPTED; nothing here reopens Amendments #1-#3's already-
 * passed findings. Finding 3 (HTML boundary preservation) is covered at the
 * unit level in unit.test.ts — it needs no real-Postgres fixture.
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
  c.on("error", () => undefined);
  await c.connect();
  openSessions.push(c);
  return c;
}

async function insertHotel(
  c: Client,
  input: { name: string; websiteUrl?: string | null },
): Promise<string> {
  const dest = await c.query(
    `insert into public.destinations (id, name, slug, type) values (gen_random_uuid(), $1, $2, 'city') returning id`,
    [`${input.name} destination`, randomProviderId("dest")],
  );
  const hotel = await c.query(
    `insert into public.hotels (name, slug, destination_id, website_url) values ($1, $2, $3, $4) returning id`,
    [input.name, randomProviderId("hotel"), dest.rows[0].id, input.websiteUrl ?? null],
  );
  return hotel.rows[0].id as string;
}

d(
  "B05 Finding 1: qualified_outreach requires independently-established commercial-target evidence, not proposal language alone",
  () => {
    it("a creator emailing their OWN freemail address with UGC language is never qualified_outreach — no commercial target/representative evidence exists", async () => {
      const { userId, mailAccountId } = await connectedMailbox(client, "b05-a4-f1-self");
      const deps = outreachDeps(client);
      const { normalizedThreadId } = await insertNormalizedThread(client, {
        userId,
        mailAccountId,
        providerMessageId: randomProviderId("msg"),
        providerThreadId: randomProviderId("thread"),
        toRecipients: ["me@gmail.com"],
        bodyText: "I'd love to collaborate on some UGC content and a paid partnership.",
      });

      const outcome = await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
      expect(outcome.result).toBe("ok");
      const signal = await threadSignalRow(client, normalizedThreadId);
      expect(signal.outreach_status).not.toBe("qualified_outreach");
      expect(signal.outreach_status).toBe("needs_review");
      expect(signal.reason_codes).toContain("creator_commercial_proposal_language_detected");
      expect(signal.reason_codes).not.toContain("commercial_target_evidence_present");
    });

    it("a creator emailing an UNRELATED freemail contact with UGC language is never qualified_outreach", async () => {
      const { userId, mailAccountId } = await connectedMailbox(client, "b05-a4-f1-freemail");
      const deps = outreachDeps(client);
      const { normalizedThreadId } = await insertNormalizedThread(client, {
        userId,
        mailAccountId,
        providerMessageId: randomProviderId("msg"),
        providerThreadId: randomProviderId("thread"),
        toRecipients: ["friend@gmail.com"],
        bodyText: "Here's my UGC collaboration template, let me know what you think.",
      });

      await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
      const signal = await threadSignalRow(client, normalizedThreadId);
      expect(signal.outreach_status).toBe("needs_review");
    });

    it("proposal language plus a genuine non-freemail business recipient DOES qualify — the domain is real commercial-target/representative evidence", async () => {
      const { userId, mailAccountId } = await connectedMailbox(client, "b05-a4-f1-business");
      const deps = outreachDeps(client);
      const { normalizedThreadId } = await insertNormalizedThread(client, {
        userId,
        mailAccountId,
        providerMessageId: randomProviderId("msg"),
        providerThreadId: randomProviderId("thread"),
        toRecipients: ["marketing@a4-business-hotel.example"],
        bodyText: "I'd love to collaborate with your hotel on some UGC content.",
      });

      await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
      const signal = await threadSignalRow(client, normalizedThreadId);
      expect(signal.outreach_status).toBe("qualified_outreach");
      expect(signal.reason_codes).toContain("commercial_target_evidence_present");
    });

    it("proposal language to an INTERMEDIARY (agency) plus authored text explicitly naming a REAL canonical business also qualifies", async () => {
      const { userId, mailAccountId } = await connectedMailbox(client, "b05-a4-f1-agency");
      const deps = outreachDeps(client);
      const hotelId = await insertHotel(client, { name: "A4 Ambassador Hotel" });

      const { normalizedThreadId } = await insertNormalizedThread(client, {
        userId,
        mailAccountId,
        providerMessageId: randomProviderId("msg"),
        providerThreadId: randomProviderId("thread"),
        toRecipients: ["jane@a4-agency.example"],
        bodyText: "I'd love to collaborate with A4 Ambassador Hotel on a paid partnership.",
      });

      await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
      const signal = await threadSignalRow(client, normalizedThreadId);
      expect(signal.outreach_status).toBe("qualified_outreach");
      expect(signal.reason_codes).toContain("commercial_target_evidence_present");

      const observations = await targetObservationsOf(client, normalizedThreadId);
      expect(observations).toHaveLength(1);
      const links = await client.query(
        "select * from private.gmail_outreach_target_canonical_links where target_observation_id = $1",
        [observations[0].id],
      );
      const hotelLink = links.rows.find((r) => r.target_hotel_id === hotelId);
      expect(hotelLink).toBeDefined();
      expect(hotelLink!.authored_text_evidence).toBe("agrees");
    });
  },
);

d(
  "B05 Finding 2: creator-authored target-name evidence enters the candidate universe and never lets weaker evidence overrule an explicit contradiction",
  () => {
    it("canonical contact evidence points to Hotel A, but authored text explicitly names Hotel B — Hotel A is never strong_match", async () => {
      const { userId, mailAccountId } = await connectedMailbox(client, "b05-a4-f2-contradiction");
      const deps = outreachDeps(client);
      const hotelAId = await insertHotel(client, {
        name: "A4 Hotel A",
        websiteUrl: "https://a4-hotel-a.example",
      });
      await insertHotel(client, { name: "A4 Hotel B" });
      await client.query(
        "insert into public.hotel_contacts (hotel_id, email) values ($1, 'marketing@a4-hotel-a.example')",
        [hotelAId],
      );

      const { normalizedThreadId } = await insertNormalizedThread(client, {
        userId,
        mailAccountId,
        providerMessageId: randomProviderId("msg"),
        providerThreadId: randomProviderId("thread"),
        toRecipients: ["marketing@a4-hotel-a.example"],
        bodyText:
          "Actually, I'd love to collaborate with A4 Hotel B instead on a paid partnership.",
      });

      await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });

      const observations = await targetObservationsOf(client, normalizedThreadId);
      expect(observations).toHaveLength(1);
      expect(observations[0].machine_canonical_link_assessment).not.toBe("strong_match");
      expect(observations[0].machine_canonical_link_assessment).toBe("needs_review");

      const links = await client.query(
        "select * from private.gmail_outreach_target_canonical_links where target_observation_id = $1",
        [observations[0].id],
      );
      const hotelALink = links.rows.find((r) => r.target_hotel_id === hotelAId);
      expect(hotelALink!.authored_text_evidence).toBe("differs");
    });

    it("an agency recipient plus authored text naming a real business the agency has no domain/contact relation to still surfaces that business as a candidate", async () => {
      const { userId, mailAccountId } = await connectedMailbox(client, "b05-a4-f2-agency-named");
      const deps = outreachDeps(client);
      const hotelId = await insertHotel(client, { name: "A4 Named Hotel" });

      const { normalizedThreadId } = await insertNormalizedThread(client, {
        userId,
        mailAccountId,
        providerMessageId: randomProviderId("msg"),
        providerThreadId: randomProviderId("thread"),
        toRecipients: ["contact@a4-named-agency.example"],
        bodyText: "I'd love to collaborate with A4 Named Hotel on a paid partnership.",
      });

      await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });

      const observations = await targetObservationsOf(client, normalizedThreadId);
      expect(observations).toHaveLength(1);
      const links = await client.query(
        "select * from private.gmail_outreach_target_canonical_links where target_observation_id = $1",
        [observations[0].id],
      );
      const namedLink = links.rows.find((r) => r.target_hotel_id === hotelId);
      expect(namedLink).toBeDefined();
      expect(namedLink!.authored_text_evidence).toBe("agrees");
    });

    it("an agency recipient plus authored text naming TWO real businesses preserves both as candidates under the same observation", async () => {
      const { userId, mailAccountId } = await connectedMailbox(client, "b05-a4-f2-agency-multi");
      const deps = outreachDeps(client);
      const hotelAId = await insertHotel(client, { name: "A4 Multi Hotel Alpha" });
      const hotelBId = await insertHotel(client, { name: "A4 Multi Hotel Beta" });

      const { normalizedThreadId } = await insertNormalizedThread(client, {
        userId,
        mailAccountId,
        providerMessageId: randomProviderId("msg"),
        providerThreadId: randomProviderId("thread"),
        toRecipients: ["contact@a4-multi-agency.example"],
        bodyText:
          "I'd love to collaborate with A4 Multi Hotel Alpha and A4 Multi Hotel Beta on a paid partnership.",
      });

      await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });

      const observations = await targetObservationsOf(client, normalizedThreadId);
      expect(observations).toHaveLength(1);
      const links = await client.query(
        "select * from private.gmail_outreach_target_canonical_links where target_observation_id = $1 and authored_text_evidence = 'agrees'",
        [observations[0].id],
      );
      const matchedIds = links.rows.map((r) => r.target_hotel_id).sort();
      expect(matchedIds).toEqual([hotelAId, hotelBId].sort());
    });
  },
);

d(
  "B05 Finding 4: source staleness is a deterministic evidence-digest comparison, immune to a transaction-timestamp inversion",
  () => {
    it("a rebuild transaction opened BEFORE, but committed AFTER, a commit that evaluated the pre-rebuild evidence is still detected as source_stale — even though its normalized_at reads BEFORE the signal's evaluated_at", async () => {
      const { userId, mailAccountId } = await connectedMailbox(client, "b05-a4-f4-staleness");
      const deps = outreachDeps(client);
      const providerMessageId = randomProviderId("msg");
      const providerThreadId = randomProviderId("thread");

      const { normalizedThreadId } = await insertNormalizedThread(client, {
        userId,
        mailAccountId,
        providerMessageId,
        providerThreadId,
        toRecipients: ["marketing@a4-staleness-hotel.example"],
        bodyText: "Original message text.",
      });

      // T1: a real B04 rebuild transaction begins now, opened EARLY, and is
      // held open (its `now()`/transaction_timestamp() is pinned to THIS
      // moment for every default it writes) — but its actual DML is not
      // issued yet, so it holds no lock T2 needs to contend with.
      const t1 = await session();
      await t1.query("begin");

      // T2: evaluate + commit the CURRENT (pre-rebuild) evidence normally —
      // uncontended, since t1 has touched nothing yet.
      const outcome = await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
      expect(outcome.result).toBe("ok");
      const signalBefore = await threadSignalRow(client, normalizedThreadId);
      const digestBefore = signalBefore.evidence_digest as string;

      // T1 now performs the real rebuild (a genuine payload correction —
      // updateRawMessage + normalizeOneCandidate, the same real B04 path used
      // throughout this suite) on ITS OWN long-open transaction. Every
      // `normalized_at default now()` this INSERT touches evaluates to T1's
      // transaction START time, not this later statement's wall-clock time.
      const t1Deps = {
        db: createRpcClient(t1) as unknown as Parameters<typeof normalizeOneCandidate>[0]["db"],
      };
      const newSanitized = {
        provider_message_id: providerMessageId,
        provider_thread_id: providerThreadId,
        internal_date_ms: Date.now(),
        label_ids: ["SENT"],
        provider_history_id: null,
        size_estimate: null,
        message_headers: [
          { name: "subject", value: "hello" },
          { name: "to", value: "marketing@a4-staleness-hotel.example" },
        ],
        payload: {
          mimeType: "text/plain",
          body: {
            size: 30,
            data: Buffer.from("Materially corrected text.", "utf8").toString("base64url"),
          },
        },
      };
      const { payloadSha256: newPayloadSha256 } = await updateRawMessage(t1, {
        mailAccountId,
        providerMessageId,
        sanitized: newSanitized,
      });
      const rebuildOutcome = await normalizeOneCandidate(t1Deps, userId, {
        mail_account_id: mailAccountId,
        provider_message_id: providerMessageId,
        provider_thread_id: providerThreadId,
        internal_date_ms: newSanitized.internal_date_ms,
        label_ids: newSanitized.label_ids,
        sanitized_payload: newSanitized,
        payload_sha256: newPayloadSha256,
      });
      expect(rebuildOutcome.result).toBe("ok");

      // T1 commits AFTER T2 already did — chronologically later — but its
      // row's `normalized_at` was pinned to a moment BEFORE T2's commit.
      await t1.query("commit");

      const rebuiltMessage = await client.query(
        "select normalized_at from private.gmail_normalized_messages where normalized_thread_id = $1",
        [normalizedThreadId],
      );
      // Prove the exact adversarial condition: the rebuilt row's timestamp is
      // NOT after the signal's evaluated_at — the OLD `normalized_at >
      // evaluated_at` check would have said "not stale" here.
      expect(new Date(rebuiltMessage.rows[0].normalized_at).getTime()).toBeLessThanOrEqual(
        new Date(signalBefore.evaluated_at).getTime(),
      );

      const candidates = await deps.db.rpc("gmail_outreach_list_candidates", {
        p_user_id: userId,
        p_mail_account_id: mailAccountId,
        p_detector_version: "gmail_outreach_rules_v4",
        p_matcher_version: "gmail_outreach_match_rules_v4",
        p_current_catalog_epoch: 0,
        p_limit: 10,
      });
      const row = (
        candidates.data as { candidates: Array<Record<string, unknown>> }
      ).candidates.find((c) => c.normalized_thread_id === normalizedThreadId);
      expect(row).toBeDefined();
      expect(row!.source_stale).toBe(true);

      // And a real re-interpretation genuinely picks up the corrected content
      // — the digest actually changed, this isn't a false-positive flag.
      const reoutcome = await interpretOneThread(deps, {
        userId,
        mailAccountId,
        normalizedThreadId,
        staleness: { sourceStale: true, matcherStale: false, catalogStale: false },
      });
      expect(reoutcome.result).toBe("ok");
      const signalAfter = await threadSignalRow(client, normalizedThreadId);
      expect(signalAfter.evidence_digest).not.toBe(digestBefore);
    });
  },
);
