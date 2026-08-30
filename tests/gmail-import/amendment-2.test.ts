import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseInternalDateMs } from "@/lib/gmail/import/provider-shape";
import {
  hasMimeNameParameter,
  sanitizeMessage,
  sanitizeThread,
} from "@/lib/gmail/import/sanitizer";
import { runOneImportStep } from "@/lib/gmail/import/worker.server";

import { createFakeGmailRead, textMessage, thread } from "./fake-gmail-read";
import {
  connectedMailbox,
  headerValue,
  headerValues,
  importDeps,
  rawMessages,
  rpc,
  runRow,
  setConnectionState,
  threadRows,
  withdrawConsent,
} from "./harness";

/**
 * B03 EXTERNAL AUDIT AMENDMENT #2.
 *
 *   A  a cancelled or paused claim could still start a NEW Gmail request
 *   B  malformed-success validation was partial (`typeof [] === "object"`)
 *   C  RFC 2231 extended filenames walked past the name guard
 *   D  a repeated approved header silently lost an occurrence
 *
 * Each was reproduced as real committed state, or as real observed behaviour of
 * the production parser, before it was fixed.
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

const DAY = 86_400_000;
const windowStart = () => new Date(Date.now() - 30 * DAY).toISOString();
const inWindow = () => Date.now() - 5 * DAY;

async function startRun(label: string) {
  const mailbox = await connectedMailbox(client, label);
  const started = await rpc(client).rpc("gmail_historical_import_start", {
    p_user_id: mailbox.userId,
    p_mail_account_id: mailbox.mailAccountId,
    p_window_start_at: windowStart(),
  });
  return { ...mailbox, runId: (started.data as { run_id: string }).run_id };
}

async function reconnect(mailAccountId: string, userId: string) {
  await client.query("begin");
  await client.query(
    `update public.mail_accounts
        set connection_state = 'connected', connected_at = now(), disconnected_at = null,
            granted_scopes = (select granted_scopes_at_decision
                                from public.mail_account_consent_receipts
                               where mail_account_id = $1 and decision = 'granted'
                               order by event_seq desc limit 1)
      where id = $1`,
    [mailAccountId],
  );
  await client.query(
    `insert into private.gmail_oauth_credentials
       (mail_account_id, user_id, refresh_token_ciphertext, refresh_token_iv,
        refresh_token_auth_tag, encryption_key_version)
     values ($1, $2, 'ct2', 'iv2', 'tag2', 'v1')
     on conflict (mail_account_id) do nothing`,
    [mailAccountId, userId],
  );
  await client.query("commit");
}

async function regrantConsent(mailAccountId: string, userId: string) {
  await client.query("begin");
  const receipt = await client.query(
    `insert into public.mail_account_consent_receipts
       (mail_account_id, user_id, consent_kind, decision, policy_version, consent_text_digest,
        granted_scopes_at_decision, decided_by_user_id, decided_at, receipt_digest)
     values ($1, $2, 'private_gmail_processing', 'granted', 'p/1', $3,
             (select granted_scopes from public.mail_accounts where id = $1), $2, now(), $4)
     returning id, event_seq`,
    [mailAccountId, userId, "a".repeat(64), "d".repeat(64)],
  );
  await client.query(
    `update public.mail_account_consents
        set state = 'granted', current_receipt_id = $2, current_event_seq = $3
      where mail_account_id = $1 and consent_kind = 'private_gmail_processing'`,
    [mailAccountId, receipt.rows[0].id, receipt.rows[0].event_seq],
  );
  await client.query(
    "update public.mail_accounts set connection_state = 'connected' where id = $1",
    [mailAccountId],
  );
  await client.query("commit");
}

const page = { candidates: [{ messageId: "m1", threadId: "t1" }], nextPageToken: null };

// ===========================================================================
// A. A CANCELLED OR PAUSED CLAIM STARTS NO NEW GMAIL REQUEST
// ===========================================================================
//
// Every test here makes the lifecycle change happen INSIDE the gap between the
// claim and the provider call — the token acquisition and the pacer wait are
// where a real worker loses time — and then asserts the provider was never
// called at all. Not "nothing was persisted": never called.

d("A. the final pre-provider claim fence", () => {
  it("A1. Disconnect then Reconnect during the gap: zero Gmail calls", async () => {
    const run = await startRun("a2-a1-disconnect");
    const gmail = createFakeGmailRead({ pages: [page] });

    const outcome = await runOneImportStep(
      { userId: run.userId, runId: run.runId },
      importDeps(client, {
        gmail,
        // The worker is descheduled here. B02 will hand back a valid token,
        // because by the time it is asked the mailbox is connected again.
        accessToken: async () => {
          await setConnectionState(client, run.mailAccountId, "disconnected");
          await reconnect(run.mailAccountId, run.userId);
          return { result: "ok", accessToken: "fake" };
        },
      }),
    );

    expect(gmail.calls.listMessagesCalls).toBe(0);
    expect(gmail.calls.getThreadCalls).toBe(0);
    expect(outcome).toEqual({ result: "cancelled", connectionState: "connected" });
    expect((await runRow(client, run.runId)).status).toBe("cancelled_connection_stopped");
  });

  it("A2. consent withdrawal then regrant during the gap: zero Gmail calls", async () => {
    const run = await startRun("a2-a2-consent");
    const gmail = createFakeGmailRead({ pages: [page] });

    const outcome = await runOneImportStep(
      { userId: run.userId, runId: run.runId },
      importDeps(client, {
        gmail,
        accessToken: async () => {
          await withdrawConsent(client, run.mailAccountId, run.userId);
          await regrantConsent(run.mailAccountId, run.userId);
          return { result: "ok", accessToken: "fake" };
        },
      }),
    );

    // A paused import requires an explicit RESUME before another provider read,
    // not merely before another write.
    expect(gmail.calls.listMessagesCalls).toBe(0);
    expect(outcome).toEqual({ result: "paused", reason: "consent" });
    expect((await runRow(client, run.runId)).status).toBe("paused_consent");
  });

  it("A3. reauth_required then reconnect during the gap: zero Gmail calls", async () => {
    const run = await startRun("a2-a3-reauth");
    const gmail = createFakeGmailRead({ pages: [page] });

    const outcome = await runOneImportStep(
      { userId: run.userId, runId: run.runId },
      importDeps(client, {
        gmail,
        accessToken: async () => {
          await setConnectionState(client, run.mailAccountId, "reauth_required");
          await reconnect(run.mailAccountId, run.userId);
          return { result: "ok", accessToken: "fake" };
        },
      }),
    );

    expect(gmail.calls.listMessagesCalls).toBe(0);
    expect(outcome).toEqual({ result: "paused", reason: "reauth" });
    expect((await runRow(client, run.runId)).status).toBe("paused_reauth");
  });

  it("A4. a lease reclaimed during the gap: zero Gmail calls", async () => {
    const run = await startRun("a2-a4-lease");
    const gmail = createFakeGmailRead({ pages: [page] });

    const outcome = await runOneImportStep(
      { userId: run.userId, runId: run.runId },
      importDeps(client, {
        gmail,
        accessToken: async () => {
          // Another worker expires and reclaims the step while this one waits.
          await client.query(
            `update private.gmail_historical_import_runs
                set lease_expires_at = now() - interval '1 second' where id = $1`,
            [run.runId],
          );
          await rpc(client).rpc("gmail_historical_import_claim_step", {
            p_user_id: run.userId,
            p_run_id: run.runId,
            p_lease_seconds: 300,
          });
          return { result: "ok", accessToken: "fake" };
        },
      }),
    );

    // The mailbox is perfectly healthy. What is stale is the CLAIM, and a stale
    // claim is not permission to spend this mailbox's quota.
    expect(gmail.calls.listMessagesCalls).toBe(0);
    expect(outcome).toEqual({ result: "retry_scheduled", reason: "stale_lease" });
  });

  it("A5. a lifecycle change during the QUOTA WAIT: zero Gmail calls", async () => {
    const run = await startRun("a2-a5-pacer");
    const gmail = createFakeGmailRead({ pages: [page] });

    const outcome = await runOneImportStep(
      { userId: run.userId, runId: run.runId },
      importDeps(client, { gmail }),
      // The pacer's wait is the other place a worker loses time, and the fence
      // sits after it for exactly this reason. A budget of one unit forces the
      // wait deterministically, and the lifecycle change happens inside it.
      new (await import("@/lib/gmail/import/worker.server")).QuotaPacer(
        () => Date.now(),
        async () => {
          await setConnectionState(client, run.mailAccountId, "disconnected");
        },
        1,
      ),
    );

    expect(gmail.calls.listMessagesCalls).toBe(0);
    expect(outcome).toEqual({ result: "cancelled", connectionState: "disconnected" });
  });

  it("A6. nothing changed: the fence passes and exactly one call is made", async () => {
    const run = await startRun("a2-a6-healthy");
    const gmail = createFakeGmailRead({ pages: [page] });

    const outcome = await runOneImportStep(
      { userId: run.userId, runId: run.runId },
      importDeps(client, { gmail }),
    );

    expect(outcome).toEqual({ result: "progressed", step: "enumerate_page" });
    expect(gmail.calls.listMessagesCalls).toBe(1);
    expect((await threadRows(client, run.runId)).map((r) => r.provider_thread_id)).toEqual(["t1"]);
  });

  it("A7. a Disconnect AFTER the fence is the in-flight case: read happens, nothing is stored", async () => {
    const run = await startRun("a2-a7-inflight");
    const gmail = createFakeGmailRead({
      pages: [{ candidates: [{ messageId: "m1", threadId: "t1" }], nextPageToken: null }],
      threads: {
        t1: thread("t1", [textMessage({ id: "m1", threadId: "t1", internalDateMs: inWindow() })]),
      },
      // The mailbox is disconnected while the request is genuinely on the wire.
      onList: async () => {
        await setConnectionState(client, run.mailAccountId, "disconnected");
      },
    });

    const outcome = await runOneImportStep(
      { userId: run.userId, runId: run.runId },
      importDeps(client, { gmail }),
    );

    // THIS is the honest boundary. Before the fence, a cancellation prevents the
    // read. After it, PostgreSQL cannot recall a request already sent — so the
    // guarantee narrows to the one that is true: the result is not persisted.
    expect(gmail.calls.listMessagesCalls).toBe(1);
    expect(outcome.result).not.toBe("progressed");
    expect(await threadRows(client, run.runId)).toHaveLength(0);
    expect(await rawMessages(client, run.mailAccountId)).toHaveLength(0);
    expect((await runRow(client, run.runId)).candidate_sent_messages_seen).toBe(0);
  });

  it("the validator refuses a claim whose step or thread does not match", async () => {
    const run = await startRun("a2-validate-binding");
    const db = rpc(client);
    const claimed = (
      await db.rpc("gmail_historical_import_claim_step", {
        p_user_id: run.userId,
        p_run_id: run.runId,
        p_lease_seconds: 300,
      })
    ).data as { lease_token: string; authorization_revision: number };

    const call = (step: string, threadId: string | null) =>
      db.rpc("gmail_historical_import_validate_claim", {
        p_user_id: run.userId,
        p_run_id: run.runId,
        p_lease_token: claimed.lease_token,
        p_expected_authorization_revision: claimed.authorization_revision,
        p_expected_step: step,
        p_expected_provider_thread_id: threadId,
      });

    expect(((await call("enumerate_page", null)).data as { result: string }).result).toBe("ok");
    // An enumeration lease does not name a thread…
    expect(((await call("enumerate_page", "t1")).data as { result: string }).result).toBe(
      "stale_lease",
    );
    // …and it is not a thread lease.
    expect(((await call("fetch_thread", "t1")).data as { result: string }).result).toBe(
      "stale_lease",
    );
    // A wildcard revision is refused here exactly as it is at commit time.
    const wildcard = await db.rpc("gmail_historical_import_validate_claim", {
      p_user_id: run.userId,
      p_run_id: run.runId,
      p_lease_token: claimed.lease_token,
      p_expected_authorization_revision: null,
      p_expected_step: "enumerate_page",
      p_expected_provider_thread_id: null,
    });
    expect((wildcard.data as { result: string }).result).toBe("authorization_revision_required");

    // And a stranger cannot validate somebody else's claim into existence.
    const stranger = await connectedMailbox(client, "a2-validate-stranger");
    const foreign = await db.rpc("gmail_historical_import_validate_claim", {
      p_user_id: stranger.userId,
      p_run_id: run.runId,
      p_lease_token: claimed.lease_token,
      p_expected_authorization_revision: claimed.authorization_revision,
      p_expected_step: "enumerate_page",
      p_expected_provider_thread_id: null,
    });
    expect((foreign.data as { result: string }).result).toBe("not_found");
  });
});

// ===========================================================================
// B. STRICT PROVIDER SHAPE
// ===========================================================================

describe("B. messages.list is validated at runtime, not cast", () => {
  async function listWith(body: unknown, ok = true) {
    const { gmailHistoricalReadAdapter } = await import("@/lib/gmail/import/read-adapter.server");
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({
        ok,
        status: ok ? 200 : 500,
        json: async () => {
          if (body === "INVALID_JSON") throw new SyntaxError("bad json");
          return body;
        },
      }) as unknown as Response) as typeof fetch;
    try {
      return await gmailHistoricalReadAdapter.listSentMessages({
        accessToken: "t",
        windowStartMs: 1_700_000_000_000,
        windowEndMs: 1_700_003_600_000,
        pageToken: null,
      });
    } finally {
      globalThis.fetch = original;
    }
  }

  const malformed = { reason: "malformed_response", retryable: false };

  it("B1. a top-level ARRAY is malformed, not an empty final page", async () => {
    // `typeof [] === "object"` is the whole defect: this used to read as
    // "enumeration finished, zero candidates", which is indistinguishable from
    // a creator who sent nothing.
    await expect(listWith([])).rejects.toMatchObject(malformed);
    await expect(listWith([{ id: "a", threadId: "t" }])).rejects.toMatchObject(malformed);
  });

  it("B2. a top-level string, number or null is malformed", async () => {
    await expect(listWith("string")).rejects.toMatchObject(malformed);
    await expect(listWith(42)).rejects.toMatchObject(malformed);
    await expect(listWith(null)).rejects.toMatchObject(malformed);
    await expect(listWith("INVALID_JSON")).rejects.toMatchObject(malformed);
  });

  it("B3. `messages` present but not an array is malformed", async () => {
    await expect(listWith({ messages: {} })).rejects.toMatchObject(malformed);
    await expect(listWith({ messages: "none" })).rejects.toMatchObject(malformed);
    // ABSENT stays legitimate: Gmail omits the key on an empty page.
    await expect(listWith({})).resolves.toMatchObject({ candidates: [], nextPageToken: null });
  });

  it("B4. a null or non-object candidate is malformed", async () => {
    await expect(listWith({ messages: [null] })).rejects.toMatchObject(malformed);
    await expect(listWith({ messages: ["m1"] })).rejects.toMatchObject(malformed);
  });

  it("B5. a non-string candidate id is malformed", async () => {
    await expect(listWith({ messages: [{ id: 7, threadId: "t" }] })).rejects.toMatchObject(
      malformed,
    );
  });

  it("B6. an empty candidate threadId fails the WHOLE page", async () => {
    await expect(
      listWith({
        messages: [
          { id: "a", threadId: "t" },
          { id: "b", threadId: "  " },
        ],
      }),
    ).rejects.toMatchObject(malformed);
  });

  it("B7. a malformed nextPageToken is never read as `no more pages`", async () => {
    await expect(listWith({ messages: [], nextPageToken: 42 })).rejects.toMatchObject(malformed);
    await expect(listWith({ messages: [], nextPageToken: "" })).rejects.toMatchObject(malformed);
    await expect(listWith({ messages: [], nextPageToken: null })).rejects.toMatchObject(malformed);
  });
});

describe("B. threads.get and its MIME tree are validated at runtime", () => {
  const WINDOW = { startMs: 0, endMs: Date.now() + DAY };
  const ok = (over: Record<string, unknown> = {}) => ({
    id: "m",
    threadId: "t",
    labelIds: ["SENT"],
    internalDate: String(Date.now() - DAY),
    payload: { mimeType: "text/plain", body: { size: 1, data: "YQ" } },
    ...over,
  });
  const fails = (over: Record<string, unknown>) =>
    expect(() => sanitizeThread({ id: "t", messages: [ok(over)] }, WINDOW)).toThrow(
      /malformed_response/,
    );

  it("a thread that is not an object, or has no id, or no message list, is malformed", () => {
    for (const body of [null, [], "t", { messages: [] }, { id: "  ", messages: [] }, { id: "t" }]) {
      expect(() => sanitizeThread(body as never, WINDOW)).toThrow(/malformed_response/);
    }
  });

  it("a message claiming a different thread is malformed", () => {
    fails({ threadId: "other" });
  });

  it("empty, whitespace and non-numeric internalDate are malformed, not epoch 0", () => {
    // `Number("")`, `Number("   ")` and `Number(null)` are all 0, so this used to
    // date a message to 1 January 1970 and store it.
    for (const value of ["", "   ", "yesterday", null, 1_700_000_000_000, "12.5", "1e3"]) {
      fails({ internalDate: value });
    }
    expect(parseInternalDateMs("1700000000000")).toBe(1_700_000_000_000);
    expect(parseInternalDateMs("")).toBeNull();
    expect(parseInternalDateMs(" ")).toBeNull();
    expect(parseInternalDateMs(null)).toBeNull();
    expect(parseInternalDateMs("99999999999999999999")).toBeNull();
  });

  it("malformed labelIds, historyId, sizeEstimate and payload are malformed", () => {
    fails({ labelIds: "SENT" });
    fails({ labelIds: [1] });
    fails({ historyId: 7 });
    fails({ sizeEstimate: "big" });
    fails({ sizeEstimate: Number.NaN });
    fails({ payload: null });
    fails({ payload: [] });
    fails({ payload: "text" });
  });

  it("a malformed MIME node anywhere in the tree is malformed", () => {
    fails({ payload: { mimeType: 7 } });
    fails({ payload: { mimeType: "text/plain", filename: 7 } });
    fails({ payload: { mimeType: "text/plain", headers: {} } });
    fails({ payload: { mimeType: "text/plain", headers: [{ name: "a" }] } });
    fails({ payload: { mimeType: "text/plain", headers: [{ name: "a", value: 7 }] } });
    fails({ payload: { mimeType: "text/plain", body: [] } });
    fails({ payload: { mimeType: "text/plain", body: { data: 7 } } });
    fails({ payload: { mimeType: "text/plain", body: { size: "1" } } });
    fails({ payload: { mimeType: "text/plain", body: { attachmentId: 7 } } });
    fails({ payload: { mimeType: "multipart/mixed", parts: {} } });
    fails({ payload: { mimeType: "multipart/mixed", parts: [{ mimeType: 7 }] } });
    // Nested, so the recursion is doing the work.
    fails({
      payload: {
        mimeType: "multipart/mixed",
        parts: [{ mimeType: "multipart/alternative", parts: [{ body: { data: 7 } }] }],
      },
    });
  });

  it("a DRAFT is dropped before its content is looked at", () => {
    // Nothing about a draft is stored, so nothing about it can be malformed —
    // but its LABELS must still be a real list, or we cannot know it is a draft.
    const result = sanitizeThread(
      { id: "t", messages: [{ labelIds: ["DRAFT"], internalDate: "", payload: 7 } as never] },
      WINDOW,
    );
    expect(result.draftsDropped).toBe(1);
    expect(result.messages).toHaveLength(0);

    expect(() =>
      sanitizeThread({ id: "t", messages: [{ labelIds: "DRAFT" } as never] }, WINDOW),
    ).toThrow(/malformed_response/);
  });

  it("nothing malformed is ever coerced into a plausible value", () => {
    const good = sanitizeThread({ id: "t", messages: [ok()] }, WINDOW);
    expect(good.messages).toHaveLength(1);
    expect(good.messages[0]!.internalDateMs).toBeGreaterThan(0);
  });
});

d("B. a malformed provider answer never completes a run", () => {
  it("the work item fails and the run does not say `completed`", async () => {
    const run = await startRun("a2-b-malformed-run");
    const gmail = createFakeGmailRead({
      pages: [{ candidates: [{ messageId: "m1", threadId: "t1" }], nextPageToken: null }],
      threads: {
        // A thread whose message list is not a list at all.
        t1: { id: "t1", messages: {} as never },
      },
    });
    const deps = importDeps(client, { gmail });

    // Enumerate, then fetch. The fetch is permanently malformed, so the second
    // step is where both the work item and the run go terminal — together.
    await runOneImportStep({ userId: run.userId, runId: run.runId }, deps);
    await runOneImportStep({ userId: run.userId, runId: run.runId }, deps);

    expect(await rawMessages(client, run.mailAccountId)).toHaveLength(0);
    const rows = await threadRows(client, run.runId);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].last_error_code).toBe("malformed_response");
    expect((await runRow(client, run.runId)).status).toBe("failed");
  });
});

// ===========================================================================
// C. RFC 2231 EXTENDED AND CONTINUED FILENAMES
// ===========================================================================

describe("C. every RFC 2231 name form is a filename", () => {
  const named = (headers: { name: string; value: string }[]) =>
    sanitizeMessage({
      id: "m",
      threadId: "t",
      labelIds: ["SENT"],
      internalDate: String(Date.now() - DAY),
      payload: {
        mimeType: "multipart/mixed",
        headers: [{ name: "Subject", value: "s" }],
        parts: [
          {
            mimeType: "text/plain",
            // Gmail did not duplicate the name here — which is exactly the case
            // the extended forms turn up in.
            filename: "",
            headers,
            body: { size: 3, data: "YWJj" },
          },
        ],
      },
    })!;

  for (const [label, headers] of [
    [
      "extended Content-Disposition",
      [{ name: "Content-Disposition", value: "inline; filename*=UTF-8''private-name.txt" }],
    ],
    [
      "continued+encoded Content-Disposition",
      [
        {
          name: "Content-Disposition",
          value: "attachment; filename*0*=UTF-8''private-; filename*1*=name.txt",
        },
      ],
    ],
    [
      "plain continuation",
      [
        {
          name: "Content-Disposition",
          value: 'inline; filename*0="private-"; filename*1="name.txt"',
        },
      ],
    ],
    [
      "high continuation index",
      [{ name: "Content-Disposition", value: "inline; filename*12*=UTF-8''private-name.txt" }],
    ],
    [
      "extended Content-Type name",
      [{ name: "Content-Type", value: "text/plain; name*=UTF-8''private-name.txt" }],
    ],
    [
      "mixed casing and whitespace",
      [
        {
          name: "Content-Disposition",
          value: "  INLINE ;  FILENAME*0*  = UTF-8''private-name.txt",
        },
      ],
    ],
  ] as const) {
    it(`${label}: no filename and no body survive`, () => {
      const sanitized = named([...headers]);
      const json = JSON.stringify(sanitized.message);
      expect(json).not.toContain("private-");
      expect(json).not.toContain("name.txt");
      expect(json).not.toContain("YWJj");
      expect(sanitized.message.payload.parts![0]!.contentOmitted).toBe(true);
      expect(sanitized.attachmentOrNonTextOmitted).toBe(1);
    });
  }

  it("`boundary=` is structure and is unaffected", () => {
    expect(hasMimeNameParameter("multipart/mixed; boundary=--x--")).toBe(false);
    expect(hasMimeNameParameter('multipart/alternative; boundary="000abc"')).toBe(false);
    expect(hasMimeNameParameter("text/plain; charset=UTF-8")).toBe(false);
    expect(hasMimeNameParameter("inline")).toBe(false);
    expect(hasMimeNameParameter(undefined)).toBe(false);

    const kept = sanitizeMessage({
      id: "m",
      threadId: "t",
      labelIds: ["SENT"],
      internalDate: String(Date.now() - DAY),
      payload: {
        mimeType: "multipart/mixed",
        headers: [{ name: "Content-Type", value: "multipart/mixed; boundary=--x--" }],
        parts: [],
      },
    })!;
    expect(headerValue(kept.message.payload.headers, "content-type")).toBe(
      "multipart/mixed; boundary=--x--",
    );
  });

  it("the attribute forms are recognised, and lookalikes are not", () => {
    for (const value of [
      "inline; filename=x",
      "inline; filename*=UTF-8''x",
      "inline; filename*0=x",
      "inline; filename*0*=UTF-8''x",
      "inline; filename*7*=x",
      "text/plain; name=x",
      "text/plain; NAME*=UTF-8''x",
    ]) {
      expect([value, hasMimeNameParameter(value)]).toEqual([value, true]);
    }
    for (const value of [
      "multipart/mixed; boundary=x",
      "text/plain; charset=x",
      "attachment; size=100",
      "inline; creation-date=x",
    ]) {
      expect([value, hasMimeNameParameter(value)]).toEqual([value, false]);
    }
  });
});

// ===========================================================================
// D. REPEATED APPROVED HEADERS SURVIVE
// ===========================================================================

describe("D. B03 does not choose which occurrence is the real one", () => {
  it("two `To` occurrences both survive, in provider order", () => {
    const sanitized = sanitizeMessage({
      id: "m",
      threadId: "t",
      labelIds: ["SENT"],
      internalDate: String(Date.now() - DAY),
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "To", value: "first@example.invalid" },
          { name: "Subject", value: "Two recipients lines" },
          { name: "To", value: "second@example.invalid" },
        ],
        body: { size: 1, data: "YQ" },
      },
    })!;

    // A Record<string,string> could hold one of these, and B03 silently chose
    // the last. RFC 5322 permits repeated destination fields in historical mail,
    // and deciding between them is interpretation — B04's job, and impossible
    // for B04 once B03 has thrown one away.
    expect(headerValues(sanitized.message.messageHeaders, "to")).toEqual([
      "first@example.invalid",
      "second@example.invalid",
    ]);
    // Not concatenated, not deduplicated, not reordered.
    expect(sanitized.message.messageHeaders.map((h) => h.name)).toEqual(["to", "subject", "to"]);
    const json = JSON.stringify(sanitized.message);
    expect(json).toContain("first@example.invalid");
    expect(json).toContain("second@example.invalid");
  });

  it("repeated structural part headers survive too", () => {
    const sanitized = sanitizeMessage({
      id: "m",
      threadId: "t",
      labelIds: ["SENT"],
      internalDate: String(Date.now() - DAY),
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "Content-Type", value: "text/plain; charset=UTF-8" },
          { name: "Content-Type", value: "text/plain; charset=ISO-8859-1" },
        ],
        body: { size: 1, data: "YQ" },
      },
    })!;
    expect(headerValues(sanitized.message.payload.headers, "content-type")).toEqual([
      "text/plain; charset=UTF-8",
      "text/plain; charset=ISO-8859-1",
    ]);
  });

  it("the names are normalised and the values are untouched", () => {
    const sanitized = sanitizeMessage({
      id: "m",
      threadId: "t",
      labelIds: ["SENT"],
      internalDate: String(Date.now() - DAY),
      payload: {
        mimeType: "text/plain",
        headers: [{ name: "SuBjEcT", value: "  Spaced   Value  " }],
        body: { size: 1, data: "YQ" },
      },
    })!;
    expect(sanitized.message.messageHeaders).toEqual([
      { name: "subject", value: "  Spaced   Value  " },
    ]);
  });
});

d("D. the stored payload keeps every occurrence", () => {
  it("both `To` lines reach the database", async () => {
    const run = await startRun("a2-d-storage");
    const at = inWindow();
    const gmail = createFakeGmailRead({
      pages: [{ candidates: [{ messageId: "m1", threadId: "t1" }], nextPageToken: null }],
      threads: {
        t1: {
          id: "t1",
          messages: [
            {
              id: "m1",
              threadId: "t1",
              labelIds: ["SENT"],
              internalDate: String(at),
              payload: {
                mimeType: "text/plain",
                headers: [
                  { name: "To", value: "first@example.invalid" },
                  { name: "To", value: "second@example.invalid" },
                  { name: "Subject", value: "s" },
                ],
                body: { size: 1, data: "YQ" },
              },
            },
          ],
        },
      },
    });
    const deps = importDeps(client, { gmail });
    await runOneImportStep({ userId: run.userId, runId: run.runId }, deps);
    await runOneImportStep({ userId: run.userId, runId: run.runId }, deps);

    const rows = await rawMessages(client, run.mailAccountId);
    expect(rows).toHaveLength(1);
    const stored = rows[0].sanitized_payload as {
      message_headers: { name: string; value: string }[];
    };
    expect(stored.message_headers.filter((h) => h.name === "to").map((h) => h.value)).toEqual([
      "first@example.invalid",
      "second@example.invalid",
    ]);
  });
});
