import { randomBytes } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  completeGmailAuthorization,
  disconnectGmailAccount,
  grantPrivateProcessingConsent,
  startGmailAuthorization,
  type GmailDeps,
} from "@/lib/gmail/connection.server";
import { resetGmailOAuthConfigCache } from "@/lib/gmail/env.server";
import { GoogleAdapterError } from "@/lib/gmail/google.server";
import { disconnectNoticeFor } from "@/lib/gmail/panel-actions";

import {
  createFakeGoogle,
  createFakeGoogleProject,
  type FakeGoogleOptions,
  type FakeGoogleProject,
} from "./fake-google";
import { countCredentials, createRpcClient, createTestUser, readMailAccount } from "./rpc-harness";

/**
 * B02 EXTERNAL AUDIT AMENDMENT #7.
 *
 * `gmail_disconnect_prepare` and `gmail_disconnect_finalize` are separate
 * transactions with a Google round-trip between them, and amendment #6 made that
 * window one in which the credential can legitimately CHANGE: a superseded OAuth
 * callback replaces the stored token with the FRESH one representing a newer
 * grant, precisely so that grant can still be revoked.
 *
 * Finalize checked only `connection_state = 'disconnecting'`, so an older
 * finalizer could delete a credential it had never revoked:
 *
 *   prepare loads R1/G1
 *   -> superseded callback stores R2/G2; its own revoke fails transiently
 *   -> revoke(R1) returns invalid_token — true of R1, and no evidence about R2
 *   -> finalize deletes R2 and writes `disconnected`
 *
 *   LOCAL disconnected · CREDENTIAL none · GOOGLE grant from R2 ACTIVE
 *   · RETRY impossible
 *
 * Finalization is now a compare-and-swap on two facts the caller must carry
 * across the network call: WHICH Disconnect it prepared under, and WHICH
 * credential generation it actually sent to Google.
 */

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_DB);

interface FakeAdminClient {
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>;
}

let client: Client;
let realDb: { rpc: (name: string, args: Record<string, unknown>) => Promise<unknown> };
let deps: (google: ReturnType<typeof createFakeGoogle>, db?: FakeAdminClient) => GmailDeps;

beforeAll(async () => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-client-secret";
  process.env.GOOGLE_OAUTH_REDIRECT_URI =
    "https://example.invalid/api/integrations/gmail/oauth/callback";
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY_V1 = randomBytes(32).toString("base64");
  resetGmailOAuthConfigCache();

  if (!TEST_DB) return;
  client = new Client({ connectionString: TEST_DB });
  await client.connect();
  realDb = createRpcClient(client) as unknown as typeof realDb;
  deps = (google, db) => ({ google, db: (db ?? realDb) as unknown as GmailDeps["db"] });
});

afterAll(async () => {
  if (client) await client.end();
});

async function beginAuthorization(
  userId: string,
  options: FakeGoogleOptions,
  overrides: { purpose?: "connect" | "reconnect"; targetMailAccountId?: string | null } = {},
) {
  const google = createFakeGoogle(options);
  const started = await startGmailAuthorization(
    {
      userId,
      purpose: overrides.purpose ?? "connect",
      targetMailAccountId: overrides.targetMailAccountId ?? null,
      returnPath: "/app/account",
    },
    deps(google),
  );
  const state =
    started.result === "ok" ? new URL(started.authorizationUrl).searchParams.get("state") : null;
  return { started, google, state };
}

const finish = (
  userId: string,
  google: ReturnType<typeof createFakeGoogle>,
  state: string,
  db?: FakeAdminClient,
) =>
  completeGmailAuthorization({ userId, state, code: "auth-code", error: null }, deps(google, db));

const stateOf = async (id: string) => (await readMailAccount(client, id)).connection_state;

async function generationOf(mailAccountId: string): Promise<string | null> {
  const res = await client.query(
    "select credential_generation as g from private.gmail_oauth_credentials where mail_account_id = $1",
    [mailAccountId],
  );
  return res.rows[0] ? String(res.rows[0].g) : null;
}

async function intentSeqOf(mailAccountId: string): Promise<string | null> {
  const res = await client.query(
    "select disconnect_intent_seq as s from public.mail_accounts where id = $1",
    [mailAccountId],
  );
  return res.rows[0].s === null ? null : String(res.rows[0].s);
}

