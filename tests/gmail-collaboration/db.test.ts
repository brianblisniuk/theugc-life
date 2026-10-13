import { randomBytes } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { interpretOneThread } from "@/lib/gmail/commercial/service";
import { refreshGmailCollaborationSuggestions } from "@/lib/gmail/collaboration/service";
import { hasTestDb, queryAs, setupDatabase } from "../db/harness";
import { commercialDeps, interpretedThread } from "../gmail-commercial/harness";
import { createRpcClient, createTestUser } from "../gmail/rpc-harness";

const d = describe.skipIf(!hasTestDb);

let client: Client;

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();
  client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  if (client) await client.end();
});

async function creatorFor(userId: string): Promise<string> {
  const existing = await client.query<{ id: string }>(
    "select id from public.creator_profiles where user_id = $1",
    [userId],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const inserted = await client.query<{ id: string }>(
    "insert into public.creator_profiles (user_id) values ($1) returning id",
    [userId],
  );
  return inserted.rows[0]!.id;
}

async function grantPaid(userId: string, kind: "pro" | "destination") {
  let destinationId: string | null = null;
  if (kind === "destination") {
    const suffix = randomBytes(4).toString("hex");
    const destination = await client.query<{ id: string }>(
      `insert into public.destinations (name, slug, type)
       values ($1, $2, 'city') returning id`,
      [`Pass City ${suffix}`, `pass-city-${suffix}`],
    );
    destinationId = destination.rows[0]!.id;
  }
  await client.query(
    `insert into public.access_entitlements
       (user_id, access_type, destination_id, status, starts_at, source, source_reference)
     values ($1, $2, $3, 'active', now(), 'test', $4)`,
    [userId, kind, destinationId, `f01-${kind}-${userId}-${randomBytes(3).toString("hex")}`],
  );
}

async function pipelineItem(userId: string, status: "saved" | "pitched"): Promise<string> {
  const creatorId = await creatorFor(userId);
  const suffix = randomBytes(4).toString("hex");
  const destination = await client.query<{ id: string }>(
    `insert into public.destinations (name, slug, type)
     values ($1, $2, 'city') returning id`,
    [`F01 City ${suffix}`, `f01-city-${suffix}`],
  );
  const hotel = await client.query<{ id: string }>(
    `insert into public.hotels (name, slug, destination_id)
     values ($1, $2, $3) returning id`,
    [`F01 Hotel ${suffix}`, `f01-hotel-${suffix}`, destination.rows[0]!.id],
  );
  const item = await client.query<{ id: string }>(
    `insert into public.pipeline_items (creator_id, hotel_id, status, first_pitched_at)
     values ($1, $2, $3, case when $3 = 'pitched' then now() - interval '40 days' else null end)
     returning id`,
    [creatorId, hotel.rows[0]!.id, status],
  );
  return item.rows[0]!.id;
}

async function bind(userId: string, itemId: string, mailAccountId: string, threadId: string) {
  const res = await client.query(
    `select public.bind_pipeline_inbox_thread($1, $2, $3, $4) as res`,
    [userId, itemId, mailAccountId, threadId],
  );
  return res.rows[0]!.res as { result: string };
}

async function refresh(userId: string, mailAccountId: string, normalizedThreadId: string) {
  const throughAdapter = await refreshGmailCollaborationSuggestions(createRpcClient(client), {
    userId,
    mailAccountId,
    normalizedThreadId,
  });
  return throughAdapter;
}

async function kinds(itemId: string) {
  const res = await client.query<{ kind: string; status: string }>(
    `select kind, status
       from public.gmail_collaboration_suggestions
      where pipeline_item_id = $1
      order by kind, status`,
    [itemId],
  );
  return res.rows;
}

async function ledger(itemId: string) {
  const res = await client.query<{
    status: string;
    events: number;
    gmail_events: number;
    collaborations: number;
    pitches: number;
    replies: number;
  }>(
    `select pi.status,
            (select count(*)::int from public.outreach_events oe where oe.pipeline_item_id = pi.id) as events,
            (select count(*)::int from public.outreach_events oe
              where oe.pipeline_item_id = pi.id and oe.source = 'gmail') as gmail_events,
            (select count(*)::int from public.collaborations c where c.pipeline_item_id = pi.id) as collaborations,
            (select count(*)::int from public.outreach_events oe
              where oe.pipeline_item_id = pi.id and oe.event_type = 'pitch_sent'
                and oe.source = 'manual_creator') as pitches,
            (select count(*)::int from public.outreach_events oe
              where oe.pipeline_item_id = pi.id and oe.event_type = 'reply_received'
                and oe.source = 'manual_creator') as replies
       from public.pipeline_items pi
      where pi.id = $1`,
    [itemId],
  );
  return res.rows[0]!;
}

async function suggestionId(itemId: string, kind: string): Promise<string> {
  const res = await client.query<{ id: string }>(
    `select id from public.gmail_collaboration_suggestions
      where pipeline_item_id = $1 and kind = $2 and status = 'pending'`,
    [itemId, kind],
  );
  return res.rows[0]!.id;
}

async function confirm(
  userId: string,
  itemId: string,
  suggestion: string,
  sentiment: string | null,
) {
  const res = await client.query(
    `select public.confirm_gmail_collaboration_suggestion($1, $2, $3, $4) as res`,
    [userId, itemId, suggestion, sentiment],
  );
  return res.rows[0]!.res as { result: string; kind?: string };
}

d("F01 Gmail collaboration detection", () => {
  it("suggests a pitch and a human reply, and not an auto-responder or a redirect-as-collaboration", async () => {
    const auto = await interpretedThread(client, "f01-ooo", "Out of office until Monday.");
    await grantPaid(auto.userId, "pro");
    await interpretOneThread(commercialDeps(client), {
      userId: auto.userId,
      mailAccountId: auto.mailAccountId,
      normalizedThreadId: auto.normalizedThreadId,
    });
    const autoItem = await pipelineItem(auto.userId, "pitched");
    expect(
      (await bind(auto.userId, autoItem, auto.mailAccountId, auto.providerThreadId)).result,
    ).toBe("refreshed");
    const autoRefresh = await refresh(auto.userId, auto.mailAccountId, auto.normalizedThreadId);
    expect(autoRefresh.result).toBe("ok");
    const autoKinds = await kinds(autoItem);
    expect(autoKinds.map((row) => row.kind)).toEqual(["pitch_sent"]);
    expect(autoKinds[0]!.status).toBe("pending");
    expect(await ledger(autoItem)).toMatchObject({ events: 0, collaborations: 0, gmail_events: 0 });

    const redirect = await interpretedThread(
      client,
      "f01-redirect",
      "Please contact our PR agency instead.",
    );
    await grantPaid(redirect.userId, "pro");
    await interpretOneThread(commercialDeps(client), {
      userId: redirect.userId,
      mailAccountId: redirect.mailAccountId,
      normalizedThreadId: redirect.normalizedThreadId,
    });
    const redirectItem = await pipelineItem(redirect.userId, "pitched");
    await bind(redirect.userId, redirectItem, redirect.mailAccountId, redirect.providerThreadId);
    await refresh(redirect.userId, redirect.mailAccountId, redirect.normalizedThreadId);
    const redirectKinds = await kinds(redirectItem);
    expect(redirectKinds.map((row) => row.kind).sort()).toEqual(["human_reply", "pitch_sent"]);
    expect(redirectKinds.find((row) => row.kind === "collaboration")).toBeUndefined();
  });

  it("keeps a collaboration suggestion from becoming a hotel fact, and maps a confirmed pitch and reply onto manual events", async () => {
    const fixture = await interpretedThread(
      client,
      "f01-agree",
      "Perfect, your stay is confirmed for November 10-12.",
    );
    await grantPaid(fixture.userId, "pro");
    const interpreted = await interpretOneThread(commercialDeps(client), {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
    });
    expect(interpreted.result).toBe("ok");
    const itemId = await pipelineItem(fixture.userId, "pitched");
    await bind(fixture.userId, itemId, fixture.mailAccountId, fixture.providerThreadId);
    const detected = await refresh(
      fixture.userId,
      fixture.mailAccountId,
      fixture.normalizedThreadId,
    );
    expect(detected).toMatchObject({ result: "ok" });
    expect((await kinds(itemId)).map((row) => row.kind).sort()).toEqual([
      "collaboration",
      "human_reply",
      "pitch_sent",
    ]);
    const before = await ledger(itemId);
    expect(before).toMatchObject({ events: 0, collaborations: 0 });

    const factsBefore = await client.query<{ n: number }>(
      `select count(*)::int as n from private.intelligence_facts
        where owner_user_id = $1 and pipeline_item_id = $2`,
      [fixture.userId, itemId],
    );

    const collaboration = await confirm(
      fixture.userId,
      itemId,
      await suggestionId(itemId, "collaboration"),
      null,
    );
    expect(collaboration.result).toBe("confirmed");
    expect(await ledger(itemId)).toMatchObject({
      status: "pitched",
      events: 0,
      collaborations: 0,
      gmail_events: 0,
    });
    const factsAfterCollaboration = await client.query<{ n: number }>(
      `select count(*)::int as n from private.intelligence_facts
        where owner_user_id = $1 and pipeline_item_id = $2`,
      [fixture.userId, itemId],
    );
    expect(factsAfterCollaboration.rows[0]!.n).toBe(factsBefore.rows[0]!.n);

    const pitch = await confirm(
      fixture.userId,
      itemId,
      await suggestionId(itemId, "pitch_sent"),
      null,
    );
    expect(pitch.result).toBe("applied");
    const reply = await confirm(
      fixture.userId,
      itemId,
      await suggestionId(itemId, "human_reply"),
      "unclear",
    );
    expect(reply.result).toBe("applied");
    const after = await ledger(itemId);
    expect(after).toMatchObject({
      status: "replied",
      pitches: 1,
      replies: 1,
      gmail_events: 0,
      collaborations: 0,
    });
    const sentiment = await client.query<{ sentiment: string }>(
      `select metadata->>'sentiment' as sentiment
         from public.outreach_events
        where pipeline_item_id = $1 and event_type = 'reply_received'`,
      [itemId],
    );
    expect(sentiment.rows[0]!.sentiment).toBe("unclear");
  });

  it("lets a manual event win, does not reopen a dismissal, and pauses Free", async () => {
    const fixture = await interpretedThread(client, "f01-manual", "Thanks, send your media kit.");
    await grantPaid(fixture.userId, "pro");
    await interpretOneThread(commercialDeps(client), {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
    });
    const itemId = await pipelineItem(fixture.userId, "pitched");
    const creatorId = await creatorFor(fixture.userId);
    const hotel = await client.query<{ hotel_id: string }>(
      "select hotel_id from public.pipeline_items where id = $1",
      [itemId],
    );
    await client.query(
      `insert into public.outreach_events
         (creator_id, hotel_id, pipeline_item_id, event_type, event_at, channel, source)
       values ($1, $2, $3, 'pitch_sent', now() - interval '20 days', 'email', 'manual_creator')`,
      [creatorId, hotel.rows[0]!.hotel_id, itemId],
    );
    await bind(fixture.userId, itemId, fixture.mailAccountId, fixture.providerThreadId);
    await refresh(fixture.userId, fixture.mailAccountId, fixture.normalizedThreadId);
    const pitchRow = (await kinds(itemId)).find((row) => row.kind === "pitch_sent");
    expect(pitchRow?.status).toBe("manual_overrides");
    expect((await ledger(itemId)).pitches).toBe(1);

    const replyId = await suggestionId(itemId, "human_reply");
    const dismissed = await client.query(
      `select public.dismiss_gmail_collaboration_suggestion($1, $2, $3) as res`,
      [fixture.userId, itemId, replyId],
    );
    expect(dismissed.rows[0]!.res.result).toBe("dismissed");
    expect((await ledger(itemId)).replies).toBe(0);
    await refresh(fixture.userId, fixture.mailAccountId, fixture.normalizedThreadId);
    const again = (await kinds(itemId)).find((row) => row.kind === "human_reply");
    expect(again?.status).toBe("dismissed");

    const free = await interpretedThread(client, "f01-free", "Thanks, send your media kit.");
    const freeItem = await pipelineItem(free.userId, "pitched");
    await bind(free.userId, freeItem, free.mailAccountId, free.providerThreadId);
    const paused = await refresh(free.userId, free.mailAccountId, free.normalizedThreadId);
    expect(paused.result).toBe("paused");
    expect(await kinds(freeItem)).toEqual([]);
    const freeRead = await queryAs<{ res: { result: string } }>(
      { role: "authenticated", sub: free.userId },
      "select public.read_gmail_collaboration_suggestions($1) as res",
      [freeItem],
    );
    expect(freeRead.error).toBeNull();
    expect(freeRead.rows[0]!.res.result).toBe("paused");
  });

  it("lets a Destination Pass detect, and keeps User B from reading or confirming User A", async () => {
    const fixture = await interpretedThread(client, "f01-pass", "Thanks, send your media kit.");
    await grantPaid(fixture.userId, "destination");
    await interpretOneThread(commercialDeps(client), {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
    });
    const itemId = await pipelineItem(fixture.userId, "pitched");
    await bind(fixture.userId, itemId, fixture.mailAccountId, fixture.providerThreadId);
    expect(
      (await refresh(fixture.userId, fixture.mailAccountId, fixture.normalizedThreadId)).result,
    ).toBe("ok");
    const pending = await suggestionId(itemId, "pitch_sent");
    const ownerRead = await queryAs<{ res: { result: string; suggestions: { id: string }[] } }>(
      { role: "authenticated", sub: fixture.userId },
      "select public.read_gmail_collaboration_suggestions($1) as res",
      [itemId],
    );
    expect(ownerRead.rows[0]!.res.result).toBe("ok");
    expect(ownerRead.rows[0]!.res.suggestions.map((row) => row.id)).toContain(pending);

    const other = await createTestUser(client, "f01-other");
    await creatorFor(other);
    await grantPaid(other, "pro");
    const otherRead = await queryAs<{ res: { result: string } }>(
      { role: "authenticated", sub: other },
      "select public.read_gmail_collaboration_suggestions($1) as res",
      [itemId],
    );
    expect(otherRead.rows[0]!.res.result).toBe("not_found");
    expect(JSON.stringify(otherRead.rows)).not.toContain(pending);
    const otherRows = await queryAs(
      { role: "authenticated", sub: other },
      "select id from public.gmail_collaboration_suggestions where id = $1",
      [pending],
    );
    expect(otherRows.rows).toEqual([]);
    const stolen = await confirm(other, itemId, pending, null);
    expect(stolen.result).toBe("not_found");
    expect((await kinds(itemId)).find((row) => row.kind === "pitch_sent")?.status).toBe("pending");

    const anon = await queryAs(
      { role: "anon", sub: null },
      "select id from public.gmail_collaboration_suggestions",
    );
    expect(anon.error).not.toBeNull();
    expect(anon.error!.message).toMatch(/permission denied/i);
  });

  it("purges suggestions with the mailbox and leaves a manual event in place", async () => {
    const fixture = await interpretedThread(client, "f01-purge", "Thanks, send your media kit.");
    await grantPaid(fixture.userId, "pro");
    const itemId = await pipelineItem(fixture.userId, "pitched");
    await bind(fixture.userId, itemId, fixture.mailAccountId, fixture.providerThreadId);
    await refresh(fixture.userId, fixture.mailAccountId, fixture.normalizedThreadId);
    const pitch = await confirm(
      fixture.userId,
      itemId,
      await suggestionId(itemId, "pitch_sent"),
      null,
    );
    expect(pitch.result).toBe("applied");
    expect((await kinds(itemId)).some((row) => row.kind === "human_reply")).toBe(true);

    const disconnect = await client.query<{ def: string }>(
      `select pg_get_functiondef('public.gmail_disconnect_finalize(uuid,uuid,bigint,bigint)'::regprocedure) as def`,
    );
    expect(disconnect.rows[0]!.def).not.toMatch(/gmail_collaboration_suggestions/);

    await client.query("select private.purge_network_gmail_for_mailbox($1)", [
      fixture.mailAccountId,
    ]);
    expect(await kinds(itemId)).toEqual([]);
    expect((await ledger(itemId)).pitches).toBe(1);

    await expect(
      client.query(
        `insert into public.gmail_collaboration_suggestions (
           creator_id, pipeline_item_id, binding_id, mail_account_id, provider_thread_id,
           kind, status, classifier, evidence_key, pitch_at, pitch_message_id
         )
         select b.creator_id, b.pipeline_item_id, b.id, b.mail_account_id, b.provider_thread_id,
                'pitch_sent', 'pending', 'heuristic', 'direct-pitch', now(), 'direct-pitch'
           from public.pipeline_inbox_bindings b
          where b.pipeline_item_id = $1`,
        [itemId],
      ),
    ).rejects.toThrow(/detection functions/);
  });

  it("does not let a reply confirmation skip a pipeline that has not been pitched", async () => {
    const fixture = await interpretedThread(client, "f01-saved", "Thanks, send your media kit.");
    await grantPaid(fixture.userId, "pro");
    await interpretOneThread(commercialDeps(client), {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
      normalizedThreadId: fixture.normalizedThreadId,
    });
    const itemId = await pipelineItem(fixture.userId, "saved");
    await bind(fixture.userId, itemId, fixture.mailAccountId, fixture.providerThreadId);
    await refresh(fixture.userId, fixture.mailAccountId, fixture.normalizedThreadId);
    const reply = await confirm(
      fixture.userId,
      itemId,
      await suggestionId(itemId, "human_reply"),
      "positive",
    );
    expect(reply.result).toBe("invalid_transition");
    expect(await ledger(itemId)).toMatchObject({ status: "saved", events: 0, replies: 0 });
    const missingSentiment = await confirm(
      fixture.userId,
      itemId,
      await suggestionId(itemId, "human_reply"),
      null,
    );
    expect(missingSentiment.result).toBe("invalid_input");
  });
});
