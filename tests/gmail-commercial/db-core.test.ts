import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  COMMERCIAL_RULE_VERSION,
  COMMERCIAL_SCHEMA_VERSION,
  COMMERCIAL_TRANSFORM_VERSION,
} from "@/lib/gmail/commercial/contract";
import {
  commitInterpretation,
  interpretOneThread,
  purgeForDeletion,
} from "@/lib/gmail/commercial/service";
import { setupDatabase } from "../db/harness";
import { updateMessage } from "../gmail-reply/harness";
import {
  asCreator,
  attemptCount,
  clearLayersExceptB07,
  commercialDeps,
  interpretedThread,
  startDeletion,
} from "./harness";

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_DB);

let client: Client;

beforeAll(async () => {
  if (!TEST_DB) return;
  await setupDatabase();
  client = new Client({ connectionString: TEST_DB });
  await client.connect();
});

afterAll(async () => {
  if (client) await client.end();
});

const ENGAGED = "We'd love to collaborate. Are your October dates still free?";

d("B07 rules commit on real Postgres", () => {
  it("stores a rules attempt and does not write a human CRM outcome", async () => {
    const fixture = await interpretedThread(client, "b07-engaged", ENGAGED);
    const before = await client.query(`
      select
        (select count(*) from public.pipeline_items) as pipeline_items,
        (select count(*) from public.outreach_events) as outreach_events,
        (select count(*) from public.collaborations) as collaborations,
        (select count(*) from public.hotels) as hotels
    `);
    const deps = commercialDeps(client);
    const result = await interpretOneThread(deps, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
    });
    expect(result).toEqual({ result: "ok", committed: true });

    const after = await client.query(`
      select
        (select count(*) from public.pipeline_items) as pipeline_items,
        (select count(*) from public.outreach_events) as outreach_events,
        (select count(*) from public.collaborations) as collaborations,
        (select count(*) from public.hotels) as hotels
    `);
    expect(after.rows[0]).toEqual(before.rows[0]);

    const attempt = await client.query(
      `select disposition, signals, evidence_strength, engine_kind, rule_version,
              model_provider, model_version, prompt_version
         from private.gmail_commercial_message_attempts
        where mail_account_id = $1 and provider_message_id = $2`,
      [fixture.mailAccountId, fixture.replyId],
    );
    expect(attempt.rows).toHaveLength(1);
    expect(attempt.rows[0].disposition).toBe("positive");
    expect(attempt.rows[0].signals).toEqual(["interest", "request_information"]);
    expect(attempt.rows[0].engine_kind).toBe("rules");
    expect(attempt.rows[0].rule_version).toBe(COMMERCIAL_RULE_VERSION);
    expect(attempt.rows[0].model_provider).toBeNull();
    expect(attempt.rows[0].model_version).toBeNull();
    expect(attempt.rows[0].prompt_version).toBeNull();

    const sentAttempts = await client.query(
      `select 1 from private.gmail_commercial_message_attempts
        where mail_account_id = $1 and provider_message_id = $2`,
      [fixture.mailAccountId, fixture.sentId],
    );
    expect(sentAttempts.rows).toHaveLength(0);

    const thread = await client.query(
      `select a.commercial_state, a.compensation_structure, a.engine_kind
         from private.gmail_commercial_thread_current c
         join private.gmail_commercial_thread_attempts a on a.id = c.current_attempt_id
        where c.mail_account_id = $1`,
      [fixture.mailAccountId],
    );
    expect(thread.rows[0].commercial_state).toBe("engaged");
    expect(thread.rows[0].compensation_structure).toBe("unknown");
    expect(thread.rows[0].engine_kind).toBe("rules");

    const human = await client.query(
      "select count(*)::int as n from private.gmail_commercial_creator_decision_events where mail_account_id = $1",
      [fixture.mailAccountId],
    );
    expect(human.rows[0].n).toBe(0);
  });

  it("a second run with the same digest adds zero attempts", async () => {
    const fixture = await interpretedThread(client, "b07-replay", ENGAGED);
    const deps = commercialDeps(client);
    const input = {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
    };
    expect(await interpretOneThread(deps, input)).toEqual({ result: "ok", committed: true });
    const first = await attemptCount(client, fixture.mailAccountId);
    expect(await interpretOneThread(deps, input)).toEqual({ result: "ok", committed: false });
    expect(await attemptCount(client, fixture.mailAccountId)).toBe(first);
  });

  it("a different payload under the same digest does not append another attempt", async () => {
    const fixture = await interpretedThread(client, "b07-no-oscillate", ENGAGED);
    const deps = commercialDeps(client);
    const input = {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
    };
    expect((await interpretOneThread(deps, input)).result).toBe("ok");
    const evidence = await deps.db.rpc("gmail_commercial_get_thread_evidence", {
      p_user_id: fixture.userId,
      p_mail_account_id: fixture.mailAccountId,
      p_normalized_thread_id: fixture.normalizedThreadId,
      p_schema_version: COMMERCIAL_SCHEMA_VERSION,
      p_transform_version: COMMERCIAL_TRANSFORM_VERSION,
      p_rule_version: COMMERCIAL_RULE_VERSION,
    });
    const body = evidence.data as {
      input_digest: string;
      messages: Array<{ provider_message_id: string; eligible: boolean }>;
    };
    const before = await attemptCount(client, fixture.mailAccountId);
    const again = await deps.db.rpc("gmail_commercial_commit_interpretation", {
      p_user_id: fixture.userId,
      p_mail_account_id: fixture.mailAccountId,
      p_normalized_thread_id: fixture.normalizedThreadId,
      p_schema_version: COMMERCIAL_SCHEMA_VERSION,
      p_transform_version: COMMERCIAL_TRANSFORM_VERSION,
      p_rule_version: COMMERCIAL_RULE_VERSION,
      p_expected_input_digest: body.input_digest,
      p_messages: body.messages
        .filter((message) => message.eligible)
        .map((message) => ({
          provider_message_id: message.provider_message_id,
          disposition: "negative",
          signals: ["rejection"],
          evidence_strength: "strong",
        })),
      p_thread: {
        commercial_state: "declined_observed",
        compensation_structure: "unpaid",
        evidence_strength: "strong",
      },
    });
    expect((again.data as { result: string }).result).toBe("already_current");
    expect(await attemptCount(client, fixture.mailAccountId)).toBe(before);
    const disposition = await client.query(
      `select disposition from private.gmail_commercial_message_attempts
        where mail_account_id = $1 and provider_message_id = $2`,
      [fixture.mailAccountId, fixture.replyId],
    );
    expect(disposition.rows[0].disposition).toBe("positive");
  });

  it("a stale digest writes nothing, and a rebuilt message keeps the attempt with a null pointer", async () => {
    const fixture = await interpretedThread(client, "b07-stale", ENGAGED);
    const deps = commercialDeps(client);
    expect(
      (
        await interpretOneThread(deps, {
          userId: fixture.userId,
          mailAccountId: fixture.mailAccountId,
          normalizedThreadId: fixture.normalizedThreadId,
        })
      ).result,
    ).toBe("ok");
    const stored = await client.query(
      `select id, input_digest from private.gmail_commercial_message_attempts
        where mail_account_id = $1 and provider_message_id = $2`,
      [fixture.mailAccountId, fixture.replyId],
    );
    const before = await attemptCount(client, fixture.mailAccountId);

    await updateMessage(client, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      providerMessageId: fixture.replyId,
      providerThreadId: fixture.providerThreadId,
      internalDateMs: fixture.t0 + 4 * 3_600_000,
      sent: false,
      from: "manager@hotel.example",
      bodyText: "We have to decline. We aren't accepting collaborations.",
    });

    const stale = await commitInterpretation(deps, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
      expectedInputDigest: stored.rows[0].input_digest,
      meaning: {
        commercialState: "engaged",
        compensationStructure: "unknown",
        evidenceStrength: "moderate",
        messages: [
          {
            providerMessageId: fixture.replyId,
            disposition: "positive",
            signals: ["interest"],
            evidenceStrength: "moderate",
            explicitBookingConfirmation: false,
          },
        ],
      },
    });
    expect(stale.result).toBe("stale_source");
    expect(await attemptCount(client, fixture.mailAccountId)).toBe(before);

    const pointer = await client.query(
      "select current_normalized_message_id from private.gmail_commercial_message_attempts where id = $1",
      [stored.rows[0].id],
    );
    expect(pointer.rows[0].current_normalized_message_id).toBeNull();
  });

  it("a rebuilt decline is not read back as the old positive/engaged interpretation", async () => {
    const fixture = await interpretedThread(client, "b07-rebuild-read", ENGAGED);
    const deps = commercialDeps(client);
    expect(
      (
        await interpretOneThread(deps, {
          userId: fixture.userId,
          mailAccountId: fixture.mailAccountId,
          normalizedThreadId: fixture.normalizedThreadId,
        })
      ).result,
    ).toBe("ok");

    await updateMessage(client, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      providerMessageId: fixture.replyId,
      providerThreadId: fixture.providerThreadId,
      internalDateMs: fixture.t0 + 4 * 3_600_000,
      sent: false,
      from: "manager@hotel.example",
      bodyText: "We have to decline. We aren't accepting collaborations.",
    });

    const flagged = await client.query<{ stale: boolean; suppressed: boolean }>(
      `select c.stale, c.suppressed
         from private.gmail_commercial_message_current c
        where c.mail_account_id = $1 and c.provider_message_id = $2`,
      [fixture.mailAccountId, fixture.replyId],
    );
    expect(flagged.rows[0]).toEqual({ stale: true, suppressed: true });
    const threadFlag = await client.query<{ stale: boolean }>(
      `select stale from private.gmail_commercial_thread_current
        where mail_account_id = $1`,
      [fixture.mailAccountId],
    );
    expect(threadFlag.rows[0]!.stale).toBe(true);

    const read = await asCreator(client, fixture.userId, () =>
      deps.db.rpc("gmail_commercial_read_thread", {
        p_mail_account_id: fixture.mailAccountId,
        p_provider_thread_id: fixture.providerThreadId,
      }),
    );
    const body = read.data as {
      result: string;
      machine: { commercial_state: string | null; stale: boolean };
      messages: Array<{ disposition: string | null; stale: boolean }>;
    };
    expect(body.result).toBe("ok");
    expect(body.machine.stale).toBe(true);
    expect(body.machine.commercial_state).toBeNull();
    expect(body.messages.some((message) => message.disposition === "positive")).toBe(false);
    expect(body.machine.commercial_state).not.toBe("engaged");
  });

  it("a digest mismatch marks the current interpretation stale and writes no attempt", async () => {
    const fixture = await interpretedThread(client, "b07-stale-source", ENGAGED);
    const deps = commercialDeps(client);
    expect(
      (
        await interpretOneThread(deps, {
          userId: fixture.userId,
          mailAccountId: fixture.mailAccountId,
          normalizedThreadId: fixture.normalizedThreadId,
        })
      ).result,
    ).toBe("ok");
    const before = await attemptCount(client, fixture.mailAccountId);
    const evidence = await deps.db.rpc("gmail_commercial_get_thread_evidence", {
      p_user_id: fixture.userId,
      p_mail_account_id: fixture.mailAccountId,
      p_normalized_thread_id: fixture.normalizedThreadId,
      p_schema_version: COMMERCIAL_SCHEMA_VERSION,
      p_transform_version: COMMERCIAL_TRANSFORM_VERSION,
      p_rule_version: COMMERCIAL_RULE_VERSION,
    });
    const digest = (evidence.data as { input_digest: string }).input_digest;
    const stale = await commitInterpretation(deps, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
      expectedInputDigest: digest.replace(/^./, digest.startsWith("a") ? "b" : "a"),
      meaning: {
        commercialState: "engaged",
        compensationStructure: "unknown",
        evidenceStrength: "moderate",
        messages: [],
      },
    });
    expect(stale.result).toBe("stale_source");
    expect(await attemptCount(client, fixture.mailAccountId)).toBe(before);
    const threadFlag = await client.query<{ stale: boolean }>(
      `select stale from private.gmail_commercial_thread_current where mail_account_id = $1`,
      [fixture.mailAccountId],
    );
    expect(threadFlag.rows[0]!.stale).toBe(true);
    const read = await asCreator(client, fixture.userId, () =>
      deps.db.rpc("gmail_commercial_read_thread", {
        p_mail_account_id: fixture.mailAccountId,
        p_provider_thread_id: fixture.providerThreadId,
      }),
    );
    const body = read.data as { machine: { commercial_state: string | null; stale: boolean } };
    expect(body.machine.stale).toBe(true);
    expect(body.machine.commercial_state).toBeNull();
  });

  it("a creator correction survives a machine rerun and is not a CRM write", async () => {
    const fixture = await interpretedThread(client, "b07-human", ENGAGED);
    const deps = commercialDeps(client);
    const input = {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
    };
    expect((await interpretOneThread(deps, input)).result).toBe("ok");

    const decision = await asCreator(client, fixture.userId, () =>
      deps.db.rpc("gmail_commercial_record_creator_decision", {
        p_mail_account_id: fixture.mailAccountId,
        p_axis: "disposition",
        p_action: "set",
        p_provider_message_id: fixture.replyId,
        p_provider_thread_id: null,
        p_reply_nature: null,
        p_disposition: "negative",
        p_signals: null,
        p_business_outcome: null,
        p_lost_reason: null,
        p_compensation_structure: null,
      }),
    );
    expect((decision.data as { result: string }).result).toBe("ok");

    expect(await interpretOneThread(deps, input)).toEqual({ result: "ok", committed: false });
    const human = await client.query(
      `select disposition from private.gmail_commercial_message_decisions
        where mail_account_id = $1 and axis = 'disposition'`,
      [fixture.mailAccountId],
    );
    expect(human.rows[0].disposition).toBe("negative");
    const machine = await client.query(
      `select disposition from private.gmail_commercial_message_attempts
        where mail_account_id = $1 and provider_message_id = $2`,
      [fixture.mailAccountId, fixture.replyId],
    );
    expect(machine.rows[0].disposition).toBe("positive");
    const crm = await client.query("select count(*)::int as n from public.pipeline_items");
    expect(crm.rows[0].n).toBe(0);
  });

  it("snapshots the machine value of the axis being corrected", async () => {
    const fixture = await interpretedThread(client, "b07-snapshot", ENGAGED);
    const deps = commercialDeps(client);
    expect(
      (
        await interpretOneThread(deps, {
          userId: fixture.userId,
          mailAccountId: fixture.mailAccountId,
          normalizedThreadId: fixture.normalizedThreadId,
        })
      ).result,
    ).toBe("ok");

    const messageMachine = await client.query<{
      id: string;
      disposition: string;
      signals: string[];
      b06_response_class: string;
    }>(
      `select a.id, a.disposition, a.signals, a.b06_response_class
         from private.gmail_commercial_message_current c
         join private.gmail_commercial_message_attempts a on a.id = c.current_attempt_id
        where c.mail_account_id = $1 and c.provider_message_id = $2`,
      [fixture.mailAccountId, fixture.replyId],
    );
    const threadMachine = await client.query<{
      id: string;
      commercial_state: string;
      compensation_structure: string;
    }>(
      `select a.id, a.commercial_state, a.compensation_structure
         from private.gmail_commercial_thread_current c
         join private.gmail_commercial_thread_attempts a on a.id = c.current_attempt_id
        where c.mail_account_id = $1`,
      [fixture.mailAccountId],
    );
    const message = messageMachine.rows[0]!;
    const thread = threadMachine.rows[0]!;
    expect(message.b06_response_class).toBeTruthy();
    expect(message.disposition).not.toBe(message.b06_response_class);
    expect(thread.compensation_structure).not.toBe(thread.commercial_state);
    const expected = new Map<string, { value: string; attemptId: string }>([
      ["reply_nature", { value: message.b06_response_class, attemptId: message.id }],
      ["disposition", { value: message.disposition, attemptId: message.id }],
      ["signals", { value: [...message.signals].sort().join(","), attemptId: message.id }],
      ["business_outcome", { value: thread.commercial_state, attemptId: thread.id }],
      ["compensation", { value: thread.compensation_structure, attemptId: thread.id }],
    ]);

    const calls: Array<Record<string, unknown>> = [
      {
        p_axis: "reply_nature",
        p_provider_message_id: fixture.replyId,
        p_provider_thread_id: null,
        p_reply_nature: "not_reply",
      },
      {
        p_axis: "disposition",
        p_provider_message_id: fixture.replyId,
        p_provider_thread_id: null,
        p_disposition: "negative",
      },
      {
        p_axis: "signals",
        p_provider_message_id: fixture.replyId,
        p_provider_thread_id: null,
        p_signals: ["redirect"],
      },
      {
        p_axis: "business_outcome",
        p_provider_message_id: null,
        p_provider_thread_id: fixture.providerThreadId,
        p_business_outcome: "open",
      },
      {
        p_axis: "compensation",
        p_provider_message_id: null,
        p_provider_thread_id: fixture.providerThreadId,
        p_compensation_structure: "paid",
      },
    ];
    for (const call of calls) {
      const decision = await asCreator(client, fixture.userId, () =>
        deps.db.rpc("gmail_commercial_record_creator_decision", {
          p_mail_account_id: fixture.mailAccountId,
          p_action: "set",
          p_reply_nature: null,
          p_disposition: null,
          p_signals: null,
          p_business_outcome: null,
          p_lost_reason: null,
          p_compensation_structure: null,
          ...call,
        }),
      );
      expect(decision.error, String(call.p_axis)).toBeNull();
      expect((decision.data as { result: string }).result).toBe("ok");
    }

    const events = await client.query<{
      axis: string;
      observed_machine_value: string;
      observed_machine_attempt_id: string;
    }>(
      `select axis, observed_machine_value, observed_machine_attempt_id
         from private.gmail_commercial_creator_decision_events
        where mail_account_id = $1`,
      [fixture.mailAccountId],
    );
    expect(events.rows).toHaveLength(5);
    for (const event of events.rows) {
      expect(event.observed_machine_value, event.axis).toBe(expected.get(event.axis)!.value);
      expect(event.observed_machine_attempt_id, event.axis).toBe(
        expected.get(event.axis)!.attemptId,
      );
    }
    expect(events.rows.find((event) => event.axis === "signals")!.observed_machine_value).not.toBe(
      message.disposition,
    );
    expect(
      events.rows.find((event) => event.axis === "compensation")!.observed_machine_value,
    ).not.toBe(thread.commercial_state);
  });

  it("Axis A automated suppresses the machine current and keeps the human event", async () => {
    const fixture = await interpretedThread(client, "b07-axis-a", ENGAGED);
    const deps = commercialDeps(client);
    const input = {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
    };
    expect((await interpretOneThread(deps, input)).result).toBe("ok");
    const decision = await asCreator(client, fixture.userId, () =>
      deps.db.rpc("gmail_commercial_record_creator_decision", {
        p_mail_account_id: fixture.mailAccountId,
        p_axis: "reply_nature",
        p_action: "set",
        p_provider_message_id: fixture.replyId,
        p_provider_thread_id: null,
        p_reply_nature: "automated",
        p_disposition: null,
        p_signals: null,
        p_business_outcome: null,
        p_lost_reason: null,
        p_compensation_structure: null,
      }),
    );
    expect(decision.error).toBeNull();
    expect((decision.data as { projection_advanced: boolean }).projection_advanced).toBe(true);

    const flagged = await client.query(
      `select stale, suppressed from private.gmail_commercial_message_current
        where mail_account_id = $1 and provider_message_id = $2`,
      [fixture.mailAccountId, fixture.replyId],
    );
    expect(flagged.rows[0]).toEqual({ stale: true, suppressed: true });

    const again = await interpretOneThread(deps, input);
    expect(again.result).toBe("ok");
    const events = await client.query(
      "select count(*)::int as n from private.gmail_commercial_creator_decision_events where mail_account_id = $1",
      [fixture.mailAccountId],
    );
    expect(events.rows[0].n).toBe(1);
    const state = await client.query(
      `select a.commercial_state
         from private.gmail_commercial_thread_current c
         join private.gmail_commercial_thread_attempts a on a.id = c.current_attempt_id
        where c.mail_account_id = $1`,
      [fixture.mailAccountId],
    );
    expect(state.rows[0].commercial_state).toBeNull();
  });

  it("redirect combined with rejection is rejected by the table check", async () => {
    const fixture = await interpretedThread(client, "b07-redirect-check", ENGAGED);
    await client.query("begin");
    let code: string | undefined;
    try {
      await client.query("select set_config('b07.machine_writer', 'on', true)");
      await client.query(
        `insert into private.gmail_commercial_message_attempts (
           user_id, mail_account_id, provider_message_id, provider_thread_id, axis_a_basis,
           source_payload_sha256, input_digest, schema_version, transform_version,
           engine_kind, rule_version, disposition, signals, evidence_strength
         ) values (
           $1, $2, 'foreign-message', 'foreign-thread', 'none',
           $3, $3, $4, 'gmail_commercial_text_v1', 'rules', $5,
           'negative', array['redirect','rejection'], 'strong'
         )`,
        [
          fixture.userId,
          fixture.mailAccountId,
          "ab".repeat(32),
          COMMERCIAL_SCHEMA_VERSION,
          COMMERCIAL_RULE_VERSION,
        ],
      );
    } catch (error) {
      code = (error as { code?: string }).code;
    } finally {
      await client.query("rollback");
    }
    expect(code).toBe("23514");
  });

  it("rejects agreement_observed for a one-sided acceptance and keeps a booking confirmation", async () => {
    const oneSided = await interpretedThread(
      client,
      "b07-onesided",
      "Yes, we accept your proposal.",
    );
    const deps = commercialDeps(client);
    const accepted = await interpretOneThread(deps, {
      userId: oneSided.userId,
      mailAccountId: oneSided.mailAccountId,
      normalizedThreadId: oneSided.normalizedThreadId,
    });
    expect(accepted).toEqual({ result: "ok", committed: true });
    const stored = await client.query<{ commercial_state: string }>(
      `select a.commercial_state
         from private.gmail_commercial_thread_current c
         join private.gmail_commercial_thread_attempts a on a.id = c.current_attempt_id
        where c.mail_account_id = $1`,
      [oneSided.mailAccountId],
    );
    expect(stored.rows[0]!.commercial_state).toBe("negotiating");

    const evidence = await deps.db.rpc("gmail_commercial_get_thread_evidence", {
      p_user_id: oneSided.userId,
      p_mail_account_id: oneSided.mailAccountId,
      p_normalized_thread_id: oneSided.normalizedThreadId,
      p_schema_version: COMMERCIAL_SCHEMA_VERSION,
      p_transform_version: COMMERCIAL_TRANSFORM_VERSION,
      p_rule_version: COMMERCIAL_RULE_VERSION,
    });
    const digest = (evidence.data as { input_digest: string }).input_digest;
    const forced = await deps.db.rpc("gmail_commercial_commit_interpretation", {
      p_user_id: oneSided.userId,
      p_mail_account_id: oneSided.mailAccountId,
      p_normalized_thread_id: oneSided.normalizedThreadId,
      p_schema_version: COMMERCIAL_SCHEMA_VERSION,
      p_transform_version: COMMERCIAL_TRANSFORM_VERSION,
      p_rule_version: COMMERCIAL_RULE_VERSION,
      p_expected_input_digest: digest,
      p_messages: [
        {
          provider_message_id: oneSided.replyId,
          disposition: "positive",
          signals: ["agreement"],
          evidence_strength: "strong",
          explicit_booking_confirmation: false,
        },
      ],
      p_thread: {
        commercial_state: "agreement_observed",
        compensation_structure: "unknown",
        evidence_strength: "strong",
      },
    });
    expect(forced.error?.code).toBe("23514");
    const still = await client.query<{ commercial_state: string }>(
      `select a.commercial_state
         from private.gmail_commercial_thread_current c
         join private.gmail_commercial_thread_attempts a on a.id = c.current_attempt_id
        where c.mail_account_id = $1`,
      [oneSided.mailAccountId],
    );
    expect(still.rows[0]!.commercial_state).toBe("negotiating");

    const booked = await interpretedThread(
      client,
      "b07-booked",
      "Perfect, your stay is confirmed for November 10–12.",
    );
    expect(
      (
        await interpretOneThread(deps, {
          userId: booked.userId,
          mailAccountId: booked.mailAccountId,
          normalizedThreadId: booked.normalizedThreadId,
        })
      ).result,
    ).toBe("ok");
    const booking = await client.query<{ commercial_state: string }>(
      `select a.commercial_state
         from private.gmail_commercial_thread_current c
         join private.gmail_commercial_thread_attempts a on a.id = c.current_attempt_id
        where c.mail_account_id = $1`,
      [booked.mailAccountId],
    );
    expect(booking.rows[0]!.commercial_state).toBe("agreement_observed");
  });

  it("declined_observed is refused when the latest message is only a timing constraint", async () => {
    const fixture = await interpretedThread(
      client,
      "b07-timing",
      "I can't tell you yet. Please reach out for our next availability.",
    );
    const deps = commercialDeps(client);
    const evidence = await deps.db.rpc("gmail_commercial_get_thread_evidence", {
      p_user_id: fixture.userId,
      p_mail_account_id: fixture.mailAccountId,
      p_normalized_thread_id: fixture.normalizedThreadId,
      p_schema_version: COMMERCIAL_SCHEMA_VERSION,
      p_transform_version: COMMERCIAL_TRANSFORM_VERSION,
      p_rule_version: COMMERCIAL_RULE_VERSION,
    });
    const body = evidence.data as {
      input_digest: string;
      messages: Array<{ provider_message_id: string; eligible: boolean }>;
    };
    const refused = await deps.db.rpc("gmail_commercial_commit_interpretation", {
      p_user_id: fixture.userId,
      p_mail_account_id: fixture.mailAccountId,
      p_normalized_thread_id: fixture.normalizedThreadId,
      p_schema_version: COMMERCIAL_SCHEMA_VERSION,
      p_transform_version: COMMERCIAL_TRANSFORM_VERSION,
      p_rule_version: COMMERCIAL_RULE_VERSION,
      p_expected_input_digest: body.input_digest,
      p_messages: body.messages
        .filter((message) => message.eligible)
        .map((message) => ({
          provider_message_id: message.provider_message_id,
          disposition: "neutral",
          signals: ["timing_constraint"],
          evidence_strength: "moderate",
        })),
      p_thread: {
        commercial_state: "declined_observed",
        compensation_structure: "unknown",
        evidence_strength: "moderate",
      },
    });
    expect(refused.error?.code).toBe("23514");
    expect(await attemptCount(client, fixture.mailAccountId)).toBe(0);
  });

  it("a human event cannot be inserted without the human-writer guard", async () => {
    const fixture = await interpretedThread(client, "b07-guc", ENGAGED);
    await expect(
      client.query(
        `insert into private.gmail_commercial_creator_decision_events (
           user_id, mail_account_id, decided_by_user_id, axis, provider_message_id, action, disposition
         ) values ($1, $2, $1, 'disposition', $3, 'set', 'negative')`,
        [fixture.userId, fixture.mailAccountId, fixture.replyId],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("deleted is unrepresentable while B07 rows remain, and purge removes them", async () => {
    const fixture = await interpretedThread(client, "b07-purge", ENGAGED);
    const deps = commercialDeps(client);
    expect(
      (
        await interpretOneThread(deps, {
          userId: fixture.userId,
          mailAccountId: fixture.mailAccountId,
          normalizedThreadId: fixture.normalizedThreadId,
        })
      ).result,
    ).toBe("ok");
    const decision = await asCreator(client, fixture.userId, () =>
      deps.db.rpc("gmail_commercial_record_creator_decision", {
        p_mail_account_id: fixture.mailAccountId,
        p_axis: "business_outcome",
        p_action: "set",
        p_provider_message_id: null,
        p_provider_thread_id: fixture.providerThreadId,
        p_reply_nature: null,
        p_disposition: null,
        p_signals: null,
        p_business_outcome: "open",
        p_lost_reason: null,
        p_compensation_structure: null,
      }),
    );
    expect((decision.data as { result: string }).result).toBe("ok");

    const requestId = await startDeletion(
      client,
      fixture.mailAccountId,
      fixture.userId,
      "account_and_gmail_derived_data",
    );
    await clearLayersExceptB07(client, fixture.mailAccountId);

    await expect(retire(client, fixture.mailAccountId, requestId)).rejects.toThrow(
      /commercial-meaning/,
    );

    const still = await client.query(
      "select count(*)::int as n from private.gmail_commercial_message_attempts where mail_account_id = $1",
      [fixture.mailAccountId],
    );
    expect(still.rows[0].n).toBeGreaterThan(0);

    const purged = await purgeForDeletion(deps, {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      deletionRequestId: requestId,
    });
    expect(purged.result).toBe("ok");
    const left = await client.query(
      `select
         (select count(*) from private.gmail_commercial_message_attempts where mail_account_id = $1)
         + (select count(*) from private.gmail_commercial_thread_attempts where mail_account_id = $1)
         + (select count(*) from private.gmail_commercial_creator_decision_events where mail_account_id = $1)
         + (select count(*) from private.gmail_commercial_message_current where mail_account_id = $1)
         + (select count(*) from private.gmail_commercial_thread_current where mail_account_id = $1)
         + (select count(*) from private.gmail_commercial_message_decisions where mail_account_id = $1)
         + (select count(*) from private.gmail_commercial_thread_decisions where mail_account_id = $1)
         as n`,
      [fixture.mailAccountId],
    );
    expect(Number(left.rows[0].n)).toBe(0);
    await retire(client, fixture.mailAccountId, requestId);
  });

  it("rejects agreement_observed when a one-sided accept only claims the booking flag", async () => {
    const oneSided = await interpretedThread(
      client,
      "b07-onesided-flag",
      "Yes, we accept your proposal.",
    );
    const forced = await commitClaimedAgreement(client, oneSided, true);
    expect(forced.error?.code).toBe("23514");
    expect(forced.error?.message).toMatch(/agreement_observed/);
    expect(await attemptCount(client, oneSided.mailAccountId)).toBe(0);
    const stored = await client.query(
      `select count(*)::int as n from private.gmail_commercial_thread_attempts
        where mail_account_id = $1`,
      [oneSided.mailAccountId],
    );
    expect(stored.rows[0]!.n).toBe(0);
  });

  it("accepts agreement_observed from stored booking text, not the caller flag", async () => {
    const booked = await interpretedThread(
      client,
      "b07-booked-text",
      "Perfect, your stay is confirmed for November 10–12.",
    );
    const forced = await commitClaimedAgreement(client, booked, false);
    expect(forced.error).toBeNull();
    expect((forced.data as { result: string }).result).toBe("ok");
    const state = await client.query<{ commercial_state: string }>(
      `select a.commercial_state
         from private.gmail_commercial_thread_current c
         join private.gmail_commercial_thread_attempts a on a.id = c.current_attempt_id
        where c.mail_account_id = $1`,
      [booked.mailAccountId],
    );
    expect(state.rows[0]!.commercial_state).toBe("agreement_observed");
  });

  it("does not treat a quoted booking phrase as both-party confirmation", async () => {
    const quoted = await interpretedThread(
      client,
      "b07-quoted-booking",
      [
        "Yes, we accept your proposal.",
        "",
        "On Monday, Alex wrote:",
        "> your stay is confirmed for November 10-12.",
      ].join("\n"),
    );
    const forced = await commitClaimedAgreement(client, quoted, true);
    expect(forced.error?.code).toBe("23514");
    expect(forced.error?.message).toMatch(/agreement_observed/);
    expect(await attemptCount(client, quoted.mailAccountId)).toBe(0);
  });

  it("marks the creator read stale when B06 classification changes in place", async () => {
    const fixture = await interpretedThread(client, "b07-b06-class", ENGAGED);
    const deps = commercialDeps(client);
    expect(
      (
        await interpretOneThread(deps, {
          userId: fixture.userId,
          mailAccountId: fixture.mailAccountId,
          normalizedThreadId: fixture.normalizedThreadId,
        })
      ).result,
    ).toBe("ok");
    const decision = await asCreator(client, fixture.userId, () =>
      deps.db.rpc("gmail_commercial_record_creator_decision", {
        p_mail_account_id: fixture.mailAccountId,
        p_axis: "business_outcome",
        p_action: "set",
        p_provider_message_id: null,
        p_provider_thread_id: fixture.providerThreadId,
        p_reply_nature: null,
        p_disposition: null,
        p_signals: null,
        p_business_outcome: "won",
        p_lost_reason: null,
        p_compensation_structure: null,
      }),
    );
    expect((decision.data as { result: string }).result).toBe("ok");
    const before = await attemptCount(client, fixture.mailAccountId);

    await client.query(
      `update private.gmail_reply_message_observations
          set response_class = 'automated_response'
        where mail_account_id = $1 and provider_message_id = $2`,
      [fixture.mailAccountId, fixture.replyId],
    );

    const listed = await asCreator(client, fixture.userId, () =>
      deps.db.rpc("gmail_commercial_list_threads", {
        p_mail_account_id: fixture.mailAccountId,
      }),
    );
    const listBody = listed.data as {
      result: string;
      threads: Array<{ commercial_state: string | null; stale: boolean }>;
    };
    expect(listBody.result).toBe("ok");
    expect(listBody.threads).toHaveLength(1);
    expect(listBody.threads[0]!.stale).toBe(true);
    expect(listBody.threads[0]!.commercial_state).toBeNull();

    const read = await asCreator(client, fixture.userId, () =>
      deps.db.rpc("gmail_commercial_read_thread", {
        p_mail_account_id: fixture.mailAccountId,
        p_provider_thread_id: fixture.providerThreadId,
      }),
    );
    const body = read.data as {
      result: string;
      machine: { commercial_state: string | null; stale: boolean };
      messages: Array<{ disposition: string | null; signals: string[] | null; stale: boolean }>;
      human_thread: Array<{ business_outcome: string | null }>;
    };
    expect(body.result).toBe("ok");
    expect(body.machine.stale).toBe(true);
    expect(body.machine.commercial_state).toBeNull();
    expect(body.messages.every((message) => message.disposition === null)).toBe(true);
    expect(body.messages.every((message) => message.stale)).toBe(true);
    expect(body.human_thread.some((row) => row.business_outcome === "won")).toBe(true);

    const flags = await client.query<{ stale: boolean; stale_reason: string }>(
      `select stale, stale_reason from private.gmail_commercial_thread_current
        where mail_account_id = $1`,
      [fixture.mailAccountId],
    );
    expect(flags.rows[0]).toEqual({ stale: true, stale_reason: "b06_fingerprint" });
    const history = await client.query<{ disposition: string; b06_response_class: string }>(
      `select disposition, b06_response_class
         from private.gmail_commercial_message_attempts
        where mail_account_id = $1 and provider_message_id = $2`,
      [fixture.mailAccountId, fixture.replyId],
    );
    expect(history.rows[0]).toEqual({
      disposition: "positive",
      b06_response_class: "qualifying_human_reply",
    });
    expect(await attemptCount(client, fixture.mailAccountId)).toBe(before);
    const humans = await client.query<{ n: number }>(
      `select count(*)::int as n from private.gmail_commercial_creator_decision_events
        where mail_account_id = $1`,
      [fixture.mailAccountId],
    );
    expect(humans.rows[0]!.n).toBe(1);
  });

  it("marks the creator read stale when the B06 chronology version changes in place", async () => {
    const fixture = await interpretedThread(client, "b07-b06-version", ENGAGED);
    const deps = commercialDeps(client);
    expect(
      (
        await interpretOneThread(deps, {
          userId: fixture.userId,
          mailAccountId: fixture.mailAccountId,
          normalizedThreadId: fixture.normalizedThreadId,
        })
      ).result,
    ).toBe("ok");

    await client.query(
      `update private.gmail_reply_message_observations
          set relation_rule_version = 'gmail_reply_relation_drift'
        where mail_account_id = $1 and provider_message_id = $2`,
      [fixture.mailAccountId, fixture.replyId],
    );

    const read = await asCreator(client, fixture.userId, () =>
      deps.db.rpc("gmail_commercial_read_thread", {
        p_mail_account_id: fixture.mailAccountId,
        p_provider_thread_id: fixture.providerThreadId,
      }),
    );
    const body = read.data as {
      machine: { commercial_state: string | null; stale: boolean };
      messages: Array<{ disposition: string | null }>;
    };
    expect(body.machine.stale).toBe(true);
    expect(body.machine.commercial_state).toBeNull();
    expect(body.messages.every((message) => message.disposition === null)).toBe(true);
    const messageFlag = await client.query<{ stale: boolean; stale_reason: string }>(
      `select stale, stale_reason from private.gmail_commercial_message_current
        where mail_account_id = $1 and provider_message_id = $2`,
      [fixture.mailAccountId, fixture.replyId],
    );
    expect(messageFlag.rows[0]).toEqual({ stale: true, stale_reason: "b06_fingerprint" });
  });
});

async function commitClaimedAgreement(
  db: Client,
  fixture: Awaited<ReturnType<typeof interpretedThread>>,
  explicitBookingConfirmation: boolean,
) {
  const deps = commercialDeps(db);
  const evidence = await deps.db.rpc("gmail_commercial_get_thread_evidence", {
    p_user_id: fixture.userId,
    p_mail_account_id: fixture.mailAccountId,
    p_normalized_thread_id: fixture.normalizedThreadId,
    p_schema_version: COMMERCIAL_SCHEMA_VERSION,
    p_transform_version: COMMERCIAL_TRANSFORM_VERSION,
    p_rule_version: COMMERCIAL_RULE_VERSION,
  });
  const digest = (evidence.data as { input_digest: string }).input_digest;
  return deps.db.rpc("gmail_commercial_commit_interpretation", {
    p_user_id: fixture.userId,
    p_mail_account_id: fixture.mailAccountId,
    p_normalized_thread_id: fixture.normalizedThreadId,
    p_schema_version: COMMERCIAL_SCHEMA_VERSION,
    p_transform_version: COMMERCIAL_TRANSFORM_VERSION,
    p_rule_version: COMMERCIAL_RULE_VERSION,
    p_expected_input_digest: digest,
    p_messages: [
      {
        provider_message_id: fixture.replyId,
        disposition: "positive",
        signals: ["agreement"],
        evidence_strength: "strong",
        explicit_booking_confirmation: explicitBookingConfirmation,
      },
    ],
    p_thread: {
      commercial_state: "agreement_observed",
      compensation_structure: "unknown",
      evidence_strength: "strong",
    },
  });
}

async function retire(client: Client, mailAccountId: string, requestId: string): Promise<void> {
  await client.query("begin");
  try {
    await client.query(
      "update public.mail_account_deletion_requests set status = 'completed', completed_at = now() where id = $1",
      [requestId],
    );
    await client.query(
      "update public.mail_accounts set connection_state = 'deleted' where id = $1",
      [mailAccountId],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}
