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
import { B02_REQUESTED_SCOPES } from "@/lib/gmail/contract";
import { resetGmailOAuthConfigCache } from "@/lib/gmail/env.server";

import {
  createFakeGoogle,
  createFakeGoogleProject,
  type FakeGoogleOptions,
  type FakeGoogleProject,
} from "./fake-google";
import { countCredentials, createRpcClient, createTestUser, readMailAccount } from "./rpc-harness";

/**
 * B02 EXTERNAL AUDIT AMENDMENT #3.
 *
 * Amendment #2 gave the CREDENTIAL a generation, because a refresh spans a
 * network call. Authorization spans a far longer one — we hand the browser to
 * Google and the callback arrives whenever the human gets round to it — and it
 * had no such protection at all.
 *
 * So an intention could outlive the decision that replaced it:
 *
 *   1. mailbox A is `reauth_required`;
 *   2. the human starts Reconnect A;
 *   3. they change their mind and DISCONNECT A — revoked at Google, credential
 *      gone, state `disconnected`;
 *   4. the old callback lands. `disconnected` is reconnectable, so it stored a
 *      fresh credential and — the old consent still being on file for the same
 *      scope set — put the mailbox straight back to `connected`.
 *
 * The Disconnect was undone by a flow that predated it. These tests pin the
 * lifecycle revision instead of the state name, because a mailbox can leave a
 * reconnectable state and come back to one, and a stale callback would find the
 * word it expected while knowing nothing about what happened in between.
 */

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_DB);

let client: Client;
let deps: (google: ReturnType<typeof createFakeGoogle>) => GmailDeps;

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
  const db = createRpcClient(client);
  deps = (google) => ({ google, db: db as unknown as GmailDeps["db"] });
});

afterAll(async () => {
  if (client) await client.end();
});

/** Start a flow and hold its state, WITHOUT completing the callback. */
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

async function finish(userId: string, google: ReturnType<typeof createFakeGoogle>, state: string) {
  return completeGmailAuthorization(
    { userId, state, code: "auth-code", error: null },
    deps(google),
  );
}

async function authorize(
  userId: string,
  options: FakeGoogleOptions = {},
  overrides: { purpose?: "connect" | "reconnect"; targetMailAccountId?: string | null } = {},
) {
  const begun = await beginAuthorization(userId, options, overrides);
  if (!begun.state) return { ...begun, outcome: null };
  return { ...begun, outcome: await finish(userId, begun.google, begun.state) };
}

/** A fully connected mailbox inside a named Google authorization domain. */
async function connectedIn(project: FakeGoogleProject, label: string, subject?: string) {
  const userId = await createTestUser(client, label);
  const sub = subject ?? `sub-${randomBytes(8).toString("hex")}`;
  const { outcome } = await authorize(userId, { project, subject: sub });
  const mailAccountId = (outcome as { mailAccountId: string }).mailAccountId;
  await grantPrivateProcessingConsent({ userId, mailAccountId }, deps(createFakeGoogle()));
  return { userId, mailAccountId, subject: sub };
}

/** Let the stored token die, the legitimate route to a reconnectable mailbox. */
async function expireCredential(mailAccountId: string) {
  await client.query(
    `select public.gmail_mark_reauth_required($1, (select credential_generation
       from private.gmail_oauth_credentials where mail_account_id = $1))`,
    [mailAccountId],
  );
}

async function revisionOf(mailAccountId: string): Promise<number> {
  const res = await client.query(
    "select authorization_revision from public.mail_accounts where id = $1",
    [mailAccountId],
  );
  return Number(res.rows[0].authorization_revision);
}

