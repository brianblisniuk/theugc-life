import { randomBytes } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { interpretOneThread } from "@/lib/gmail/commercial/service";
import { runStoredGmailPipeline } from "@/lib/gmail/sync/pipeline";
import { adminQuery, hasTestDb, queryAs, setupDatabase } from "../db/harness";
import { commercialDeps, interpretedThread } from "../gmail-commercial/harness";
import { createTestUser } from "../gmail/rpc-harness";
import { rpc } from "../gmail-import/harness";

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

async function pitchedItem(userId: string, pitchedAt: Date): Promise<string> {
  const creatorId = await creatorFor(userId);
  const suffix = randomBytes(4).toString("hex");
  const destination = await client.query<{ id: string }>(
    `insert into public.destinations (name, slug, type)
     values ($1, $2, 'city') returning id`,
    [`Inbox City ${suffix}`, `inbox-city-${suffix}`],
  );
  const hotel = await client.query<{ id: string }>(
    `insert into public.hotels (name, slug, destination_id)
     values ($1, $2, $3) returning id`,
    [`Inbox Hotel ${suffix}`, `inbox-hotel-${suffix}`, destination.rows[0]!.id],
  );
  const item = await client.query<{ id: string }>(
    `insert into public.pipeline_items (creator_id, hotel_id, status, first_pitched_at)
     values ($1, $2, 'pitched', $3) returning id`,
    [creatorId, hotel.rows[0]!.id, pitchedAt.toISOString()],
  );
  return item.rows[0]!.id;
}

async function counts(itemId: string) {
  const res = await client.query<{
    status: string;
    events: number;
    collaborations: number;
  }>(
    `select pi.status,
            (select count(*)::int from public.outreach_events oe where oe.pipeline_item_id = pi.id) as events,
            (select count(*)::int from public.collaborations c where c.pipeline_item_id = pi.id) as collaborations
       from public.pipeline_items pi
      where pi.id = $1`,
    [itemId],
  );
  return res.rows[0]!;
}

async function kinds(itemId: string): Promise<{ kind: string; status: string; applies_crm: boolean }[]> {
  const res = await client.query(
    `select kind, status, applies_crm
       from public.pipeline_inbox_suggestions
      where pipeline_item_id = $1
      order by kind, status`,
    [itemId],
  );
  return res.rows;
}

async function prepare(label: string, body: string) {
  const fixture = await interpretedThread(client, label, body);
  const interpreted = await interpretOneThread(commercialDeps(client), {
    userId: fixture.userId,
    mailAccountId: fixture.mailAccountId,
    normalizedThreadId: fixture.normalizedThreadId,
  });
  expect(interpreted.result).toBe("ok");
  const itemId = await pitchedItem(fixture.userId, new Date(fixture.t0));
  return { ...fixture, itemId };
}

async function bind(userId: string, itemId: string, mailAccountId: string, threadId: string) {
  const res = await client.query(
    `select public.bind_pipeline_inbox_thread($1, $2, $3, $4) as res`,
    [userId, itemId, mailAccountId, threadId],
  );
  return res.rows[0]!.res as { result: string };
}

