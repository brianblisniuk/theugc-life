/**
 * The home Gmail list is the paid read. User A does not receive User B's
 * suggestion id. A Free caller with a stored row still gets paused and no id.
 */
import { randomBytes } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hasTestDb, queryAs, setupDatabase } from "../db/harness";
import { createTestUser } from "../gmail/rpc-harness";

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

async function seed(
  label: string,
  plan: "pro" | "destination" | "free",
  status: "pending" | "confirmed",
) {
  const userId = await createTestUser(client, `f04-${label}`);
  const profile = await client.query<{ id: string }>(
    "insert into public.creator_profiles (user_id) values ($1) returning id",
    [userId],
  );
  const creatorId = profile.rows[0]!.id;
  const suffix = randomBytes(4).toString("hex");
  const hotelName = `F04 ${label} ${suffix}`;
  const destination = await client.query<{ id: string }>(
    `insert into public.destinations (name, slug, type)
     values ($1, $2, 'city') returning id`,
    [hotelName, `f04-${suffix}`],
  );
  const hotel = await client.query<{ id: string }>(
    `insert into public.hotels (name, slug, destination_id)
     values ($1, $2, $3) returning id`,
    [hotelName, `f04-h-${suffix}`, destination.rows[0]!.id],
  );
  const item = await client.query<{ id: string }>(
    `insert into public.pipeline_items (creator_id, hotel_id, status)
     values ($1, $2, 'saved') returning id`,
    [creatorId, hotel.rows[0]!.id],
  );
  const mail = await client.query<{ id: string }>(
    `insert into public.mail_accounts
       (user_id, provider, provider_account_subject, email_address, connection_state)
     values ($1, 'gmail', $2, $3, 'pending_authorization') returning id`,
    [userId, `f04-${suffix}`, `f04-${suffix}@example.invalid`],
  );
  const thread = `thread-${suffix}`;
  await client.query(
    `insert into private.gmail_normalized_threads (user_id, mail_account_id, provider_thread_id)
     values ($1, $2, $3)`,
    [userId, mail.rows[0]!.id, thread],
  );

  await client.query("begin");
  await client.query("select set_config('inbox_pipeline.writer', 'bind', true)");
  const binding = await client.query<{ id: string }>(
    `insert into public.pipeline_inbox_bindings
       (creator_id, pipeline_item_id, mail_account_id, provider_thread_id)
     values ($1, $2, $3, $4) returning id`,
    [creatorId, item.rows[0]!.id, mail.rows[0]!.id, thread],
  );
  await client.query("select set_config('gmail_collab.writer', 'refresh', true)");
  const suggestion = await client.query<{ id: string }>(
    `insert into public.gmail_collaboration_suggestions (
       creator_id, pipeline_item_id, binding_id, mail_account_id, provider_thread_id,
       kind, status, classifier, evidence_key, pitch_at, pitch_message_id
     ) values (
       $1, $2, $3, $4, $5,
       'pitch_sent', 'pending', 'heuristic', $6, now(), $6
     ) returning id`,
    [creatorId, item.rows[0]!.id, binding.rows[0]!.id, mail.rows[0]!.id, thread, `pitch-${suffix}`],
  );
  if (status === "confirmed") {
    await client.query("select set_config('gmail_collab.writer', 'confirm', true)");
    await client.query(
      `update public.gmail_collaboration_suggestions set status = 'confirmed' where id = $1`,
      [suggestion.rows[0]!.id],
    );
  }
  await client.query("commit");

  if (plan === "pro" || plan === "destination") {
    await client.query(
      `insert into public.access_entitlements
         (user_id, access_type, destination_id, status, starts_at, source, source_reference)
       values ($1, $2, $3, 'active', now(), 'test', $4)`,
      [
        userId,
        plan === "pro" ? "pro" : "destination",
        plan === "destination" ? destination.rows[0]!.id : null,
        `f04-${plan}-${suffix}`,
      ],
    );
  }

  return {
    userId,
    pipelineItemId: item.rows[0]!.id,
    suggestionId: suggestion.rows[0]!.id,
    hotelName,
  };
}

async function listed(userId: string) {
  return queryAs<{ res: { result?: string; suggestions?: unknown } }>(
    { role: "authenticated", sub: userId },
    "select public.list_own_pending_gmail_collaboration_suggestions() as res",
  );
}

d("F04 home Gmail suggestion list", () => {
  it("returns the caller's pending suggestion and not another creator's, a confirmed row, or a Free id", async () => {
    const ada = await seed("ada", "pro", "pending");
    const bee = await seed("bee", "pro", "pending");
    const confirmed = await seed("confirmed", "pro", "confirmed");
    const free = await seed("free", "free", "pending");
    const pass = await seed("pass", "destination", "pending");

    const stored = await client.query(
      "select id from public.gmail_collaboration_suggestions where id = $1",
      [free.suggestionId],
    );
    expect(stored.rows).toHaveLength(1);

    const before = await client.query<{ n: number }>(
      "select count(*)::int as n from public.outreach_events where pipeline_item_id = $1",
      [ada.pipelineItemId],
    );

    const adaRead = await listed(ada.userId);
    expect(adaRead.error).toBeNull();
    const adaBody = JSON.stringify(adaRead.rows[0]?.res);
    expect(adaRead.rows[0]?.res.result).toBe("ok");
    expect(adaBody).toContain(ada.suggestionId);
    expect(adaBody).toContain(ada.hotelName);
    expect(adaBody).not.toContain(bee.suggestionId);
    expect(adaBody).not.toContain(bee.hotelName);
    expect(adaBody).not.toContain(confirmed.suggestionId);
    expect(adaBody).not.toContain(free.suggestionId);

    const beeRead = await listed(bee.userId);
    const beeBody = JSON.stringify(beeRead.rows[0]?.res);
    expect(beeBody).toContain(bee.suggestionId);
    expect(beeBody).not.toContain(ada.suggestionId);
    expect(beeBody).not.toContain(ada.hotelName);

    const confirmedRead = await listed(confirmed.userId);
    expect(confirmedRead.rows[0]?.res).toMatchObject({ result: "ok", suggestions: [] });
    expect(JSON.stringify(confirmedRead.rows[0]?.res)).not.toContain(confirmed.suggestionId);

    const freeRead = await listed(free.userId);
    expect(freeRead.rows[0]?.res.result).toBe("paused");
    expect(freeRead.rows[0]?.res.suggestions).toEqual([]);
    const freeBody = JSON.stringify(freeRead.rows[0]?.res);
    expect(freeBody).not.toContain(free.suggestionId);
    expect(freeBody).not.toContain(free.hotelName);

    const passRead = await listed(pass.userId);
    expect(passRead.rows[0]?.res.result).toBe("ok");
    expect(JSON.stringify(passRead.rows[0]?.res)).toContain(pass.suggestionId);
    expect(JSON.stringify(passRead.rows[0]?.res)).not.toContain(ada.hotelName);

    const anon = await queryAs(
      { role: "anon" },
      "select public.list_own_pending_gmail_collaboration_suggestions()",
    );
    expect(anon.error).not.toBeNull();

    const after = await client.query<{ n: number }>(
      "select count(*)::int as n from public.outreach_events where pipeline_item_id = $1",
      [ada.pipelineItemId],
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });
});
