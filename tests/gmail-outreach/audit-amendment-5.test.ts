import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { interpretOneThread } from "@/lib/gmail/outreach/service";
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
  targetScopeSignalRow,
  threadSignalRow,
} from "./harness";

/**
 * B05 EXTERNAL AUDIT AMENDMENT #5 — direct proofs for Finding 1 (independent
 * authored-text target observations) and its interaction with target-scope
 * and human confirmation. D070 remains ACCEPTED; nothing here reopens
 * Amendments #1-#4's already-passed findings. Findings 2/3 (differs-vs-
 * unavailable, target-directed context) are covered at the unit level in
 * unit.test.ts — they need no real-Postgres fixture. Finding 4 (the real
 * final-interpretation evaluation) lives in evaluation/harness.test.ts.
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

d(
  "B05 Finding 1, required case B: freemail + target-directed exact canonical match persists an independent private observation",
  () => {
    it("a freemail recipient with authored text naming a real business in a target-directed context both qualifies AND persists a corresponding private observation", async () => {
      const { userId, mailAccountId } = await connectedMailbox(client, "b05-a5-f1-freemail");
      const deps = outreachDeps(client);
      const hotelId = await insertHotel(client, { name: "A5 Freemail Target Hotel" });

      const { normalizedThreadId } = await insertNormalizedThread(client, {
        userId,
        mailAccountId,
        providerMessageId: randomProviderId("msg"),
        providerThreadId: randomProviderId("thread"),
        toRecipients: ["someone@gmail.com"],
        bodyText: "I'd love to collaborate with A5 Freemail Target Hotel on a paid partnership.",
      });

      const outcome = await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
      expect(outcome.result).toBe("ok");
      const signal = await threadSignalRow(client, normalizedThreadId);
      expect(signal.outreach_status).toBe("qualified_outreach");
      expect(signal.reason_codes).toContain("commercial_target_evidence_present");

      // Freemail excludes any recipient_domain observation entirely — the
      // ONLY observation here must be the independent authored-text one, and
      // it must genuinely exist (never qualified_outreach with zero
      // corresponding private fact).
      const observations = await targetObservationsOf(client, normalizedThreadId);
      expect(observations).toHaveLength(1);
      expect(observations[0].observation_source_kind).toBe("authored_text_name");
      expect(observations[0].observed_domain).toBeNull();

      const links = await canonicalLinksOf(client, observations[0].id);
      expect(links).toHaveLength(1);
      expect(links[0].target_hotel_id).toBe(hotelId);
      expect(links[0].authored_text_evidence).toBe("agrees");
    });
  },
);

d(
  "B05 Finding 1/3: a generic, non-target-directed canonical mention can never satisfy D070 §5's requirement C",
  () => {
    it("proposal language plus a purely historical business mention (freemail recipient) stays needs_review — no target observation is fabricated from the historical mention", async () => {
      const { userId, mailAccountId } = await connectedMailbox(client, "b05-a5-f3-historical");
      const deps = outreachDeps(client);
      await insertHotel(client, { name: "A5 Historical Only Hotel" });

      const { normalizedThreadId } = await insertNormalizedThread(client, {
        userId,
        mailAccountId,
        providerMessageId: randomProviderId("msg"),
        providerThreadId: randomProviderId("thread"),
        toRecipients: ["someone@gmail.com"],
        bodyText:
          "I'd love to collaborate on a paid partnership. I worked with A5 Historical Only Hotel last year on a similar campaign.",
      });

      const outcome = await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
      expect(outcome.result).toBe("ok");
      const signal = await threadSignalRow(client, normalizedThreadId);
      expect(signal.outreach_status).toBe("needs_review");
      expect(signal.reason_codes).toContain("creator_commercial_proposal_language_detected");
      expect(signal.reason_codes).not.toContain("commercial_target_evidence_present");

      const observations = await targetObservationsOf(client, normalizedThreadId);
      expect(observations).toHaveLength(0);
    });
  },
);

d(
  "B05 Finding 1: authored observation provenance identifies the EXACT provider message(s), and unions across multiple SENT messages naming the same target",
  () => {
    it("the same target named in two separate SENT messages unions provenance onto the SAME durable observation, never a duplicate", async () => {
      const { userId, mailAccountId } = await connectedMailbox(client, "b05-a5-f1-provenance");
      const deps = outreachDeps(client);
      await insertHotel(client, { name: "A5 Union Provenance Hotel" });
      const providerThreadId = randomProviderId("thread");
      const msg1 = randomProviderId("msg");

      const { normalizedThreadId } = await insertNormalizedThread(client, {
        userId,
        mailAccountId,
        providerMessageId: msg1,
        providerThreadId,
        toRecipients: ["someone@gmail.com"],
        bodyText: "I'd love to collaborate with A5 Union Provenance Hotel on a paid partnership.",
      });

      await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
      const firstPass = await targetObservationsOf(client, normalizedThreadId);
      expect(firstPass).toHaveLength(1);
      expect(firstPass[0].source_provider_message_ids).toEqual([msg1]);
      const observationId = firstPass[0].id;

      // A SECOND real SENT message, same thread, naming the SAME business again.
      const msg2 = randomProviderId("msg");
      await insertNormalizedThread(client, {
        userId,
        mailAccountId,
        providerMessageId: msg2,
        providerThreadId,
        internalDateMs: Date.now() + 1000,
        toRecipients: ["someone@gmail.com"],
        bodyText: "Just following up — still hoping to collaborate with A5 Union Provenance Hotel.",
      });

      const reoutcome = await interpretOneThread(deps, {
        userId,
        mailAccountId,
        normalizedThreadId,
        staleness: { sourceStale: true, matcherStale: false, catalogStale: false },
      });
      expect(reoutcome.result).toBe("ok");

      const secondPass = await targetObservationsOf(client, normalizedThreadId);
      // SAME durable observation (same id, same fingerprint), never a duplicate.
      expect(secondPass).toHaveLength(1);
      expect(secondPass[0].id).toBe(observationId);
      expect(new Set(secondPass[0].source_provider_message_ids)).toEqual(new Set([msg1, msg2]));
    });
  },
);

d(
  "B05 Finding 1, required cases E/F/G: authored-target identity survives a B04 rebuild with unchanged evidence, and forks on materially changed evidence — human confirmation never rewritten",
  () => {
    it("a B04 rebuild that reproduces the SAME authored target text preserves the SAME observation id and its existing confirmation", async () => {
      const { userId, mailAccountId } = await connectedMailbox(client, "b05-a5-f1-rebuild-same");
      const deps = outreachDeps(client);
      await insertHotel(client, { name: "A5 Rebuild Stable Hotel" });
      const providerMessageId = randomProviderId("msg");
      const providerThreadId = randomProviderId("thread");
      const bodyText =
        "I'd love to collaborate with A5 Rebuild Stable Hotel on a paid partnership.";

      const { normalizedThreadId } = await insertNormalizedThread(client, {
        userId,
        mailAccountId,
        providerMessageId,
        providerThreadId,
        toRecipients: ["someone@gmail.com"],
        bodyText,
      });

      await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
      const before = await targetObservationsOf(client, normalizedThreadId);
      expect(before).toHaveLength(1);
      const observationId = before[0].id;

      await recordCreatorDecisionAs(client, userId, deps, {
        mailAccountId,
        normalizedThreadId,
        axis: "target",
        targetAction: "confirm",
        targetObservationId: observationId,
      });

      // A real B04 rebuild (raw-payload correction + renormalize) with the
      // EXACT SAME sanitized content — 0038's replaceable-projection design
      // means this creates a NEW normalized message row under the hood, but
      // the authored evidence itself is unchanged.
      const rebuildDeps = {
        db: createRpcClient(client) as unknown as Parameters<typeof normalizeOneCandidate>[0]["db"],
      };
      const sanitized = {
        provider_message_id: providerMessageId,
        provider_thread_id: providerThreadId,
        internal_date_ms: Date.now(),
        label_ids: ["SENT"],
        provider_history_id: null,
        size_estimate: null,
        message_headers: [
          { name: "subject", value: "hello" },
          { name: "to", value: "someone@gmail.com" },
        ],
        payload: {
          mimeType: "text/plain",
          body: {
            size: bodyText.length,
            data: Buffer.from(bodyText, "utf8").toString("base64url"),
          },
        },
      };
      const { payloadSha256 } = await updateRawMessage(client, {
        mailAccountId,
        providerMessageId,
        sanitized,
      });
      const rebuildOutcome = await normalizeOneCandidate(rebuildDeps, userId, {
        mail_account_id: mailAccountId,
        provider_message_id: providerMessageId,
        provider_thread_id: providerThreadId,
        internal_date_ms: sanitized.internal_date_ms,
        label_ids: sanitized.label_ids,
        sanitized_payload: sanitized,
        payload_sha256: payloadSha256,
      });
      expect(rebuildOutcome.result).toBe("ok");

      await interpretOneThread(deps, {
        userId,
        mailAccountId,
        normalizedThreadId,
        staleness: { sourceStale: true, matcherStale: false, catalogStale: false },
      });

      const after = await targetObservationsOf(client, normalizedThreadId);
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(observationId);
      const confirmations = await confirmedTargetsOf(client, normalizedThreadId);
      const confirmation = confirmations.find((c) => c.target_observation_id === observationId);
      expect(confirmation!.is_confirmed).toBe(true);
    });

    it("a materially changed authored target across a B04 rebuild forks a NEW observation — the old one and its confirmation are never rewritten", async () => {
      const { userId, mailAccountId } = await connectedMailbox(client, "b05-a5-f1-rebuild-fork");
      const deps = outreachDeps(client);
      await insertHotel(client, { name: "A5 Fork Hotel Original" });
      await insertHotel(client, { name: "A5 Fork Hotel Replacement" });
      const providerMessageId = randomProviderId("msg");
      const providerThreadId = randomProviderId("thread");

      const { normalizedThreadId } = await insertNormalizedThread(client, {
        userId,
        mailAccountId,
        providerMessageId,
        providerThreadId,
        toRecipients: ["someone@gmail.com"],
        bodyText: "I'd love to collaborate with A5 Fork Hotel Original on a paid partnership.",
      });

      await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
      const before = await targetObservationsOf(client, normalizedThreadId);
      expect(before).toHaveLength(1);
      const originalObservationId = before[0].id;

      await recordCreatorDecisionAs(client, userId, deps, {
        mailAccountId,
        normalizedThreadId,
        axis: "target",
        targetAction: "confirm",
        targetObservationId: originalObservationId,
      });

      const newBodyText =
        "Actually, I'd love to collaborate with A5 Fork Hotel Replacement instead.";
      const rebuildDeps = {
        db: createRpcClient(client) as unknown as Parameters<typeof normalizeOneCandidate>[0]["db"],
      };
      const sanitized = {
        provider_message_id: providerMessageId,
        provider_thread_id: providerThreadId,
        internal_date_ms: Date.now(),
        label_ids: ["SENT"],
        provider_history_id: null,
        size_estimate: null,
        message_headers: [
          { name: "subject", value: "hello" },
          { name: "to", value: "someone@gmail.com" },
        ],
        payload: {
          mimeType: "text/plain",
          body: {
            size: newBodyText.length,
            data: Buffer.from(newBodyText, "utf8").toString("base64url"),
          },
        },
      };
      const { payloadSha256 } = await updateRawMessage(client, {
        mailAccountId,
        providerMessageId,
        sanitized,
      });
      await normalizeOneCandidate(rebuildDeps, userId, {
        mail_account_id: mailAccountId,
        provider_message_id: providerMessageId,
        provider_thread_id: providerThreadId,
        internal_date_ms: sanitized.internal_date_ms,
        label_ids: sanitized.label_ids,
        sanitized_payload: sanitized,
        payload_sha256: payloadSha256,
      });

      await interpretOneThread(deps, {
        userId,
        mailAccountId,
        normalizedThreadId,
        staleness: { sourceStale: true, matcherStale: false, catalogStale: false },
      });

      const after = await targetObservationsOf(client, normalizedThreadId);
      // The OLD observation is still present (never deleted or rewritten), PLUS
      // a NEW independent observation for the materially different target.
      expect(after.map((o) => o.id)).toContain(originalObservationId);
      expect(after).toHaveLength(2);

      const confirmations = await confirmedTargetsOf(client, normalizedThreadId);
      const originalConfirmation = confirmations.find(
        (c) => c.target_observation_id === originalObservationId,
      );
      expect(originalConfirmation!.is_confirmed).toBe(true);

      const newObservation = after.find((o) => o.id !== originalObservationId)!;
      expect(newObservation.observed_name).toBe("A5 Fork Hotel Replacement");
      const newConfirmation = confirmations.find(
        (c) => c.target_observation_id === newObservation.id,
      );
      expect(newConfirmation).toBeUndefined();
    });
  },
);

d(
  "B05 Finding 1, required case: the target-scope layer sees TWO independently-established authored targets, never one observation with two canonical candidates",
  () => {
    it("two real authored targets named in one message (no scope language, freemail recipient) yields multiple_targets from TWO independent observations", async () => {
      const { userId, mailAccountId } = await connectedMailbox(client, "b05-a5-f1-scope-multi");
      const deps = outreachDeps(client);
      await insertHotel(client, { name: "A5 Scope Hotel Alpha" });
      await insertHotel(client, { name: "A5 Scope Hotel Beta" });

      const { normalizedThreadId } = await insertNormalizedThread(client, {
        userId,
        mailAccountId,
        providerMessageId: randomProviderId("msg"),
        providerThreadId: randomProviderId("thread"),
        toRecipients: ["someone@gmail.com"],
        bodyText:
          "I'd love to collaborate with A5 Scope Hotel Alpha and also collaborate with A5 Scope Hotel Beta on a paid partnership.",
      });

      await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });

      const observations = await targetObservationsOf(client, normalizedThreadId);
      expect(observations).toHaveLength(2);
      expect(observations.every((o) => o.observation_source_kind === "authored_text_name")).toBe(
        true,
      );

      const scopeSignal = await targetScopeSignalRow(client, normalizedThreadId);
      expect(scopeSignal.machine_target_scope).toBe("multiple_targets");
    });
  },
);

d(
  "B05 Finding 1, required case: confirming one and rejecting the other authored target are two INDEPENDENT human decisions",
  () => {
    it("an agency recipient plus two real authored targets can be independently confirmed and removed without affecting each other", async () => {
      const { userId, mailAccountId } = await connectedMailbox(
        client,
        "b05-a5-f1-independent-decisions",
      );
      const deps = outreachDeps(client);
      const hotelAId = await insertHotel(client, { name: "A5 Independent Hotel Alpha" });
      const hotelBId = await insertHotel(client, { name: "A5 Independent Hotel Beta" });

      const { normalizedThreadId } = await insertNormalizedThread(client, {
        userId,
        mailAccountId,
        providerMessageId: randomProviderId("msg"),
        providerThreadId: randomProviderId("thread"),
        toRecipients: ["contact@a5-independent-agency.example"],
        bodyText:
          "I'd love to collaborate with A5 Independent Hotel Alpha and also collaborate with A5 Independent Hotel Beta on a paid partnership.",
      });

      await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });

      const observations = await targetObservationsOf(client, normalizedThreadId);
      const authoredObservations = observations.filter(
        (o) => o.observation_source_kind === "authored_text_name",
      );
      expect(authoredObservations).toHaveLength(2);

      const findByHotel = async (hotelId: string) => {
        for (const obs of authoredObservations) {
          const links = await canonicalLinksOf(client, obs.id);
          if (links.some((l) => l.target_hotel_id === hotelId)) return obs;
        }
        throw new Error(`no observation found for hotel ${hotelId}`);
      };
      const alphaObservation = await findByHotel(hotelAId);
      const betaObservation = await findByHotel(hotelBId);

      await recordCreatorDecisionAs(client, userId, deps, {
        mailAccountId,
        normalizedThreadId,
        axis: "target",
        targetAction: "confirm",
        targetObservationId: alphaObservation.id,
      });
      await recordCreatorDecisionAs(client, userId, deps, {
        mailAccountId,
        normalizedThreadId,
        axis: "target",
        targetAction: "remove",
        targetObservationId: betaObservation.id,
      });

      const confirmations = await confirmedTargetsOf(client, normalizedThreadId);
      const alphaConfirmation = confirmations.find(
        (c) => c.target_observation_id === alphaObservation.id,
      );
      const betaConfirmation = confirmations.find(
        (c) => c.target_observation_id === betaObservation.id,
      );
      expect(alphaConfirmation!.is_confirmed).toBe(true);
      expect(betaConfirmation!.is_confirmed).toBe(false);
    });
  },
);
