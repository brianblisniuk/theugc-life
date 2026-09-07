import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { getThreadEvidence, interpretOneThread } from "@/lib/gmail/outreach/service";
import {
  canonicalLinksOf,
  confirmedTargetsOf,
  connectedMailbox,
  decisionEventsOf,
  insertHotel,
  insertNormalizedThread,
  outreachDeps,
  randomProviderId,
  recordCreatorDecisionAs,
  targetObservationsOf,
} from "./harness";

/**
 * B05 EXTERNAL AUDIT AMENDMENT #8 — direct real-Postgres proofs that
 * coordinated-name segmentation is now SOURCE-ONLY: a catalog-only mutation
 * (adding, later removing, a canonical row that happens to collide with a
 * lexical fragment of an ambiguous "&"-joined authored name) may only ever
 * change canonical-link resolution metadata, NEVER the shape/identity/
 * current-membership of the underlying private target-observation fact
 * itself (D070 §8). Finding 2 (safe source-only "and"/"&" segmentation) and
 * the property-style catalog-independence proof are covered at the unit
 * level in unit.test.ts — they need no database. D070 remains ACCEPTED;
 * nothing here reopens Amendments #1-#7's already-passed findings.
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
  "B05 Finding 1: catalog-only mutations never change a source-derived private observation's identity or currentness",
  () => {
    it("required tests B/C: adding, then removing, a canonical row that collides with a fragment of an ambiguous '&'-joined authored name changes ONLY canonical-link resolution — never the private observation's id, fingerprint, or machine_is_current", async () => {
      const { userId, mailAccountId } = await connectedMailbox(
        client,
        "b05-a8-f1-catalog-stability",
      );
      const deps = outreachDeps(client);

      const { normalizedThreadId } = await insertNormalizedThread(client, {
        userId,
        mailAccountId,
        providerMessageId: randomProviderId("msg"),
        providerThreadId: randomProviderId("thread"),
        toRecipients: ["someone@gmail.com"],
        bodyText: "I'd love to collaborate with A8 Smith & Jones on UGC.",
      });

      const initial = await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
      expect(initial.result).toBe("ok");

      const v1 = await targetObservationsOf(client, normalizedThreadId);
      expect(v1).toHaveLength(1); // never fragmented into two observations
      expect(v1[0]!.observed_name).toBe("A8 Smith & Jones");
      expect(v1[0]!.machine_canonical_link_assessment).toBe("insufficient_evidence");
      expect(v1[0]!.machine_is_current).toBe(true);
      const observationId = v1[0]!.id;
      const observationFingerprint = v1[0]!.observation_fingerprint;

      const confirm = await recordCreatorDecisionAs(client, userId, deps, {
        mailAccountId,
        normalizedThreadId,
        axis: "target",
        targetAction: "confirm",
        targetObservationId: observationId,
      });
      expect(confirm.result).toBe("ok");
      const eventsAfterConfirm = await decisionEventsOf(client, normalizedThreadId);

      // A canonical row is added that would have COLLIDED with a fragment
      // ("Jones") under the pre-Amendment-8 catalog-aware segmentation.
      await insertHotel(client, { name: "A8 Jones" });

      await interpretOneThread(deps, {
        userId,
        mailAccountId,
        normalizedThreadId,
        staleness: { sourceStale: false, matcherStale: false, catalogStale: true },
      });

      const v2 = await targetObservationsOf(client, normalizedThreadId);
      expect(v2).toHaveLength(1); // still exactly one — no new "A8 Jones" split fact
      expect(v2[0]!.id).toBe(observationId);
      expect(v2[0]!.observation_fingerprint).toBe(observationFingerprint);
      expect(v2[0]!.observed_name).toBe("A8 Smith & Jones");
      expect(v2[0]!.machine_is_current).toBe(true);
      // The colliding fragment does not resolve the fact either — it is not
      // an exact match for "A8 Smith & Jones".
      expect(v2[0]!.machine_canonical_link_assessment).toBe("insufficient_evidence");
      expect(await canonicalLinksOf(client, observationId)).toHaveLength(0);

      // NOW a canonical row matching the FULL authored name is added.
      const fullMatchHotelId = await insertHotel(client, { name: "A8 Smith & Jones" });

      await interpretOneThread(deps, {
        userId,
        mailAccountId,
        normalizedThreadId,
        staleness: { sourceStale: false, matcherStale: false, catalogStale: true },
      });

      const v3 = await targetObservationsOf(client, normalizedThreadId);
      expect(v3).toHaveLength(1); // SAME single durable fact throughout
      expect(v3[0]!.id).toBe(observationId);
      expect(v3[0]!.observation_fingerprint).toBe(observationFingerprint);
      expect(v3[0]!.machine_is_current).toBe(true);
      expect(v3[0]!.machine_canonical_link_assessment).toBe("strong_match");
      const linksAfterMatch = await canonicalLinksOf(client, observationId);
      expect(linksAfterMatch).toHaveLength(1);
      expect(linksAfterMatch[0]!.target_hotel_id).toBe(fullMatchHotelId);

      // No human decision event was fabricated by any of the catalog-only
      // re-evaluations above.
      expect(await decisionEventsOf(client, normalizedThreadId)).toEqual(eventsAfterConfirm);
      const confirmations = await confirmedTargetsOf(client, normalizedThreadId);
      expect(
        confirmations.find((c) => c.target_observation_id === observationId)!.is_confirmed,
      ).toBe(true);

      // required test C: removing the matching canonical row again leaves the
      // SAME private observation current — only the link disappears.
      await client.query("delete from public.hotels where id = $1", [fullMatchHotelId]);

      await interpretOneThread(deps, {
        userId,
        mailAccountId,
        normalizedThreadId,
        staleness: { sourceStale: false, matcherStale: false, catalogStale: true },
      });

      const v4 = await targetObservationsOf(client, normalizedThreadId);
      expect(v4).toHaveLength(1);
      expect(v4[0]!.id).toBe(observationId);
      expect(v4[0]!.observation_fingerprint).toBe(observationFingerprint);
      expect(v4[0]!.machine_is_current).toBe(true);
      expect(v4[0]!.machine_canonical_link_assessment).toBe("insufficient_evidence");
      expect(await canonicalLinksOf(client, observationId)).toHaveLength(0);

      // The real production read surface (Amendment #7's current-only filter)
      // still returns exactly this one fact throughout.
      const evidence = await getThreadEvidence(deps, { userId, mailAccountId, normalizedThreadId });
      if (evidence.result !== "ok") throw new Error("unreachable");
      expect(evidence.machineState.targetObservations).toHaveLength(1);
      expect(evidence.machineState.targetObservations[0]!.observationFingerprint).toBe(
        observationFingerprint,
      );
    });
  },
);