/**
 * A mailbox in `consent_required`: reconnectable AND holding a credential, so a
 * Disconnect really loads one and really calls Google, and a reconnect flow can
 * still be started against it.
 */
async function authorizedMailbox(project: FakeGoogleProject, label: string) {
  const userId = await createTestUser(client, label);
  const subject = `sub-${randomBytes(8).toString("hex")}`;
  const begun = await beginAuthorization(userId, { project, subject });
  const outcome = await finish(userId, begun.google, begun.state!);
  const mailAccountId = (outcome as { mailAccountId: string }).mailAccountId;
  return { userId, mailAccountId, subject };
}

/** A Google fake whose `revoke` blocks until the test releases it. */
function gatedGoogle(options: FakeGoogleOptions) {
  const google = createFakeGoogle(options);
  let reached: () => void = () => {};
  const atRevoke = new Promise<void>((r) => (reached = r));
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const original = google.revoke.bind(google);
  google.revoke = async (args) => {
    reached();
    await gate;
    return original(args);
  };
  return { google, atRevoke, release: () => release() };
}

/**
 * Run the whole race: a Disconnect that stalls inside its Google revoke, with a
 * superseded callback landing in the gap.
 */
async function raceDisconnectAgainstSupersededCallback(
  label: string,
  options: {
    /** What Google does with the Disconnect's revoke of the OLD token. */
    disconnectRevoke?: GoogleAdapterError | null;
    /** What Google does with the callback's revoke of the FRESH token. */
    callbackRevoke?: GoogleAdapterError | null;
  } = {},
) {
  const project = createFakeGoogleProject();
  const { userId, mailAccountId, subject } = await authorizedMailbox(project, label);

  const stale = await beginAuthorization(
    userId,
    {
      project,
      subject,
      ...(options.callbackRevoke ? { revokeError: options.callbackRevoke } : {}),
    },
    { purpose: "reconnect", targetMailAccountId: mailAccountId },
  );

  const generationBefore = await generationOf(mailAccountId);
  const gated = gatedGoogle({
    project,
    subject,
    ...(options.disconnectRevoke ? { revokeError: options.disconnectRevoke } : {}),
  });

  // The callback has ALREADY consumed its transaction — that is what makes it
  // reach persist — so the Disconnect starts as persist is entered. Cancellation
  // cannot help with this ordering; only the CAS can.
  let disconnect: Promise<{ result: string }> | null = null;
  let fired = false;
  const racing: FakeAdminClient = {
    async rpc(name, args) {
      if (name === "gmail_connection_persist" && !fired) {
        fired = true;
        disconnect = disconnectGmailAccount({ userId, mailAccountId }, deps(gated.google));
        await gated.atRevoke;
      }
      return realDb.rpc(name, args);
    },
  };

  const callbackOutcome = await finish(userId, stale.google, stale.state!, racing);
  const generationAfterCallback = await generationOf(mailAccountId);

  gated.release();
  const disconnectOutcome = await disconnect!;

  return {
    project,
    userId,
    mailAccountId,
    subject,
    stale,
    generationBefore,
    generationAfterCallback,
    callbackOutcome,
    disconnectOutcome,
  };
}

