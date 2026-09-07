import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { interpretOneThread } from "@/lib/gmail/outreach/service";
import { normalizeOneCandidate } from "@/lib/gmail/normalize/service";
import { updateRawMessage } from "../gmail-normalize/harness";
import { createRpcClient } from "../gmail/rpc-harness";
import {
  confirmedTargetsOf,
  connectedMailbox,
  insertHotel,
  insertNormalizedThread,
  outreachDeps,
  randomProviderId,
  recordCreatorDecisionAs,
  targetObservationsOf,
  threadSignalRow,
} from "./harness";

/**
 * B05 EXTERNAL AUDIT AMENDMENT #6 — direct real-Postgres proofs for Finding 2
 * (recipient-domain identity vs. contact-person display name) and Finding 3
 * (explicit machine current-membership). Finding 1 (coordinated commercial-
 * target lists) is covered at the unit level in unit.test.ts — it needs no
 * database. D070 remains ACCEPTED; nothing here reopens Amendments #1-#5's
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

d(
  "B05 Finding 2: recipient-domain commercial-target identity survives a contact-person change at the SAME domain",
  () => {
    it("required tests A/B: Jane Smith -> John Brown at the SAME domain reconciles onto the SAME target fact, and the creator's confirmation of it survives unchanged", async () => {
      const { userId, mailAccountId } = await connectedMailbox(client, "b05-a6-f2-contact-change");
      const deps = outreachDeps(client);
      const providerMessageId = randomProviderId("msg");
      const providerThreadId = randomProviderId("thread");

      const { normalizedThreadId } = await insertNormalizedThread(client, {
        userId,
        mailAccountId,
        providerMessageId,
        providerThreadId,
        internalDateMs: 1_700_000_000_000,
        toRecipients: ["Jane Smith <marketing@a6-contact-change.example>"],
        bodyText: "I'd love to collaborate on a UGC partnership.",
      });

      const outcome1 = await interpretOneThread(deps, {
        userId,
        mailAccountId,
        normalizedThreadId,
      });
      expect(outcome1.result).toBe("ok");

      const before = await targetObservationsOf(client, normalizedThreadId);
      expect(before).toHaveLength(1);
      expect(before[0]!.observed_name).toBeNull();
      const observationId = before[0]!.id;

      const confirm = await recordCreatorDecisionAs(client, userId, deps, {
        mailAccountId,
        normalizedThreadId,
        axis: "target",
        targetAction: "confirm",
        targetObservationId: observationId,
      });
      expect(confirm.result).toBe("ok");

      // A real B04 rebuild: the SAME message, SAME domain, but the contact
      // PERSON changes — Jane Smith left, John Brown is now the contact.
      await rebuildBody({
        userId,
        mailAccountId,
        providerMessageId,
        providerThreadId,
        to: "John Brown <marketing@a6-contact-change.example>",
        body: "I'd love to collaborate on a UGC partnership.",
        internalDateMs: 1_700_000_001_000,
      });

      const outcome2 = await interpretOneThread(deps, {
        userId,
        mailAccountId,
        normalizedThreadId,
        staleness: { sourceStale: true, matcherStale: false, catalogStale: false },
      });
      expect(outcome2.result).toBe("ok");

      const after = await targetObservationsOf(client, normalizedThreadId);
      // SAME fact — never forked merely because the contact person changed.
      expect(after).toHaveLength(1);
      expect(after[0]!.id).toBe(observationId);
      expect(after[0]!.observed_name).toBeNull();

      const confirmations = await confirmedTargetsOf(client, normalizedThreadId);
      const confirmation = confirmations.find((c) => c.target_observation_id === observationId);
      expect(confirmation!.is_confirmed).toBe(true);
    });
  },
);

d("B05 Finding 3: explicit machine current-membership for target observations", () => {
  it("required test 3: a pure B04 row-id rebuild with identical semantic evidence leaves the SAME observation machine_is_current=true", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-a6-f3-pure-rebuild");
    const deps = outreachDeps(client);
    const providerMessageId = randomProviderId("msg");
    const providerThreadId = randomProviderId("thread");
    const to = "marketing@a6-pure-rebuild.example";
    const body = "I'd love to collaborate on a UGC partnership.";

    const { normalizedThreadId } = await insertNormalizedThread(client, {
      userId,
      mailAccountId,
      providerMessageId,
      providerThreadId,
      internalDateMs: 1_700_000_000_000,
      toRecipients: [to],
      bodyText: body,
    });
    await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    const before = await targetObservationsOf(client, normalizedThreadId);
    expect(before).toHaveLength(1);
    expect(before[0]!.machine_is_current).toBe(true);
    const observationId = before[0]!.id;

    await rebuildBody({
      userId,
      mailAccountId,
      providerMessageId,
      providerThreadId,
      to,
      body,
      internalDateMs: 1_700_000_001_000,
    });
    await interpretOneThread(deps, {
      userId,
      mailAccountId,
      normalizedThreadId,
      staleness: { sourceStale: true, matcherStale: false, catalogStale: false },
    });

    const after = await targetObservationsOf(client, normalizedThreadId);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(observationId);
    expect(after[0]!.machine_is_current).toBe(true);
  });

  it("required test 4: a matcher/catalog-only refresh with unchanged source membership never incorrectly marks the observation stale", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-a6-f3-catalog-refresh");
    const deps = outreachDeps(client);
    const providerMessageId = randomProviderId("msg");
    const providerThreadId = randomProviderId("thread");

    const { normalizedThreadId } = await insertNormalizedThread(client, {
      userId,
      mailAccountId,
      providerMessageId,
      providerThreadId,
      internalDateMs: 1_700_000_000_000,
      toRecipients: ["marketing@a6-catalog-refresh.example"],
      bodyText: "I'd love to collaborate on a UGC partnership.",
    });
    await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    const before = await targetObservationsOf(client, normalizedThreadId);
    expect(before).toHaveLength(1);
    const observationId = before[0]!.id;

    // The catalog moves (an UNRELATED hotel is added elsewhere), bumping
    // the catalog epoch — but nothing about THIS thread's source evidence
    // changed at all.
    await insertHotel(client, { name: "A6 Unrelated Catalog Bump Hotel" });

    await interpretOneThread(deps, {
      userId,
      mailAccountId,
      normalizedThreadId,
      staleness: { sourceStale: false, matcherStale: false, catalogStale: true },
    });

    const after = await targetObservationsOf(client, normalizedThreadId);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(observationId);
    expect(after[0]!.machine_is_current).toBe(true);
  });

  it("required test 5: a historical observation that genuinely reappears in current evidence becomes machine_is_current=true again, without fabricating a human decision", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-a6-f3-reappear");
    const deps = outreachDeps(client);
    const providerMessageId = randomProviderId("msg");
    const providerThreadId = randomProviderId("thread");
    await insertHotel(client, { name: "A6 Reappear Hotel" });
    const withHotel = "I'd love to collaborate with A6 Reappear Hotel on a partnership.";
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
    expect(v1).toHaveLength(1);
    expect(v1[0]!.machine_is_current).toBe(true);
    const observationId = v1[0]!.id;

    // The business is removed from the text — the fact becomes historical.
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
    const v2 = await targetObservationsOf(client, normalizedThreadId);
    expect(v2).toHaveLength(1);
    expect(v2[0]!.id).toBe(observationId);
    expect(v2[0]!.machine_is_current).toBe(false);
    expect(await confirmedTargetsOf(client, normalizedThreadId)).toHaveLength(0);

    // The business genuinely comes back.
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
    const v3 = await targetObservationsOf(client, normalizedThreadId);
    expect(v3).toHaveLength(1);
    expect(v3[0]!.id).toBe(observationId); // the SAME durable fact, reactivated
    expect(v3[0]!.machine_is_current).toBe(true);
    // Still never a fabricated human decision.
    expect(await confirmedTargetsOf(client, normalizedThreadId)).toHaveLength(0);
  });

  it("required tests 6/7/8: two current authored targets are both machine_is_current, and a query for the CURRENT set never conflates a historical fact with a current one", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-a6-f3-two-current");
    const deps = outreachDeps(client);
    await insertHotel(client, { name: "A6 Current Hotel Alpha" });
    await insertHotel(client, { name: "A6 Current Hotel Beta" });

    const { normalizedThreadId } = await insertNormalizedThread(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      toRecipients: ["someone@gmail.com"],
      bodyText:
        "I'd love to collaborate with A6 Current Hotel Alpha and A6 Current Hotel Beta on a partnership.",
    });
    await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });

    const observations = await targetObservationsOf(client, normalizedThreadId);
    expect(observations).toHaveLength(2);
    expect(observations.every((o) => o.machine_is_current === true)).toBe(true);

    // A read scoped to the CURRENT set alone (exactly what a review surface
    // would query) sees both, and only those.
    const currentOnly = await client.query(
      "select observed_name from private.gmail_outreach_target_observations where normalized_thread_id = $1 and machine_is_current = true order by observed_name",
      [normalizedThreadId],
    );
    expect(currentOnly.rows.map((r) => r.observed_name)).toEqual([
      "A6 Current Hotel Alpha",
      "A6 Current Hotel Beta",
    ]);
  });
});

d(
  "B05 Finding 4: authored-target identity normalization parity with canonical exact-matching",
  () => {
    it("a B04 rebuild that reproduces the SAME business under a punctuation-only variant name ('Acme-Hotel' -> 'Acme Hotel') reconciles onto the SAME private fact, and the human confirmation survives", async () => {
      const { userId, mailAccountId } = await connectedMailbox(client, "b05-a6-f4-normalization");
      const deps = outreachDeps(client);
      const providerMessageId = randomProviderId("msg");
      const providerThreadId = randomProviderId("thread");
      await insertHotel(client, { name: "Acme-Hotel" });

      const { normalizedThreadId } = await insertNormalizedThread(client, {
        userId,
        mailAccountId,
        providerMessageId,
        providerThreadId,
        internalDateMs: 1_700_000_000_000,
        toRecipients: ["someone@gmail.com"],
        bodyText: "I'd love to collaborate with Acme-Hotel on a partnership.",
      });
      await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
      const before = await targetObservationsOf(client, normalizedThreadId);
      expect(before).toHaveLength(1);
      const observationId = before[0]!.id;

      await recordCreatorDecisionAs(client, userId, deps, {
        mailAccountId,
        normalizedThreadId,
        axis: "target",
        targetAction: "confirm",
        targetObservationId: observationId,
      });

      await rebuildBody({
        userId,
        mailAccountId,
        providerMessageId,
        providerThreadId,
        to: "someone@gmail.com",
        body: "I'd love to collaborate with Acme Hotel on a partnership.",
        internalDateMs: 1_700_000_001_000,
      });
      await interpretOneThread(deps, {
        userId,
        mailAccountId,
        normalizedThreadId,
        staleness: { sourceStale: true, matcherStale: false, catalogStale: false },
      });

      const after = await targetObservationsOf(client, normalizedThreadId);
      expect(after).toHaveLength(1); // never a duplicate historical fact
      expect(after[0]!.id).toBe(observationId);

      const confirmations = await confirmedTargetsOf(client, normalizedThreadId);
      const confirmation = confirmations.find((c) => c.target_observation_id === observationId);
      expect(confirmation!.is_confirmed).toBe(true);
    });
  },
);
