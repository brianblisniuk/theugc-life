import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  getCurrentCatalogEpoch,
  getOutreachStatus,
  getThreadEvidence,
  interpretOneThread,
  recordCreatorDecision,
} from "@/lib/gmail/outreach/service";
import { setConnectionState, startDeletion } from "../gmail-import/harness";
import {
  confirmedTargetsOf,
  connectedMailbox,
  creatorDecisionRow,
  decisionEventsOf,
  insertNormalizedThread,
  observedRecipientsOf,
  outreachDeps,
  randomFingerprint,
  randomProviderId,
  recordCreatorDecisionAs,
  targetObservationsOf,
  threadSignalRow,
} from "./harness";

/**
 * B05 DIRECT DB PROOFS. Machine/human separation, the source-evidence fence,
 * catalog-epoch staleness, target-observation reconciliation and the
 * deletion/disconnect boundary all live inside 0039's own functions and
 * constraints, so a mocked database would test nothing that matters.
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

d("B05: full pipeline end-to-end", () => {
  it("interprets a qualified-outreach thread, preserves all recipients, extracts a target, and supports all four creator decision axes", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-pipeline");
    const deps = outreachDeps(client);

    const { normalizedThreadId } = await insertNormalizedThread(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      subject: "UGC collaboration opportunity",
      toRecipients: ["marketing@acmehotel.example"],
      ccRecipients: ["manager@creatoragency.example"],
      bccRecipients: ["creator.second@gmail.com"],
      bodyText: "Hi! I'd love to collaborate with your hotel on some paid UGC content.",
    });

    const outcome = await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    expect(outcome).toMatchObject({ result: "ok", outreachStatus: "qualified_outreach" });

    // Every to/cc/bcc recipient preserved, unfiltered — including the
    // creator's own bcc'd second address.
    const recipients = await observedRecipientsOf(client, normalizedThreadId);
    expect(recipients).toHaveLength(3);
    expect(recipients.map((r) => r.role).sort()).toEqual(["bcc", "cc", "to"]);

    // A private target observation exists for the non-freemail `to` domain.
    const observations = await targetObservationsOf(client, normalizedThreadId);
    expect(observations).toHaveLength(1);
    expect(observations[0]!.observed_domain).toBe("acmehotel.example");

    // Human layer: all four axes.
    const outreachDecision = await recordCreatorDecisionAs(client, userId, deps, {
      mailAccountId,
      normalizedThreadId,
      axis: "outreach",
      outreachDecision: "outreach_confirmed",
    });
    expect(outreachDecision.result).toBe("ok");

    const scopeDecision = await recordCreatorDecisionAs(client, userId, deps, {
      mailAccountId,
      normalizedThreadId,
      axis: "target_scope",
      targetScopeDecision: "single_target",
    });
    expect(scopeDecision.result).toBe("ok");

    const targetDecision = await recordCreatorDecisionAs(client, userId, deps, {
      mailAccountId,
      normalizedThreadId,
      axis: "target",
      targetAction: "confirm",
      targetObservationId: observations[0]!.id,
    });
    expect(targetDecision.result).toBe("ok");

    const toRecipient = recipients.find((r) => r.role === "to")!;
    const contactDecision = await recordCreatorDecisionAs(client, userId, deps, {
      mailAccountId,
      normalizedThreadId,
      axis: "target_contact",
      targetAction: "confirm",
      observedRecipientId: toRecipient.id,
    });
    expect(contactDecision.result).toBe("ok");

    const status = await getOutreachStatus(deps, { userId, mailAccountId });
    expect(status).toMatchObject({
      result: "ok",
      counts: {
        threadsClassified: 1,
        qualifiedOutreachThreads: 1,
        targetObservations: 1,
        confirmedTargets: 1,
        observedRecipients: 3,
        confirmedTargetContacts: 1,
      },
    });
  });

  it("Finding 7: a not_outreach thread STILL preserves observed recipients and target observations — OBSERVED is literal evidence, never gated on the machine's own classification", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-not-outreach");
    const deps = outreachDeps(client);

    const { normalizedThreadId } = await insertNormalizedThread(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      toRecipients: ["reservations@somehotel.example"],
      bodyText: "I would like a reservation for two nights, check-in Friday check-out Sunday.",
    });

    const outcome = await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    expect(outcome).toMatchObject({ result: "ok", outreachStatus: "not_outreach" });

    // A false negative from the machine classifier must never permanently
    // block a later creator correction — the recipient and target-candidate
    // data a correction would need to act on already exists.
    expect(await observedRecipientsOf(client, normalizedThreadId)).toHaveLength(1);
    expect(await targetObservationsOf(client, normalizedThreadId)).toHaveLength(1);

    // The creator can still correct the outreach axis afterward, with real
    // observed data already in place to act on.
    const correction = await recordCreatorDecisionAs(client, userId, deps, {
      mailAccountId,
      normalizedThreadId,
      axis: "outreach",
      outreachDecision: "outreach_confirmed",
    });
    expect(correction.result).toBe("ok");
  });
});

d("B05: machine vs human — machine never overwrites a creator decision", () => {
  it("a later re-interpretation with a DIFFERENT machine result leaves the creator's confirmation unchanged", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-machine-human");
    const deps = outreachDeps(client);

    const { normalizedThreadId } = await insertNormalizedThread(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      toRecipients: ["marketing@acmehotel.example"],
      bodyText: "I'd love to collaborate on a paid partnership with your hotel.",
    });

    await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    await recordCreatorDecisionAs(client, userId, deps, {
      mailAccountId,
      normalizedThreadId,
      axis: "outreach",
      outreachDecision: "outreach_confirmed",
    });

    // Force a DIFFERENT machine result directly (simulating a future detector
    // version disagreeing) — never through the creator-decision path.
    const evidence = await getThreadEvidence(deps, { userId, mailAccountId, normalizedThreadId });
    if (evidence.result !== "ok") throw new Error("evidence not found");
    const currentEpoch = await getCurrentCatalogEpoch(deps);

    await deps.db.rpc("gmail_outreach_commit_interpretation", {
      p_user_id: userId,
      p_mail_account_id: mailAccountId,
      p_normalized_thread_id: normalizedThreadId,
      p_detector_version: "gmail_outreach_rules_v2_hypothetical",
      p_matcher_version: "gmail_outreach_match_rules_v1",
      p_expected_evidence_digest: evidence.evidenceDigest,
      p_outreach_status: "not_outreach",
      p_reason_codes: ["hypothetical_v2_disagrees"],
      p_recipient_participant_ids: [],
      p_target_contact_match_quality: "insufficient_evidence",
      p_target_contact_candidate_set_fingerprint: "0".repeat(64),
      p_target_contact_candidates: [],
      p_target_observations: [],
      p_target_canonical_links: [],
      p_machine_target_scope: "unresolved",
      p_target_scope_reason_codes: [],
      p_catalog_epoch: currentEpoch,
    });

    const machineSignal = await threadSignalRow(client, normalizedThreadId);
    expect(machineSignal.outreach_status).toBe("not_outreach"); // machine changed...

    const humanDecision = await creatorDecisionRow(client, normalizedThreadId);
    expect(humanDecision.outreach_decision).toBe("outreach_confirmed"); // ...human did not.
  });
});

d("B05: source-evidence fence", () => {
  it("refuses a commit with a stale evidence digest, and touches nothing", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-fence");
    const deps = outreachDeps(client);

    const { normalizedThreadId } = await insertNormalizedThread(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      bodyText: "hello",
    });

    const { data } = await deps.db.rpc("gmail_outreach_commit_interpretation", {
      p_user_id: userId,
      p_mail_account_id: mailAccountId,
      p_normalized_thread_id: normalizedThreadId,
      p_detector_version: "gmail_outreach_rules_v1",
      p_matcher_version: "gmail_outreach_match_rules_v1",
      p_expected_evidence_digest: "0".repeat(64), // deliberately wrong
      p_outreach_status: "qualified_outreach",
      p_reason_codes: [],
      p_recipient_participant_ids: [],
      p_target_contact_match_quality: "insufficient_evidence",
      p_target_contact_candidate_set_fingerprint: "0".repeat(64),
      p_target_contact_candidates: [],
      p_target_observations: [],
      p_target_canonical_links: [],
      p_machine_target_scope: "unresolved",
      p_target_scope_reason_codes: [],
      p_catalog_epoch: 1,
    });

    expect((data as { result: string }).result).toBe("stale_source");
    expect(await threadSignalRow(client, normalizedThreadId)).toBeNull();
  });
});

d("B05: target observation stability (reconciliation, not replacement)", () => {
  it("re-interpreting the same thread reuses the SAME observation row and never orphans a confirmation", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-observation-stability");
    const deps = outreachDeps(client);

    const { normalizedThreadId } = await insertNormalizedThread(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      toRecipients: ["marketing@acmehotel.example"],
      bodyText: "I'd love to collaborate on a paid partnership.",
    });

    await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    const firstPass = await targetObservationsOf(client, normalizedThreadId);
    expect(firstPass).toHaveLength(1);
    const observationId = firstPass[0]!.id;

    await recordCreatorDecisionAs(client, userId, deps, {
      mailAccountId,
      normalizedThreadId,
      axis: "target",
      targetAction: "confirm",
      targetObservationId: observationId,
    });

    // Re-run the exact same interpretation (idempotent re-processing).
    await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });

    const secondPass = await targetObservationsOf(client, normalizedThreadId);
    expect(secondPass).toHaveLength(1);
    expect(secondPass[0]!.id).toBe(observationId); // SAME row, not a new one

    const confirmed = await confirmedTargetsOf(client, normalizedThreadId);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]!.target_observation_id).toBe(observationId); // never orphaned
  });
});

d("B05: canonical linkage never fabricates target identity (D028)", () => {
  it("an exact hotel_contacts email match is recorded as a link, but the target remains unconfirmed until the creator acts", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-d028");
    const deps = outreachDeps(client);

    const dest = await client.query(
      `insert into public.destinations (id, name, slug, type) values (gen_random_uuid(), 'D028 Test Dest', $1, 'city') returning id`,
      [randomProviderId("dest")],
    );
    const hotel = await client.query(
      `insert into public.hotels (name, slug, destination_id) values ('D028 Test Hotel', $1, $2) returning id`,
      [randomProviderId("hotel"), dest.rows[0].id],
    );
    // A unique-per-run address: `hotel_contacts.email` carries no unique
    // constraint (by design — duplicate/agency contacts are legitimate), so a
    // fixed literal here would collide with rows other test runs left behind
    // in this persistent test database and inflate the expected link count.
    const contactEmail = `${randomProviderId("marketing")}@d028test.example`;
    await client.query(
      `insert into public.hotel_contacts (hotel_id, email, status, source_type) values ($1, $2, 'active', 'editorial')`,
      [hotel.rows[0].id, contactEmail],
    );

    const { normalizedThreadId } = await insertNormalizedThread(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      toRecipients: [contactEmail],
      bodyText: "I'd love to collaborate on a paid UGC partnership.",
    });

    await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });

    const recipients = await observedRecipientsOf(client, normalizedThreadId);
    const link = await client.query(
      "select * from private.gmail_outreach_observed_recipient_canonical_links where observed_recipient_id = $1",
      [recipients[0]!.id],
    );
    expect(link.rows).toHaveLength(1);
    expect(link.rows[0].hotel_contact_id).toBeTruthy();

    // The link is evidence only — no confirmed target exists until the creator acts.
    expect(await confirmedTargetsOf(client, normalizedThreadId)).toHaveLength(0);

    // D028: a single agreeing evidence dimension (contact email alone — no
    // matching hotel name or website domain in this fixture) is conservatively
    // "needs_review", never an auto-resolved "strong_match" — the point being
    // proved is that even a perfect exact-email hit does not fabricate confidence.
    const observations = await targetObservationsOf(client, normalizedThreadId);
    expect(observations[0]!.machine_canonical_link_assessment).toBe("needs_review");
  });
});

d("B05: target scope is independent, never mechanically derived", () => {
  it("scope may be captured before target identity is resolved (independent capture)", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-scope-order");
    const deps = outreachDeps(client);
    const { normalizedThreadId } = await insertNormalizedThread(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      bodyText: "hello",
    });

    // Scope decided BEFORE any interpretation or target confirmation exists at all.
    const result = await recordCreatorDecisionAs(client, userId, deps, {
      mailAccountId,
      normalizedThreadId,
      axis: "target_scope",
      targetScopeDecision: "portfolio_target",
    });
    expect(result.result).toBe("ok");

    const decision = await creatorDecisionRow(client, normalizedThreadId);
    expect(decision.target_scope_decision).toBe("portfolio_target");
  });

  it("an identical single confirmed organization can independently carry EITHER single_target or portfolio_target scope (never inferred from cardinality/kind)", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-ogilvy-marriott");
    const org = await client.query(
      `insert into public.organizations (id, name, normalized_name, org_type) values (gen_random_uuid(), 'Shared Org', $1, 'pr_agency') returning id`,
      [randomProviderId("org-normalized")],
    );
    const orgId = org.rows[0].id;
    const deps = outreachDeps(client);

    // Thread A: direct-service engagement with the org itself.
    const threadA = await insertNormalizedThread(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      bodyText: "hello",
    });
    const obsA = await client.query(
      `insert into private.gmail_outreach_target_observations
         (user_id, mail_account_id, normalized_thread_id, observation_fingerprint, observed_name, target_kind_hint, source_provider_message_ids)
       values ($1, $2, $3, $4, 'Shared Org', 'organization', '{provider-msg-fixture}') returning id`,
      [userId, mailAccountId, threadA.normalizedThreadId, randomFingerprint()],
    );
    await recordCreatorDecisionAs(client, userId, deps, {
      mailAccountId,
      normalizedThreadId: threadA.normalizedThreadId,
      axis: "target",
      targetAction: "confirm",
      targetObservationId: obsA.rows[0].id,
    });
    await recordCreatorDecisionAs(client, userId, deps, {
      mailAccountId,
      normalizedThreadId: threadA.normalizedThreadId,
      axis: "target_scope",
      targetScopeDecision: "single_target",
    });

    // Thread B: portfolio-level solicitation naming the SAME organization.
    const threadB = await insertNormalizedThread(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      bodyText: "hello",
    });
    const obsB = await client.query(
      `insert into private.gmail_outreach_target_observations
         (user_id, mail_account_id, normalized_thread_id, observation_fingerprint, observed_name, target_kind_hint, source_provider_message_ids)
       values ($1, $2, $3, $4, 'Shared Org', 'organization', '{provider-msg-fixture}') returning id`,
      [userId, mailAccountId, threadB.normalizedThreadId, randomFingerprint()],
    );
    await recordCreatorDecisionAs(client, userId, deps, {
      mailAccountId,
      normalizedThreadId: threadB.normalizedThreadId,
      axis: "target",
      targetAction: "confirm",
      targetObservationId: obsB.rows[0].id,
    });
    await recordCreatorDecisionAs(client, userId, deps, {
      mailAccountId,
      normalizedThreadId: threadB.normalizedThreadId,
      axis: "target_scope",
      targetScopeDecision: "portfolio_target",
    });

    const decisionA = await creatorDecisionRow(client, threadA.normalizedThreadId);
    const decisionB = await creatorDecisionRow(client, threadB.normalizedThreadId);
    expect(decisionA.target_scope_decision).toBe("single_target");
    expect(decisionB.target_scope_decision).toBe("portfolio_target");
    // Same org, same cardinality (exactly one confirmed target each) — the
    // database imposed no rule mapping org-kind or cardinality to scope.
    expect(orgId).toBeTruthy();
  });
});

d("B05: immutable decision history — a correction is a new event, never an edit", () => {
  it("correcting outreach appends a new event; the prior event remains in the ledger unchanged", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-correction");
    const deps = outreachDeps(client);
    const { normalizedThreadId } = await insertNormalizedThread(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      bodyText: "hello",
    });

    await recordCreatorDecisionAs(client, userId, deps, {
      mailAccountId,
      normalizedThreadId,
      axis: "outreach",
      outreachDecision: "outreach_confirmed",
    });
    await recordCreatorDecisionAs(client, userId, deps, {
      mailAccountId,
      normalizedThreadId,
      axis: "outreach",
      outreachDecision: "not_outreach_confirmed",
    });

    const events = await decisionEventsOf(client, normalizedThreadId);
    expect(events).toHaveLength(2);
    expect(events[0]!.outreach_decision).toBe("outreach_confirmed");
    expect(events[1]!.outreach_decision).toBe("not_outreach_confirmed");
    expect(Number(events[1]!.event_seq)).toBeGreaterThan(Number(events[0]!.event_seq));

    const current = await creatorDecisionRow(client, normalizedThreadId);
    expect(current.outreach_decision).toBe("not_outreach_confirmed");
    expect(current.current_outreach_event_id).toBe(events[1]!.id);
  });

  it("a machine commit never appears in the creator decision event ledger", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-no-machine-events");
    const deps = outreachDeps(client);
    const { normalizedThreadId } = await insertNormalizedThread(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      bodyText: "collaborate on a paid partnership",
    });

    await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    expect(await decisionEventsOf(client, normalizedThreadId)).toHaveLength(0);
  });
});

d("B05: retention — disconnect and churn retain history; only explicit deletion purges", () => {
  it("disconnecting a mailbox does not purge B05 state", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-disconnect");
    const deps = outreachDeps(client);
    const { normalizedThreadId } = await insertNormalizedThread(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      bodyText: "collaborate on a paid partnership",
    });
    await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });

    await setConnectionState(client, mailAccountId, "disconnected");

    expect(await threadSignalRow(client, normalizedThreadId)).not.toBeNull();
  });

  it("explicit Gmail-derived deletion purges both machine and human B05 state", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-deletion");
    const deps = outreachDeps(client);
    const { normalizedThreadId } = await insertNormalizedThread(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      bodyText: "collaborate on a paid partnership",
    });
    await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    await recordCreatorDecisionAs(client, userId, deps, {
      mailAccountId,
      normalizedThreadId,
      axis: "outreach",
      outreachDecision: "outreach_confirmed",
    });

    // Drive the mailbox through the real B01 deletion-request lifecycle.
    const requestId = await startDeletion(client, mailAccountId, userId, "gmail_derived_data");

    // Purge B05 first (before B04/B03), then B04/B03 (mirroring the real
    // orchestrator's ordering, which is out of B05's own scope to prove here).
    const purge = await deps.db.rpc("gmail_outreach_purge_for_deletion", {
      p_user_id: userId,
      p_mail_account_id: mailAccountId,
      p_deletion_request_id: requestId,
    });
    expect((purge.data as { result: string }).result).toBe("ok");

    expect(await threadSignalRow(client, normalizedThreadId)).toBeNull();
    expect(await creatorDecisionRow(client, normalizedThreadId)).toBeNull();
    expect(await decisionEventsOf(client, normalizedThreadId)).toHaveLength(0);
    expect(await observedRecipientsOf(client, normalizedThreadId)).toHaveLength(0);
  });
});

d("B05: cross-account isolation", () => {
  it("the same provider_thread_id under two different mail accounts produces fully independent B05 state", async () => {
    const accountA = await connectedMailbox(client, "b05-cross-a");
    const accountB = await connectedMailbox(client, "b05-cross-b");
    const deps = outreachDeps(client);
    const sharedProviderThreadId = randomProviderId("shared-thread");

    const threadA = await insertNormalizedThread(client, {
      userId: accountA.userId,
      mailAccountId: accountA.mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: sharedProviderThreadId,
      bodyText: "collaborate on a paid partnership",
    });
    const threadB = await insertNormalizedThread(client, {
      userId: accountB.userId,
      mailAccountId: accountB.mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: sharedProviderThreadId,
      bodyText: "this is a reservation for two nights",
    });

    expect(threadA.normalizedThreadId).not.toBe(threadB.normalizedThreadId);

    await interpretOneThread(deps, {
      userId: accountA.userId,
      mailAccountId: accountA.mailAccountId,
      normalizedThreadId: threadA.normalizedThreadId,
    });
    await interpretOneThread(deps, {
      userId: accountB.userId,
      mailAccountId: accountB.mailAccountId,
      normalizedThreadId: threadB.normalizedThreadId,
    });

    const signalA = await threadSignalRow(client, threadA.normalizedThreadId);
    const signalB = await threadSignalRow(client, threadB.normalizedThreadId);
    expect(signalA.outreach_status).toBe("qualified_outreach");
    expect(signalB.outreach_status).toBe("not_outreach");
  });

  it("a creator decision cannot reference another account's thread, observation, or recipient", async () => {
    const accountA = await connectedMailbox(client, "b05-cross-decision-a");
    const accountB = await connectedMailbox(client, "b05-cross-decision-b");
    const deps = outreachDeps(client);

    const threadB = await insertNormalizedThread(client, {
      userId: accountB.userId,
      mailAccountId: accountB.mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      bodyText: "hello",
    });

    // Account A tries to decide about Account B's thread.
    const result = await recordCreatorDecisionAs(client, accountA.userId, deps, {
      mailAccountId: accountA.mailAccountId,
      normalizedThreadId: threadB.normalizedThreadId,
      axis: "outreach",
      outreachDecision: "outreach_confirmed",
    });
    expect(result.result).toBe("thread_not_found");
  });
});

d("B05: RLS/access — no client role reaches B05 data", () => {
  it("anon and authenticated hold no EXECUTE on any MACHINE gmail_outreach_* function", async () => {
    // Excludes gmail_outreach_record_creator_decision deliberately (Finding
    // 2): that ONE function is meant to be callable by `authenticated`,
    // because it derives its actor from auth.uid() rather than trusting a
    // caller-supplied parameter — see the next test for its exact grants.
    const res = await client.query(
      `select p.proname,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'gmail_outreach_%'
          and p.proname <> 'gmail_outreach_record_creator_decision'`,
    );
    expect(res.rows.length).toBeGreaterThan(0);
    for (const row of res.rows) {
      expect(row.anon_can).toBe(false);
      expect(row.authenticated_can).toBe(false);
    }
  });

  it("Finding 2: gmail_outreach_record_creator_decision is callable by authenticated and service_role, but never anon — and rejects a call carrying no real auth.uid()", async () => {
    const res = await client.query(
      `select has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_can
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'gmail_outreach_record_creator_decision'`,
    );
    expect(res.rows[0].anon_can).toBe(false);
    expect(res.rows[0].authenticated_can).toBe(true);
    expect(res.rows[0].service_role_can).toBe(true);

    // No request.jwt.claims set on this connection at all right now —
    // exactly the shape of a machine/service caller with no real end-user
    // session. auth.uid() must be null, and the function must refuse.
    await client.query("select set_config('request.jwt.claims', '{}', false)");
    const { userId, mailAccountId } = await connectedMailbox(
      client,
      "b05-unauthenticated-decision",
    );
    const { normalizedThreadId } = await insertNormalizedThread(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      bodyText: "hello",
    });
    const deps = outreachDeps(client);
    const result = await recordCreatorDecision(deps, {
      mailAccountId,
      normalizedThreadId,
      axis: "outreach",
      outreachDecision: "outreach_confirmed",
    });
    expect(result.result).toBe("unauthenticated");
    expect(await decisionEventsOf(client, normalizedThreadId)).toHaveLength(0);
  });

  it("no client role holds USAGE on the private schema (unchanged from B01-B04)", async () => {
    const res = await client.query(
      `select has_schema_privilege('anon', 'private', 'USAGE') as anon_usage,
              has_schema_privilege('authenticated', 'private', 'USAGE') as authenticated_usage`,
    );
    expect(res.rows[0].anon_usage).toBe(false);
    expect(res.rows[0].authenticated_usage).toBe(false);
  });

  it("every gmail_outreach_* definer-rights function pins its search_path (B02-B04's own pattern)", async () => {
    const res = await client.query(`
      select p.proname, p.prosecdef, p.proconfig
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'gmail\\_outreach\\_%'
    `);
    // 8: current_catalog_epoch, list_candidates, catalog_snapshot (Finding 8),
    // get_thread_evidence, commit_interpretation, record_creator_decision,
    // status, purge_for_deletion.
    expect(res.rows.length).toBe(8);
    for (const row of res.rows) {
      expect(row.prosecdef, row.proname).toBe(true);
      expect(
        (row.proconfig ?? []).some((c: string) => c.startsWith("search_path=")),
        row.proname,
      ).toBe(true);
    }
  });
});

d("B05: no CRM materialization", () => {
  it("interpreting a qualified-outreach thread writes nothing to pipeline_items, outreach_events or collaborations", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b05-no-crm");
    const deps = outreachDeps(client);
    const { normalizedThreadId } = await insertNormalizedThread(client, {
      userId,
      mailAccountId,
      providerMessageId: randomProviderId("msg"),
      providerThreadId: randomProviderId("thread"),
      toRecipients: ["marketing@nocrmhotel.example"],
      bodyText: "I'd love to collaborate on a paid partnership.",
    });

    const before = await client.query(
      "select (select count(*) from public.pipeline_items) as p, (select count(*) from public.outreach_events) as o, (select count(*) from public.collaborations) as c",
    );

    await interpretOneThread(deps, { userId, mailAccountId, normalizedThreadId });
    await recordCreatorDecisionAs(client, userId, deps, {
      mailAccountId,
      normalizedThreadId,
      axis: "outreach",
      outreachDecision: "outreach_confirmed",
    });

    const after = await client.query(
      "select (select count(*) from public.pipeline_items) as p, (select count(*) from public.outreach_events) as o, (select count(*) from public.collaborations) as c",
    );

    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