d("amendment #7 — Disconnect is a compare-and-swap across its network gap", () => {
  it("A. nothing changed during the gap, so finalization succeeds", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await authorizedMailbox(project, "a7-A");

    const outcome = await disconnectGmailAccount(
      { userId, mailAccountId },
      deps(createFakeGoogle({ project, subject })),
    );

    expect(outcome.result).toBe("disconnected");
    expect(await stateOf(mailAccountId)).toBe("disconnected");
    expect(await countCredentials(client, mailAccountId)).toBe(0);
    expect(project.isSubjectAuthorized(subject)).toBe(false);
  });

  it("B. a fresher credential appeared, so the old finalizer refuses", async () => {
    const race = await raceDisconnectAgainstSupersededCallback("a7-B", {
      callbackRevoke: new GoogleAdapterError("backend_error", false),
    });

    // The callback stored a DIFFERENT generation than the Disconnect loaded.
    expect(race.generationAfterCallback).not.toBe(race.generationBefore);
    expect(race.callbackOutcome.result).toBe("disconnect_incomplete");

    // The Disconnect revoked the OLD token successfully and still may not close
    // the mailbox: the material on the row is not the material it revoked.
    expect(race.disconnectOutcome.result).toBe("provider_unavailable");
    expect(await stateOf(race.mailAccountId)).toBe("disconnecting");
    expect(await countCredentials(client, race.mailAccountId)).toBe(1);
    expect(await generationOf(race.mailAccountId)).toBe(race.generationAfterCallback);
  });

  it("C. ...and `invalid_token` on the OLD token does not override the CAS", async () => {
    const race = await raceDisconnectAgainstSupersededCallback("a7-C", {
      disconnectRevoke: new GoogleAdapterError("invalid_token", true),
      callbackRevoke: new GoogleAdapterError("backend_error", false),
    });

    // `invalid_token` proves R1 is unusable. It is not evidence about R2, and
    // this is the variant in which the audited head lost R2 entirely while the
    // grant behind it stayed alive.
    expect(race.disconnectOutcome.result).toBe("provider_unavailable");
    expect(await stateOf(race.mailAccountId)).toBe("disconnecting");
    expect(await countCredentials(client, race.mailAccountId)).toBe(1);
    expect(await generationOf(race.mailAccountId)).toBe(race.generationAfterCallback);
    expect(race.project.isSubjectAuthorized(race.subject)).toBe(true);
  });

  it("D. the surviving material is a real retry, and the retry finishes the job", async () => {
    const race = await raceDisconnectAgainstSupersededCallback("a7-D", {
      disconnectRevoke: new GoogleAdapterError("invalid_token", true),
      callbackRevoke: new GoogleAdapterError("backend_error", false),
    });
    expect(race.project.isSubjectAuthorized(race.subject)).toBe(true);

    const retry = await disconnectGmailAccount(
      { userId: race.userId, mailAccountId: race.mailAccountId },
      deps(createFakeGoogle({ project: race.project, subject: race.subject })),
    );
    expect(retry.result).toBe("disconnected");
    expect(race.project.isSubjectAuthorized(race.subject)).toBe(false);
    expect(await stateOf(race.mailAccountId)).toBe("disconnected");
    expect(await countCredentials(client, race.mailAccountId)).toBe(0);
  });

  it("E. when the callback's own revoke succeeds, IT finalizes — under its own snapshot", async () => {
    const race = await raceDisconnectAgainstSupersededCallback("a7-E");

    // The callback revoked the grant it created and closed the mailbox itself.
    expect(race.callbackOutcome.result).toBe("state_changed");
    expect(race.project.isSubjectAuthorized(race.subject)).toBe(false);
    expect(await stateOf(race.mailAccountId)).toBe("disconnected");
    expect(await countCredentials(client, race.mailAccountId)).toBe(0);

    // The Disconnect arriving afterwards finds the job done. It must not claim
    // to have done it under a snapshot that no longer exists, but the mailbox IS
    // disconnected, which is what it asked for.
    expect(race.disconnectOutcome.result).toBe("disconnected");
  });

  it("F. a NO-CREDENTIAL prepare refuses to delete a credential that appeared since", async () => {
    // Direct SQL, because a Disconnect with nothing to revoke makes no network
    // call and therefore has no gap to race inside. The situation is still real:
    // the credential arrives from a superseded callback in another request, and
    // the question is only whether the NULL snapshot is honoured.
    const project = createFakeGoogleProject();
    const { userId, mailAccountId } = await authorizedMailbox(project, "a7-F");

    await client.query("begin");
    await client.query("delete from private.gmail_oauth_credentials where mail_account_id = $1", [
      mailAccountId,
    ]);
    await client.query(
      "update public.mail_accounts set connection_state = 'reauth_required' where id = $1",
      [mailAccountId],
    );
    await client.query("commit");

    const prepared = await client.query("select public.gmail_disconnect_prepare($1, $2) as r", [
      userId,
      mailAccountId,
    ]);
    const snapshot = prepared.rows[0].r as {
      has_credential: boolean;
      disconnect_intent_seq: string;
      credential_generation: string | null;
    };
    // The NULL is the fact this test is about: there was nothing to revoke.
    expect(snapshot.has_credential).toBe(false);
    expect(snapshot.credential_generation).toBeNull();

    // A superseded callback stores the fresh token it just obtained.
    await client.query(
      `insert into private.gmail_oauth_credentials
         (mail_account_id, user_id, refresh_token_ciphertext, refresh_token_iv,
          refresh_token_auth_tag, encryption_key_version)
       values ($1, $2, 'FRESH-CT', 'iv', 'tag', 'v1')`,
      [mailAccountId, userId],
    );
    const appeared = await generationOf(mailAccountId);

    const refused = await client.query(
      "select public.gmail_disconnect_finalize($1, $2, $3::bigint, null::bigint) as r",
      [userId, mailAccountId, snapshot.disconnect_intent_seq],
    );
    expect(refused.rows[0].r).toMatchObject({ result: "newer_revocation_material" });

    // The new credential survives, and the mailbox does not claim completion.
    expect(await generationOf(mailAccountId)).toBe(appeared);
    expect(await countCredentials(client, mailAccountId)).toBe(1);
    expect(await stateOf(mailAccountId)).toBe("disconnecting");
  });
});