d("D06 inbox and pipeline stay one record", () => {
  it("does not let refresh write a CRM transition", async () => {
    const sync = await client.query<{ def: string }>(
      `select pg_get_functiondef('public._pipeline_inbox_sync_suggestions(uuid)'::regprocedure) as def`,
    );
    expect(sync.rows[0]!.def).not.toMatch(/transition_pipeline_item|progress_pipeline_deal|mark_won/);
    const refresh = await client.query<{ def: string }>(
      `select pg_get_functiondef('public.refresh_pipeline_inbox_suggestions(uuid,uuid,uuid)'::regprocedure) as def`,
    );
    expect(refresh.rows[0]!.def).not.toMatch(/transition_pipeline_item|progress_pipeline_deal|mark_won/);
    const accept = await client.query<{ def: string }>(
      `select pg_get_functiondef('public.accept_pipeline_inbox_suggestion(uuid,uuid,uuid,text,timestamptz)'::regprocedure) as def`,
    );
    expect(accept.rows[0]!.def).not.toMatch(/mark_won/);
    expect(accept.rows[0]!.def).toMatch(/start_negotiation/);
  });

  it("treats a redirect as a reply suggestion and not as a rejection", async () => {
    const fixture = await prepare("d06-redirect", "Please contact our PR agency instead");
    const before = await counts(fixture.itemId);
    const linked = await bind(
      fixture.userId,
      fixture.itemId,
      fixture.mailAccountId,
      fixture.providerThreadId,
    );
    expect(linked.result).toBe("refreshed");
    const rows = await kinds(fixture.itemId);
    expect(rows.map((row) => row.kind)).not.toContain("review_decline");
    expect(rows.find((row) => row.kind === "mark_replied")?.status).toBe("pending");
    expect(await counts(fixture.itemId)).toEqual(before);

    const piped = await runStoredGmailPipeline(rpc(client), {
      userId: fixture.userId,
      mailAccountId: fixture.mailAccountId,
    });
    expect(piped.completed).toBe(true);
    expect(await counts(fixture.itemId)).toEqual(before);
    expect((await kinds(fixture.itemId)).map((row) => row.kind)).not.toContain("review_decline");
  });

  it("acknowledges a rejection without closing the pipeline", async () => {
    const fixture = await prepare("d06-reject", "Unfortunately we must decline");
    await bind(fixture.userId, fixture.itemId, fixture.mailAccountId, fixture.providerThreadId);
    const decline = (await kinds(fixture.itemId)).find((row) => row.kind === "review_decline");
    expect(decline?.status).toBe("pending");
    expect(decline?.applies_crm).toBe(false);
    const suggestion = await client.query<{ id: string }>(
      `select id from public.pipeline_inbox_suggestions
        where pipeline_item_id = $1 and kind = 'review_decline'`,
      [fixture.itemId],
    );
    const before = await counts(fixture.itemId);
    const accepted = await client.query(
      `select public.accept_pipeline_inbox_suggestion($1, $2, $3, null, null) as res`,
      [fixture.userId, fixture.itemId, suggestion.rows[0]!.id],
    );
    expect(accepted.rows[0]!.res.result).toBe("acknowledged");
    expect(await counts(fixture.itemId)).toEqual(before);
    const lost = await client.query(
      `select count(*)::int as n from public.outreach_events
        where pipeline_item_id = $1 and event_type = 'deal_lost'`,
      [fixture.itemId],
    );
    expect(lost.rows[0]!.n).toBe(0);
  });

  it("does not turn an agreement reading into a collaboration", async () => {
    const fixture = await prepare("d06-agree", "Your stay is confirmed for October.");
    await bind(fixture.userId, fixture.itemId, fixture.mailAccountId, fixture.providerThreadId);
    const rows = await kinds(fixture.itemId);
    expect(rows.map((row) => row.kind)).toContain("review_agreement");
    expect(rows.map((row) => row.kind)).not.toContain("open_negotiation");
    const suggestion = await client.query<{ id: string }>(
      `select id from public.pipeline_inbox_suggestions
        where pipeline_item_id = $1 and kind = 'review_agreement'`,
      [fixture.itemId],
    );
    const before = await counts(fixture.itemId);
    const accepted = await client.query(
      `select public.accept_pipeline_inbox_suggestion($1, $2, $3, null, null) as res`,
      [fixture.userId, fixture.itemId, suggestion.rows[0]!.id],
    );
    expect(accepted.rows[0]!.res.result).toBe("acknowledged");
    expect(await counts(fixture.itemId)).toEqual(before);
  });

  it("records a reply only when the creator supplies a sentiment", async () => {
    const fixture = await prepare("d06-reply", "We'd love to collaborate. Are your October dates still free?");
    await bind(fixture.userId, fixture.itemId, fixture.mailAccountId, fixture.providerThreadId);
    const suggestion = await client.query<{ id: string }>(
      `select id from public.pipeline_inbox_suggestions
        where pipeline_item_id = $1 and kind = 'mark_replied' and status = 'pending'`,
      [fixture.itemId],
    );
    expect(suggestion.rows).toHaveLength(1);
    const missing = await client.query(
      `select public.accept_pipeline_inbox_suggestion($1, $2, $3, null, null) as res`,
      [fixture.userId, fixture.itemId, suggestion.rows[0]!.id],
    );
    expect(missing.rows[0]!.res.result).toBe("invalid_input");
    expect((await counts(fixture.itemId)).status).toBe("pitched");

    const applied = await client.query(
      `select public.accept_pipeline_inbox_suggestion($1, $2, $3, 'unclear', null) as res`,
      [fixture.userId, fixture.itemId, suggestion.rows[0]!.id],
    );
    expect(applied.rows[0]!.res.result).toBe("applied");
    expect((await counts(fixture.itemId)).status).toBe("replied");
    const event = await client.query<{ source: string; sentiment: string }>(
      `select source, metadata->>'sentiment' as sentiment
         from public.outreach_events
        where pipeline_item_id = $1 and event_type = 'reply_received'`,
      [fixture.itemId],
    );
    expect(event.rows[0]!.source).toBe("manual_creator");
    expect(event.rows[0]!.sentiment).toBe("unclear");
  });

  it("does not reopen a dismissed suggestion for the same machine attempt", async () => {
    const fixture = await prepare("d06-dismiss", "We'd love to collaborate. Are your October dates still free?");
    await bind(fixture.userId, fixture.itemId, fixture.mailAccountId, fixture.providerThreadId);
    const suggestion = await client.query<{ id: string }>(
      `select id from public.pipeline_inbox_suggestions
        where pipeline_item_id = $1 and kind = 'mark_replied'`,
      [fixture.itemId],
    );
    const dismissed = await client.query(
      `select public.dismiss_pipeline_inbox_suggestion($1, $2, $3) as res`,
      [fixture.userId, fixture.itemId, suggestion.rows[0]!.id],
    );
    expect(dismissed.rows[0]!.res.result).toBe("dismissed");
    const again = await client.query(
      `select public.refresh_pipeline_inbox_suggestions($1, $2, $3) as res`,
      [fixture.userId, fixture.mailAccountId, fixture.normalizedThreadId],
    );
    expect(again.rows[0]!.res.result).toBe("refreshed");
    const rows = await kinds(fixture.itemId);
    expect(rows.find((row) => row.kind === "mark_replied")?.status).toBe("dismissed");
    expect((await counts(fixture.itemId)).status).toBe("pitched");
  });

  it("lets a declined machine label with a redirect signal produce no decline suggestion", async () => {
    const fixture = await prepare("d06-lie", "Please contact our PR agency instead");
    await bind(fixture.userId, fixture.itemId, fixture.mailAccountId, fixture.providerThreadId);
    await client.query("begin");
    try {
      await client.query("select set_config('b07.machine_writer', 'on', true)");
      const inserted = await client.query<{ id: string }>(
        `insert into private.gmail_commercial_thread_attempts (
           user_id, mail_account_id, provider_thread_id, normalized_thread_id, input_digest,
           schema_version, transform_version, engine_kind, rule_version, commercial_state,
           compensation_structure, evidence_strength
         )
         select user_id, mail_account_id, provider_thread_id, normalized_thread_id,
                'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                schema_version, transform_version, engine_kind, rule_version,
                'declined_observed', compensation_structure, evidence_strength
           from private.gmail_commercial_thread_attempts
          where mail_account_id = $1
          order by created_at desc
          limit 1
         returning id`,
        [fixture.mailAccountId],
      );
      await client.query(
        `update private.gmail_commercial_thread_current
            set current_attempt_id = $2,
                input_digest = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                stale = false
          where mail_account_id = $1`,
        [fixture.mailAccountId, inserted.rows[0]!.id],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
    const refreshed = await client.query(
      `select public.refresh_pipeline_inbox_suggestions($1, $2, $3) as res`,
      [fixture.userId, fixture.mailAccountId, fixture.normalizedThreadId],
    );
    expect(refreshed.rows[0]!.res.result).toBe("refreshed");
    expect((await kinds(fixture.itemId)).map((row) => row.kind)).not.toContain("review_decline");
    expect((await counts(fixture.itemId)).status).toBe("pitched");
  });

  it("keeps creator status when it already covers the suggestion", async () => {
    const fixture = await prepare("d06-override", "We'd love to collaborate. Are your October dates still free?");
    await client.query("update public.pipeline_items set status = 'negotiating' where id = $1", [
      fixture.itemId,
    ]);
    await bind(fixture.userId, fixture.itemId, fixture.mailAccountId, fixture.providerThreadId);
    const rows = await kinds(fixture.itemId);
    expect(rows.find((row) => row.kind === "mark_replied")?.status).toBe("creator_overrides");
    expect(rows.filter((row) => row.status === "pending")).toEqual([]);
    expect((await counts(fixture.itemId)).status).toBe("negotiating");
  });

  it("refuses User A the ability to read or attach User B's inbox link", async () => {
    const fixture = await prepare("d06-owner", "We'd love to collaborate. Are your October dates still free?");
    await bind(fixture.userId, fixture.itemId, fixture.mailAccountId, fixture.providerThreadId);
    const stranger = await createTestUser(client, "d06-stranger");
    await creatorFor(stranger);
    const strangerItem = await pitchedItem(stranger, new Date());
    const before = await counts(strangerItem);

    const crossed = await bind(
      fixture.userId,
      strangerItem,
      fixture.mailAccountId,
      fixture.providerThreadId,
    );
    const missing = await bind(
      fixture.userId,
      "00000000-0000-4000-8000-00000000abcd",
      fixture.mailAccountId,
      fixture.providerThreadId,
    );
    expect(crossed).toEqual(missing);
    expect(crossed.result).toBe("not_found");
    expect(await counts(strangerItem)).toEqual(before);
    expect((await counts(fixture.itemId)).status).toBe("pitched");

    const foreignAccept = await client.query(
      `select public.accept_pipeline_inbox_suggestion($1, $2, $3, 'positive', null) as res`,
      [stranger, fixture.itemId, "00000000-0000-4000-8000-00000000abce"],
    );
    const missingAccept = await client.query(
      `select public.accept_pipeline_inbox_suggestion($1, $2, $3, 'positive', null) as res`,
      [stranger, "00000000-0000-4000-8000-00000000abcf", "00000000-0000-4000-8000-00000000abd0"],
    );
    expect(foreignAccept.rows[0]!.res).toEqual(missingAccept.rows[0]!.res);

    const asStranger = await queryAs(
      { role: "authenticated", sub: stranger },
      "select id, provider_thread_id from public.pipeline_inbox_bindings",
    );
    expect(asStranger.error).toBeNull();
    expect(asStranger.rows).toEqual([]);
    const asOwner = await queryAs(
      { role: "authenticated", sub: fixture.userId },
      "select provider_thread_id from public.pipeline_inbox_bindings",
    );
    expect(asOwner.rows.map((row) => (row as { provider_thread_id: string }).provider_thread_id)).toContain(
      fixture.providerThreadId,
    );
    const asAnon = await queryAs({ role: "anon" }, "select id from public.pipeline_inbox_suggestions");
    expect(asAnon.error?.code).toBe("42501");

    const denied = await queryAs(
      { role: "authenticated", sub: stranger },
      "select public.bind_pipeline_inbox_thread($1, $2, $3, $4)",
      [fixture.userId, fixture.itemId, fixture.mailAccountId, fixture.providerThreadId],
    );
    expect(denied.error?.code).toBe("42501");
  });

  it("refuses a direct write and a cross-creator attach", async () => {
    const fixture = await prepare("d06-fence", "Please contact our PR agency instead");
    const creatorId = await creatorFor(fixture.userId);
    await expect(
      client.query(
        `insert into public.pipeline_inbox_bindings
           (creator_id, pipeline_item_id, mail_account_id, provider_thread_id)
         values ($1, $2, $3, $4)`,
        [creatorId, fixture.itemId, fixture.mailAccountId, fixture.providerThreadId],
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const stranger = await createTestUser(client, "d06-fence-b");
    const strangerCreator = await creatorFor(stranger);
    const strangerItem = await pitchedItem(stranger, new Date());
    await client.query("select set_config('inbox_pipeline.writer', 'bind', false)");
    try {
      await expect(
        client.query(
          `insert into public.pipeline_inbox_bindings
             (creator_id, pipeline_item_id, mail_account_id, provider_thread_id)
           values ($1, $2, $3, $4)`,
          [strangerCreator, strangerItem, fixture.mailAccountId, fixture.providerThreadId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("select set_config('inbox_pipeline.writer', '', false)");
    }
  });
});

d("D06 grants are queried from the catalog", () => {
  it("loads the migration", async () => {
    const tables = await adminQuery<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname in (
            'pipeline_inbox_bindings',
            'pipeline_inbox_readings',
            'pipeline_inbox_suggestions'
          )
        order by c.relname`,
    );
    expect(tables).toHaveLength(3);
    for (const table of tables) expect(table.relrowsecurity).toBe(true);
  });
});