d("amendment #3 — a newer lifecycle decision beats an older OAuth flow", () => {
  it("1/2/3. a reconnect completed against an unchanged mailbox succeeds", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "rev-ok");
    await expireCredential(mailAccountId);
    const pinned = await revisionOf(mailAccountId);

    const begun = await beginAuthorization(
      userId,
      { project, subject },
      { purpose: "reconnect", targetMailAccountId: mailAccountId },
    );
    expect(begun.started.result).toBe("ok");

    // Nothing happened in between.
    expect(await revisionOf(mailAccountId)).toBe(pinned);

    const outcome = await finish(userId, begun.google, begun.state!);
    expect(outcome.result).toBe("connected");
    expect(await countCredentials(client, mailAccountId)).toBe(1);
  });

  it("4/5/6. a Disconnect during the flow makes the callback stale", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "rev-stale");
    await expireCredential(mailAccountId);
    const pinned = await revisionOf(mailAccountId);

    // The human starts a reconnect and wanders off.
    const begun = await beginAuthorization(
      userId,
      { project, subject },
      { purpose: "reconnect", targetMailAccountId: mailAccountId },
    );
    expect(begun.started.result).toBe("ok");

    // Then changes their mind.
    const disconnected = await disconnectGmailAccount(
      { userId, mailAccountId },
      deps(createFakeGoogle({ project, subject })),
    );
    expect(disconnected.result).toBe("disconnected");
    expect(await revisionOf(mailAccountId)).toBeGreaterThan(pinned);

    // The old callback finally arrives.
    const outcome = await finish(userId, begun.google, begun.state!);

    // Amendment #3 refused this callback at `gmail_connection_persist`, AFTER
    // the code had been exchanged — which left a fresh live grant at Google that
    // nothing then removed (amendment #5, blocker A). Amendment #5 moved the
    // refusal earlier: Disconnect now CANCELS the mailbox's outstanding OAuth
    // transactions before it touches the network, so the callback's `state` no
    // longer resolves to anything and no code is ever exchanged.
    expect(outcome.result).toBe("invalid_state");
    expect(begun.google.calls.exchanges).toHaveLength(0);
    expect((await readMailAccount(client, mailAccountId)).connection_state).toBe("disconnected");
    expect(await countCredentials(client, mailAccountId)).toBe(0);
    // And the refusal does not revoke: that would be project-wide (amendment #2).
    // There is also nothing to revoke — a grant that was never created.
    expect(begun.google.calls.revocations).toHaveLength(0);
  });

  it("7/8/9. returning to the same state name does NOT make a stale callback current", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "rev-roundtrip");
    await expireCredential(mailAccountId);
    const pinned = await revisionOf(mailAccountId);
    expect((await readMailAccount(client, mailAccountId)).connection_state).toBe("reauth_required");

    const begun = await beginAuthorization(
      userId,
      { project, subject },
      { purpose: "reconnect", targetMailAccountId: mailAccountId },
    );
    expect(begun.started.result).toBe("ok");

    // reauth_required -> disconnected -> reauth_required. The STATE NAME the
    // callback expects is back; two decisions it knows nothing about are not.
    await disconnectGmailAccount(
      { userId, mailAccountId },
      deps(createFakeGoogle({ project, subject })),
    );
    await client.query(
      "update public.mail_accounts set connection_state='reauth_required' where id=$1",
      [mailAccountId],
    );
    expect((await readMailAccount(client, mailAccountId)).connection_state).toBe("reauth_required");
    expect(await revisionOf(mailAccountId)).toBeGreaterThan(pinned);

    const outcome = await finish(userId, begun.google, begun.state!);
    // This is why the revision matters and the state name does not. Since
    // amendment #5 the Disconnect in the middle also cancelled the transaction,
    // so the callback is refused one step earlier still — but the revision check
    // is what would have caught it, and it is still the only thing standing
    // between a stale callback and a lifecycle change made some other way:
    // amendment #4's serialized-race test drives that path with a direct SQL
    // UPDATE, which cancels nothing and still gets `state_changed`.
    expect(outcome.result).toBe("invalid_state");
    expect(begun.google.calls.exchanges).toHaveLength(0);
    expect(await countCredentials(client, mailAccountId)).toBe(0);
  });

  it("10. a reconnect cannot BEGIN against a connected mailbox", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "rev-connected");

    const begun = await beginAuthorization(
      userId,
      { project, subject },
      { purpose: "reconnect", targetMailAccountId: mailAccountId },
    );
    // Opening a flow against a working mailbox would be starting against a state
    // that does not exist yet, and hoping it arrives.
    expect(begun.started.result).toBe("not_reconnectable");
    expect((begun.started as { connectionState?: string }).connectionState).toBe("connected");

    const stored = await client.query(
      "select count(*)::int n from private.gmail_oauth_transactions where user_id=$1",
      [userId],
    );
    expect(stored.rows[0].n).toBe(0);
  });

  it("11. a reconnect cannot BEGIN against a retired mailbox", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "rev-deleted");
    await disconnectGmailAccount(
      { userId, mailAccountId },
      deps(createFakeGoogle({ project, subject })),
    );

    await client.query("begin");
    const req = await client.query(
      `insert into public.mail_account_deletion_requests
         (mail_account_id, user_id, scope, requested_by_user_id, requested_at)
       values ($1,$2,'account_and_gmail_derived_data',$2, now()) returning id`,
      [mailAccountId, userId],
    );
    await client.query(
      `update public.mail_accounts set connection_state='deletion_pending',
          current_deletion_request_id=$2 where id=$1`,
      [mailAccountId, req.rows[0].id],
    );
    await client.query(
      "update public.mail_account_deletion_requests set status='completed', completed_at=now() where id=$1",
      [req.rows[0].id],
    );
    await client.query("update public.mail_accounts set connection_state='deleted' where id=$1", [
      mailAccountId,
    ]);
    await client.query("commit");

    const begun = await beginAuthorization(
      userId,
      { project, subject },
      { purpose: "reconnect", targetMailAccountId: mailAccountId },
    );
    expect(begun.started.result).toBe("not_reconnectable");
    expect((begun.started as { connectionState?: string }).connectionState).toBe("deleted");
  });

  it("12/13. the transaction shape requires a revision iff it is a reconnect", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId } = await connectedIn(project, "rev-iff");
    await expireCredential(mailAccountId);

    // A reconnect row with no revision is refused by the database.
    await expect(
      client.query(
        `insert into private.gmail_oauth_transactions
           (user_id, state_digest, nonce_digest, code_verifier_ciphertext, code_verifier_iv,
            code_verifier_auth_tag, encryption_key_version, purpose, target_mail_account_id,
            target_authorization_revision, requested_scopes, expires_at)
         values ($1, repeat('a',64), repeat('b',64), 'ct','iv','tag','v1',
                 'reconnect', $2, null, $3::text[], now() + interval '10 minutes')`,
        [userId, mailAccountId, [...B02_REQUESTED_SCOPES]],
      ),
    ).rejects.toThrow(/purpose_target_iff/i);

    // ...and a connect row carrying one is refused too.
    await expect(
      client.query(
        `insert into private.gmail_oauth_transactions
           (user_id, state_digest, nonce_digest, code_verifier_ciphertext, code_verifier_iv,
            code_verifier_auth_tag, encryption_key_version, purpose, target_mail_account_id,
            target_authorization_revision, requested_scopes, expires_at)
         values ($1, repeat('c',64), repeat('d',64), 'ct','iv','tag','v1',
                 'connect', null, 1, $2::text[], now() + interval '10 minutes')`,
        [userId, [...B02_REQUESTED_SCOPES]],
      ),
    ).rejects.toThrow(/purpose_target_iff/i);

    // A real reconnect pins the revision the mailbox actually has.
    const begun = await beginAuthorization(
      userId,
      { project },
      { purpose: "reconnect", targetMailAccountId: mailAccountId },
    );
    expect(begun.started.result).toBe("ok");
    const stored = await client.query(
      `select target_authorization_revision from private.gmail_oauth_transactions
        where user_id=$1 order by created_at desc limit 1`,
      [userId],
    );
    expect(Number(stored.rows[0].target_authorization_revision)).toBe(
      await revisionOf(mailAccountId),
    );
  });

  it("14. a DIRECT SQL lifecycle change advances the revision", async () => {
    const project = createFakeGoogleProject();
    const { mailAccountId } = await connectedIn(project, "rev-directsql");
    const before = await revisionOf(mailAccountId);

    // Not through an RPC — the trigger is what makes a hand-written UPDATE
    // invalidate an in-flight OAuth flow exactly like a server action does.
    await client.query("begin");
    await client.query("delete from private.gmail_oauth_credentials where mail_account_id=$1", [
      mailAccountId,
    ]);
    await client.query(
      `update public.mail_accounts set connection_state='disconnected',
          disconnected_at=now(), granted_scopes='{}' where id=$1`,
      [mailAccountId],
    );
    await client.query("commit");
    expect(await revisionOf(mailAccountId)).toBeGreaterThan(before);
  });

  it("14b. the revision is not caller-settable, and unrelated metadata does not move it", async () => {
    const project = createFakeGoogleProject();
    const { mailAccountId } = await connectedIn(project, "rev-notsettable");
    const before = await revisionOf(mailAccountId);

    // A writer supplying their own value has it overwritten.
    await client.query("update public.mail_accounts set authorization_revision = 1 where id=$1", [
      mailAccountId,
    ]);
    expect(await revisionOf(mailAccountId)).toBe(before);

    // Display metadata is not a decision about access.
    await client.query(
      "update public.mail_accounts set email_address='renamed@example.invalid' where id=$1",
      [mailAccountId],
    );
    expect(await revisionOf(mailAccountId)).toBe(before);
  });

  it("15. rotating a credential does not touch the mailbox lifecycle revision", async () => {
    const project = createFakeGoogleProject();
    const { mailAccountId } = await connectedIn(project, "rev-rotation");
    const before = await revisionOf(mailAccountId);

    await client.query(
      `select public.gmail_credential_replace($1, (select credential_generation
         from private.gmail_oauth_credentials where mail_account_id=$1),
         'R2','iv','tag','v1', null)`,
      [mailAccountId],
    );

    // A rotation is not a lifecycle decision: the human authorized nothing new
    // and revoked nothing. Advancing the revision here would cancel in-flight
    // OAuth flows for no reason. The credential generation covers rotation; the
    // authorization revision covers the lifecycle. Two clocks, two questions.
    expect(await revisionOf(mailAccountId)).toBe(before);
  });
});