d("amendment #7 — an older Disconnect cannot finalize a newer one", () => {
  it("G/H. two real sessions: D1's finalize is stale, D2 completes the job", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await authorizedMailbox(project, "a7-G");

    // D1 prepares and stalls at Google.
    const d1 = gatedGoogle({ project, subject });
    const first = disconnectGmailAccount({ userId, mailAccountId }, deps(d1.google));
    await d1.atRevoke;
    const intentOne = await intentSeqOf(mailAccountId);

    // The human presses Disconnect again. D2 prepares a NEWER intent and, with
    // its own revoke succeeding, completes.
    const second = await disconnectGmailAccount(
      { userId, mailAccountId },
      deps(createFakeGoogle({ project, subject })),
    );
    expect(second.result).toBe("disconnected");
    const intentTwo = await intentSeqOf(mailAccountId);
    expect(Number(intentTwo)).toBeGreaterThan(Number(intentOne));

    // D1's provider call returns last. It must not be authoritative.
    d1.release();
    const firstOutcome = await first;

    // The mailbox is disconnected because D2 disconnected it, and D1 did not
    // reopen, re-close or otherwise rewrite anything.
    expect(await stateOf(mailAccountId)).toBe("disconnected");
    expect(await countCredentials(client, mailAccountId)).toBe(0);
    expect(["disconnected", "provider_unavailable"]).toContain(firstOutcome.result);
  });

  it("G2. the stale intent is refused by the RPC itself, on a live `disconnecting` row", async () => {
    // Direct SQL, so the refusal is observed at the boundary rather than inferred
    // from an outcome the application chose.
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await authorizedMailbox(project, "a7-G2");

    const prepared = await client.query("select public.gmail_disconnect_prepare($1, $2) as r", [
      userId,
      mailAccountId,
    ]);
    const snapshot = prepared.rows[0].r as {
      disconnect_intent_seq: string;
      credential_generation: string;
    };

    // A second Disconnect records a newer intent, and leaves the row live.
    await client.query("select public.gmail_disconnect_prepare($1, $2)", [userId, mailAccountId]);
    expect(await stateOf(mailAccountId)).toBe("disconnecting");

    const stale = await client.query(
      "select public.gmail_disconnect_finalize($1, $2, $3::bigint, $4::bigint) as r",
      [userId, mailAccountId, snapshot.disconnect_intent_seq, snapshot.credential_generation],
    );
    expect(stale.rows[0].r).toMatchObject({
      result: "stale_disconnect_intent",
      connection_state: "disconnecting",
    });
    expect(await countCredentials(client, mailAccountId)).toBe(1);
    expect(await stateOf(mailAccountId)).toBe("disconnecting");
    expect(project.isSubjectAuthorized(subject)).toBe(true);
  });

  it("I. a finalizer can never delete a generation it did not load", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId } = await authorizedMailbox(project, "a7-I");

    const prepared = await client.query("select public.gmail_disconnect_prepare($1, $2) as r", [
      userId,
      mailAccountId,
    ]);
    const snapshot = prepared.rows[0].r as {
      disconnect_intent_seq: string;
      credential_generation: string;
    };

    // Rotate the stored credential the way a superseded callback would: replace
    // the row, drawing a new generation from the never-reissuing sequence.
    await client.query("delete from private.gmail_oauth_credentials where mail_account_id = $1", [
      mailAccountId,
    ]);
    await client.query(
      `insert into private.gmail_oauth_credentials
         (mail_account_id, user_id, refresh_token_ciphertext, refresh_token_iv,
          refresh_token_auth_tag, encryption_key_version)
       values ($1, $2, 'FRESH-CT', 'iv', 'tag', 'v1')`,
      [mailAccountId, userId],
    );
    const fresh = await generationOf(mailAccountId);
    expect(fresh).not.toBe(snapshot.credential_generation);

    const refused = await client.query(
      "select public.gmail_disconnect_finalize($1, $2, $3::bigint, $4::bigint) as r",
      [userId, mailAccountId, snapshot.disconnect_intent_seq, snapshot.credential_generation],
    );
    expect(refused.rows[0].r).toMatchObject({ result: "newer_revocation_material" });
    expect(await generationOf(mailAccountId)).toBe(fresh);
    expect(await stateOf(mailAccountId)).toBe("disconnecting");

    // The finalizer that DID load this generation succeeds.
    const ok = await client.query(
      "select public.gmail_disconnect_finalize($1, $2, $3::bigint, $4::bigint) as r",
      [userId, mailAccountId, snapshot.disconnect_intent_seq, fresh],
    );
    expect(ok.rows[0].r).toMatchObject({ result: "ok" });
    expect(await stateOf(mailAccountId)).toBe("disconnected");
    expect(await countCredentials(client, mailAccountId)).toBe(0);
  });

  it("J. a successful Reconnect cannot be destroyed by a late finalizer", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await authorizedMailbox(project, "a7-J");

    const prepared = await client.query("select public.gmail_disconnect_prepare($1, $2) as r", [
      userId,
      mailAccountId,
    ]);
    const snapshot = prepared.rows[0].r as {
      disconnect_intent_seq: string;
      credential_generation: string;
    };

    // The Disconnect completes, and the human then reconnects properly.
    await client.query("select public.gmail_disconnect_finalize($1, $2, $3::bigint, $4::bigint)", [
      userId,
      mailAccountId,
      snapshot.disconnect_intent_seq,
      snapshot.credential_generation,
    ]);
    const reconnect = await beginAuthorization(
      userId,
      { project, subject },
      { purpose: "reconnect", targetMailAccountId: mailAccountId },
    );
    const reconnected = await finish(userId, reconnect.google, reconnect.state!);
    expect(reconnected.result).toBe("consent_required");
    expect(await countCredentials(client, mailAccountId)).toBe(1);

    // A late finalizer from the OLD Disconnect arrives.
    const late = await client.query(
      "select public.gmail_disconnect_finalize($1, $2, $3::bigint, $4::bigint) as r",
      [userId, mailAccountId, snapshot.disconnect_intent_seq, snapshot.credential_generation],
    );
    expect(late.rows[0].r).toMatchObject({ result: "prepare_required" });
    expect(await stateOf(mailAccountId)).toBe("consent_required");
    expect(await countCredentials(client, mailAccountId)).toBe(1);
    expect(project.isSubjectAuthorized(subject)).toBe(true);
  });
});

