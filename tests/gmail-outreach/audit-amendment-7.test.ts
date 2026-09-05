import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  getThreadEvidence,
  interpretOneThread,
  type OutreachDeps,
} from "@/lib/gmail/outreach/service";
import { matchTargetObservation as matchTargetObservationReal } from "@/lib/gmail/outreach/target-extraction";
import { normalizeOneCandidate } from "@/lib/gmail/normalize/service";
import { updateRawMessage } from "../gmail-normalize/harness";
import { createRpcClient } from "../gmail/rpc-harness";
import {
  canonicalLinksOf,
  confirmedTargetsOf,
  connectedMailbox,
  insertHotel,
  insertNormalizedThread,
  outreachDeps,
  randomProviderId,
  recordCreatorDecisionAs,
  targetObservationsOf,
} from "./harness";

/**
 * B05 EXTERNAL AUDIT AMENDMENT #7 — direct real-Postgres proofs for Finding 1
 * (canonical-independent private target facts) and Finding 3 (current-only
 * machine-state read surface, via the REAL `getThreadEvidence` production
 * read path, not a direct table query). Finding 2 (safe coordinated-name
 * segmentation) is covered at the unit level in unit.test.ts — it needs no
 * database. D070 remains ACCEPTED; nothing here reopens Amendments #1-#6's
 * already-passed findings.
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

async function rebuildBody(input: {
  userId: string;
  mailAccountId: string;
  providerMessageId: string;
  providerThreadId: string;
  to: string;
  body: string;
  internalDateMs: number;
}) {
  const { buildSanitizedMessage } = await import("../gmail-normalize/harness");
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
        size: input.body.length,
        data: Buffer.from(input.body, "utf8").toString("base64url"),
      },
    },
  });
  const raw = await updateRawMessage(client, {
    mailAccountId: input.mailAccountId,
    providerMessageId: input.providerMessageId,
    sanitized,
  });
  const normalizeDeps = {
    db: createRpcClient(client) as unknown as Parameters<typeof normalizeOneCandidate>[0]["db"],
  };
  const outcome = await normalizeOneCandidate(normalizeDeps, input.userId, {
    mail_account_id: input.mailAccountId,
    provider_message_id: input.providerMessageId,
    provider_thread_id: input.providerThreadId,
    internal_date_ms: sanitized.internal_date_ms,
    label_ids: sanitized.label_ids,
    sanitized_payload: sanitized,
    payload_sha256: raw.payloadSha256,
  });
  if (outcome.result !== "ok") throw new Error(`rebuild failed: ${JSON.stringify(outcome)}`);
}

d("B05 Finding 1: canonical-independent private target facts", () => {
  it("required test A: a non-freemail (agency) recipient with a target-directed authored name ABSENT from the catalog still creates BOTH a domain observation and an independent, zero-link authored observation — no canonical row is fabricated", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-a7-f1-agency-no-catalog");
    const deps = outreachDeps(client);

    const { normalizedThreadId } = await insertNormalizedThread(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      toRecipients: ["jane@a7-agency-no-catalog.example"],
      bodyText: "I'd love to collaborate with A7 Acme Surfwear on UGC.",
    });

    const outcome = await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    expect(outcome.result).toBe("ok");

    const observations = await targetObservationsOf(client, normalizedThreadId);
    expect(observations).toHaveLength(2);
    const domainObs = observations.find((o) => o.observation_source_kind === "recipient_domain");
    const authoredObs = observations.find(
      (o) => o.observation_source_kind === "authored_text_name",
    );
    expect(domainObs).toBeDefined();
    expect(authoredObs).toBeDefined();
    expect(authoredObs!.observed_name).toBe("A7 Acme Surfwear");
    expect(authoredObs!.machine_canonical_link_assessment).toBe("insufficient_evidence");
    expect(authoredObs!.machine_is_current).toBe(true);

    const links = await canonicalLinksOf(client, authoredObs!.id);
    expect(links).toHaveLength(0);

    const hotelRow = await client.query("select 1 from public.hotels where name = $1", [
      "A7 Acme Surfwear",
    ]);
    expect(hotelRow.rows).toHaveLength(0);
  });

  it("required test B: a FREEMAIL recipient with the same unresolved authored name preserves the private fact with zero canonical links, and does NOT by itself open a new false-positive qualified_outreach path", async () => {
    const { userId, mailAccountId } = await connectedMailbox(
      client,
      "b05-a7-f1-freemail-no-catalog",
    );
    const deps = outreachDeps(client);

    const { normalizedThreadId } = await insertNormalizedThread(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      toRecipients: ["someone@gmail.com"],
      bodyText: "I'd love to collaborate with A7 Acme Surfwear on UGC.",
    });

    const outcome = await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    expect(outcome).toMatchObject({ result: "ok", outreachStatus: "needs_review" });

    const observations = await targetObservationsOf(client, normalizedThreadId);
    expect(observations).toHaveLength(1);
    expect(observations[0]!.observation_source_kind).toBe("authored_text_name");
    expect(observations[0]!.observed_name).toBe("A7 Acme Surfwear");
    expect(observations[0]!.machine_canonical_link_assessment).toBe("insufficient_evidence");

    const links = await canonicalLinksOf(client, observations[0]!.id);
    expect(links).toHaveLength(0);
  });

  it("required test C: adding a matching canonical row LATER reconciles onto the SAME private observation — no new human decision is fabricated, and a pre-existing confirmation survives", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-a7-f1-later-canonical");
    const deps = outreachDeps(client);

    const { normalizedThreadId } = await insertNormalizedThread(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      toRecipients: ["someone@gmail.com"],
      bodyText: "I'd love to collaborate with A7 Later Hotel on UGC.",
    });
    await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    const before = await targetObservationsOf(client, normalizedThreadId);
    expect(before).toHaveLength(1);
    const observationId = before[0]!.id;
    expect(before[0]!.machine_canonical_link_assessment).toBe("insufficient_evidence");

    const confirm = await recordCreatorDecisionAs(client, userId, deps, {
      mailAccountId,
      normalizedThreadId,
      axis: "target",
      targetAction: "confirm",
      targetObservationId: observationId,
    });
    expect(confirm.result).toBe("ok");

    const hotelId = await insertHotel(client, { name: "A7 Later Hotel" });

    await interpretOneThread(deps, {
      userId,
      mailAccountId,
      normalizedThreadId,
      staleness: { sourceStale: false, matcherStale: false, catalogStale: true },
    });

    const after = await targetObservationsOf(client, normalizedThreadId);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(observationId);
    expect(after[0]!.machine_canonical_link_assessment).toBe("strong_match");

    const links = await canonicalLinksOf(client, observationId);
    expect(links).toHaveLength(1);
    expect(links[0]!.target_hotel_id).toBe(hotelId);

    const confirmations = await confirmedTargetsOf(client, normalizedThreadId);
    const confirmation = confirmations.find((c) => c.target_observation_id === observationId);
    expect(confirmation!.is_confirmed).toBe(true);
  });

  it("required test D: deleting the matching canonical row does NOT make the Gmail-derived fact non-current — a catalog mutation never changes what the creator's OWN evidence currently supports", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-a7-f1-canonical-removed");
    const deps = outreachDeps(client);
    const hotelId = await insertHotel(client, { name: "A7 Removed Hotel" });

    const { normalizedThreadId } = await insertNormalizedThread(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      toRecipients: ["someone@gmail.com"],
      bodyText: "I'd love to collaborate with A7 Removed Hotel on UGC.",
    });
    await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    const before = await targetObservationsOf(client, normalizedThreadId);
    expect(before).toHaveLength(1);
    const observationId = before[0]!.id;
    expect(before[0]!.machine_canonical_link_assessment).toBe("strong_match");
    expect(before[0]!.machine_is_current).toBe(true);

    await client.query("delete from public.hotels where id = $1", [hotelId]);

    await interpretOneThread(deps, {
      userId,
      mailAccountId,
      normalizedThreadId,
      staleness: { sourceStale: false, matcherStale: false, catalogStale: true },
    });

    const after = await targetObservationsOf(client, normalizedThreadId);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(observationId); // the SAME durable fact — never discarded
    expect(after[0]!.machine_is_current).toBe(true); // Gmail text never changed
    expect(after[0]!.machine_canonical_link_assessment).toBe("insufficient_evidence");

    const links = await canonicalLinksOf(client, observationId);
    expect(links).toHaveLength(0);
  });
});

d(
  "B05 Finding 3: current-only machine-state read surface (proven via the REAL getThreadEvidence production read path)",
  () => {
    it("required tests A/B: a HISTORICAL observation is excluded from machine_state.target_observations while its human confirmation remains durably queryable and unchanged", async () => {
      const { userId, mailAccountId } = await connectedMailbox(client, "b05-a7-f3-current-read");
      const deps = outreachDeps(client);
      const providerMessageId = randomProviderId("msg");
      const providerThreadId = randomProviderId("thread");
      await insertHotel(client, { name: "A7 Read Hotel Alpha" });
      await insertHotel(client, { name: "A7 Read Hotel Beta" });

      const { normalizedThreadId } = await insertNormalizedThread(client, {
        userId,
        mailAccountId,
        providerMessageId,
        providerThreadId,
        internalDateMs: 1_700_000_000_000,
        toRecipients: ["someone@gmail.com"],
        bodyText: "I'd love to collaborate with A7 Read Hotel Alpha on a partnership.",
      });
      await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
      const v1 = await targetObservationsOf(client, normalizedThreadId);
      expect(v1).toHaveLength(1);
      const historicalId = v1[0]!.id;

      const confirm = await recordCreatorDecisionAs(client, userId, deps, {
        mailAccountId,
        normalizedThreadId,
        axis: "target",
        targetAction: "confirm",
        targetObservationId: historicalId,
      });
      expect(confirm.result).toBe("ok");

      await rebuildBody({
        userId,
        mailAccountId,
        providerMessageId,
        providerThreadId,
        to: "someone@gmail.com",
        body: "I'd love to collaborate with A7 Read Hotel Beta on a partnership.",
        internalDateMs: 1_700_000_001_000,
      });
      await interpretOneThread(deps, {
        userId,
        mailAccountId,
        normalizedThreadId,
        staleness: { sourceStale: true, matcherStale: false, catalogStale: false },
      });

      const all = await targetObservationsOf(client, normalizedThreadId);
      expect(all).toHaveLength(2);
      const historical = all.find((o) => o.id === historicalId)!;
      const current = all.find((o) => o.id !== historicalId)!;
      expect(historical.machine_is_current).toBe(false);
      expect(current.machine_is_current).toBe(true);

      // The REAL production read path — never a direct table query.
      const evidence = await getThreadEvidence(deps, { userId, mailAccountId, normalizedThreadId });
      if (evidence.result !== "ok") throw new Error(`unexpected: ${evidence.result}`);
      const fingerprints = evidence.machineState.targetObservations.map(
        (o) => o.observationFingerprint,
      );
      expect(fingerprints).toEqual([current.observation_fingerprint]);
      expect(fingerprints).not.toContain(historical.observation_fingerprint);

      // The human confirmation of the now-historical fact remains durably
      // queryable and unchanged — current-only filtering is a MACHINE
      // read-surface concern, never a human-decision concern.
      const confirmations = await confirmedTargetsOf(client, normalizedThreadId);
      const historicalConfirmation = confirmations.find(
        (c) => c.target_observation_id === historicalId,
      );
      expect(historicalConfirmation!.is_confirmed).toBe(true);
    });

    it("required test C: a fact that genuinely reappears in current evidence is returned again by getThreadEvidence's machine-state read", async () => {
      const { userId, mailAccountId } = await connectedMailbox(client, "b05-a7-f3-reappear-read");
      const deps = outreachDeps(client);
      const providerMessageId = randomProviderId("msg");
      const providerThreadId = randomProviderId("thread");
      await insertHotel(client, { name: "A7 Reappear Read Hotel" });
      const withHotel = "I'd love to collaborate with A7 Reappear Read Hotel on a partnership.";
      const withoutHotel = "Just checking in, thanks!";

      const { normalizedThreadId } = await insertNormalizedThread(client, {
        userId,
        mailAccountId,
        providerMessageId,
        providerThreadId,
        internalDateMs: 1_700_000_000_000,
        toRecipients: ["someone@gmail.com"],
        bodyText: withHotel,
      });
      await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
      const v1 = await targetObservationsOf(client, normalizedThreadId);
      const observationId = v1[0]!.id;

      await rebuildBody({
        userId,
        mailAccountId,
        providerMessageId,
        providerThreadId,
        to: "someone@gmail.com",
        body: withoutHotel,
        internalDateMs: 1_700_000_001_000,
      });
      await interpretOneThread(deps, {
        userId,
        mailAccountId,
        normalizedThreadId,
        staleness: { sourceStale: true, matcherStale: false, catalogStale: false },
      });

      const goneEvidence = await getThreadEvidence(deps, {
        userId,
        mailAccountId,
        normalizedThreadId,
      });
      if (goneEvidence.result !== "ok") throw new Error("unreachable");
      expect(goneEvidence.machineState.targetObservations).toHaveLength(0);

      await rebuildBody({
        userId,
        mailAccountId,
        providerMessageId,
        providerThreadId,
        to: "someone@gmail.com",
        body: withHotel,
        internalDateMs: 1_700_000_002_000,
      });
      await interpretOneThread(deps, {
        userId,
        mailAccountId,
        normalizedThreadId,
        staleness: { sourceStale: true, matcherStale: false, catalogStale: false },
      });

      const backEvidence = await getThreadEvidence(deps, {
        userId,
        mailAccountId,
        normalizedThreadId,
      });
      if (backEvidence.result !== "ok") throw new Error("unreachable");
      expect(backEvidence.machineState.targetObservations).toHaveLength(1);
      expect(backEvidence.machineState.targetObservations[0]!.observationFingerprint).toBe(
        v1[0]!.observation_fingerprint,
      );

      const after = await targetObservationsOf(client, normalizedThreadId);
      expect(after).toHaveLength(1);
      expect(after[0]!.id).toBe(observationId); // the SAME durable fact, reactivated
    });

    it("required test E: the two-level fast-path reuse still works for a domain observation that stays CURRENT throughout — the current-only filter never forces a needless full re-match", async () => {
      const { userId, mailAccountId } = await connectedMailbox(
        client,
        "b05-a7-f3-fastpath-still-works",
      );
      let matchCalls = 0;
      const deps: OutreachDeps = {
        ...outreachDeps(client),
        matchTargetObservation: (observation, addresses, catalog, names, text) => {
          matchCalls += 1;
          return matchTargetObservationReal(observation, addresses, catalog, names, text);
        },
      };
      await insertHotel(client, {
        name: "A7 Fastpath Hotel",
        websiteUrl: "https://a7-fastpath.example",
      });

      const { normalizedThreadId } = await insertNormalizedThread(client, {
        userId,
        mailAccountId,
        providerMessageId: randomProviderId("msg"),
        providerThreadId: randomProviderId("thread"),
        toRecipients: ["marketing@a7-fastpath.example"],
        bodyText: "Hi there, just checking in.",
      });
      await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
      expect(matchCalls).toBe(1);

      // An UNRELATED catalog mutation bumps the coarse epoch but changes
      // nothing relevant to this thread's own domain/addresses.
      await insertHotel(client, { name: "A7 Fastpath Unrelated Hotel" });

      await interpretOneThread(deps, {
        userId,
        mailAccountId,
        normalizedThreadId,
        staleness: { sourceStale: false, matcherStale: false, catalogStale: true },
      });
      expect(matchCalls).toBe(1); // reused, never re-matched

      const observations = await targetObservationsOf(client, normalizedThreadId);
      expect(observations).toHaveLength(1);
      expect(observations[0]!.machine_is_current).toBe(true);
    });
  },
);