d("amendment #3 — a generic connect does not revive a live mailbox", () => {
  async function reconnectRequiredFor(
    state: "disconnected" | "reauth_required" | "consent_required",
  ) {
    const project = createFakeGoogleProject();
    const userId = await createTestUser(client, `generic-${state}`);
    const subject = `sub-${randomBytes(8).toString("hex")}`;

    const first = await authorize(userId, { project, subject });
    const mailAccountId = (first.outcome as { mailAccountId: string }).mailAccountId;

    if (state === "consent_required") {
      // Already there: a fresh authorization with no product consent yet.
    } else if (state === "reauth_required") {
      await grantPrivateProcessingConsent({ userId, mailAccountId }, deps(createFakeGoogle()));
      await expireCredential(mailAccountId);
    } else {
      await grantPrivateProcessingConsent({ userId, mailAccountId }, deps(createFakeGoogle()));
      await disconnectGmailAccount(
        { userId, mailAccountId },
        deps(createFakeGoogle({ project, subject })),
      );
    }
    expect((await readMailAccount(client, mailAccountId)).connection_state).toBe(state);

    const before = await countCredentials(client, mailAccountId);
    const generic = await authorize(userId, { project, subject });
    return { generic, mailAccountId, before, project, subject, userId };
  }

  it("16. a generic connect onto a disconnected mailbox asks for an explicit reconnect", async () => {
    const { generic, mailAccountId, before } = await reconnectRequiredFor("disconnected");
    expect(generic.outcome!.result).toBe("reconnect_required");
    expect((generic.outcome as { mailAccountId: string }).mailAccountId).toBe(mailAccountId);
    // NOTHING was persisted, and the newly issued grant was not revoked either.
    expect(await countCredentials(client, mailAccountId)).toBe(before);
    expect((await readMailAccount(client, mailAccountId)).connection_state).toBe("disconnected");
    expect(generic.google.calls.revocations).toHaveLength(0);
  });

  it("17. ...and onto a reauth_required mailbox", async () => {
    const { generic, mailAccountId } = await reconnectRequiredFor("reauth_required");
    expect(generic.outcome!.result).toBe("reconnect_required");
    expect(await countCredentials(client, mailAccountId)).toBe(0);
    expect((await readMailAccount(client, mailAccountId)).connection_state).toBe("reauth_required");
  });

  it("18. ...and onto a consent_required mailbox", async () => {
    const { generic, mailAccountId } = await reconnectRequiredFor("consent_required");
    expect(generic.outcome!.result).toBe("reconnect_required");
    expect((await readMailAccount(client, mailAccountId)).connection_state).toBe(
      "consent_required",
    );
  });

  it("19. a generic connect onto an already-connected mailbox leaves its credential alone", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "generic-connected");
    const before = (
      await client.query(
        "select refresh_token_ciphertext from private.gmail_oauth_credentials where mail_account_id=$1",
        [mailAccountId],
      )
    ).rows[0].refresh_token_ciphertext;

    const again = await authorize(userId, { project, subject });
    expect(again.outcome!.result).toBe("already_connected");
    const after = (
      await client.query(
        "select refresh_token_ciphertext from private.gmail_oauth_credentials where mail_account_id=$1",
        [mailAccountId],
      )
    ).rows[0].refresh_token_ciphertext;
    expect(after).toBe(before);
    expect(again.google.calls.revocations).toHaveLength(0);
  });

  it("20. a generic connect onto an unseen Google account connects normally", async () => {
    const project = createFakeGoogleProject();
    const userId = await createTestUser(client, "generic-unseen");
    const { outcome } = await authorize(userId, {
      project,
      subject: `sub-${randomBytes(8).toString("hex")}`,
    });
    expect(outcome!.result).toBe("consent_required");
    const id = (outcome as { mailAccountId: string }).mailAccountId;
    expect(await countCredentials(client, id)).toBe(1);
  });

  it("21. a generic connect onto an identity with only retired rows makes a NEW one", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "generic-retired");
    await disconnectGmailAccount(
      { userId, mailAccountId },
      deps(createFakeGoogle({ project, subject })),
    );

    await client.query("begin");
    const req = await client.query(
      `insert into public.mail_account_deletion_requests
         (mail_account_id, user_id, scope, requested_by_user_id, requested_at)
       values ($1,$2,'account_and_gmail_derived_data',$2, now()) returning id`,
      [mailAccountId, userId],
    );
    await client.query(
      `update public.mail_accounts set connection_state='deletion_pending',
          current_deletion_request_id=$2 where id=$1`,
      [mailAccountId, req.rows[0].id],
    );
    await client.query(
      "update public.mail_account_deletion_requests set status='completed', completed_at=now() where id=$1",
      [req.rows[0].id],
    );
    await client.query("update public.mail_accounts set connection_state='deleted' where id=$1", [
      mailAccountId,
    ]);
    await client.query("commit");

    const fresh = await authorize(userId, { project, subject });
    expect(fresh.outcome!.result).toBe("consent_required");
    const newId = (fresh.outcome as { mailAccountId: string }).mailAccountId;
    expect(newId).not.toBe(mailAccountId);

    // B01's terminal history is untouched: the retired row keeps saying what it
    // said, and inherits nothing to the new one.
    const old = await readMailAccount(client, mailAccountId);
    expect(old.connection_state).toBe("deleted");
    expect(await countCredentials(client, mailAccountId)).toBe(0);
  });
});