d("amendment #7 — the finalize surface cannot be called without its snapshot", () => {
  it("the two-argument finalizer does not exist", async () => {
    await expect(
      client.query("select public.gmail_disconnect_finalize($1, $2)", [
        "00000000-0000-0000-0000-000000000000",
        "00000000-0000-0000-0000-000000000000",
      ]),
    ).rejects.toThrow(/does not exist/i);

    const signatures = await client.query(`
      select pg_get_function_identity_arguments(p.oid) as args
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'gmail_disconnect_finalize'
    `);
    expect(signatures.rows).toHaveLength(1);
    expect(signatures.rows[0].args).toContain("p_expected_disconnect_intent_seq");
    expect(signatures.rows[0].args).toContain("p_expected_credential_generation");
  });

  it("a NULL snapshot is refused rather than treated as a wildcard", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId } = await authorizedMailbox(project, "a7-null");
    await client.query("select public.gmail_disconnect_prepare($1, $2)", [userId, mailAccountId]);

    const refused = await client.query(
      "select public.gmail_disconnect_finalize($1, $2, null::bigint, null::bigint) as r",
      [userId, mailAccountId],
    );
    expect(refused.rows[0].r).toMatchObject({ result: "stale_disconnect_intent" });
    expect(await stateOf(mailAccountId)).toBe("disconnecting");
    expect(await countCredentials(client, mailAccountId)).toBe(1);
  });
});

describe("amendment #7 — what the account surface may say", () => {
  it("names the one outcome the mailbox state under-reports, and nothing else", () => {
    expect(disconnectNoticeFor("disconnect_incomplete")).toContain("not confirmed");
    for (const other of [null, undefined, "connected", "state_changed", "account_mismatch"]) {
      expect(disconnectNoticeFor(other)).toBeNull();
    }
  });
});
