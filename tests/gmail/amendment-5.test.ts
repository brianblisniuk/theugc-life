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
import { canDisconnect } from "@/lib/gmail/panel-actions";

import {
  createFakeGoogle,
  createFakeGoogleProject,
  type FakeGoogleOptions,
  type FakeGoogleProject,
} from "./fake-google";
import {
  countCredentials,
  createRpcClient,
  createTestUser,
  readMailAccount,
  type FakeAdminClient,
} from "./rpc-harness";

/**
 * B02 EXTERNAL AUDIT AMENDMENT #5.
 *
 * Amendment #3 stopped a stale OAuth callback from overwriting a newer Disconnect
 * LOCALLY. It did not stop that callback from obtaining a fresh grant AT GOOGLE
 * afterwards — so B02 could end with `disconnected` on our side and an active
 * authorization on theirs. "We forgot our copy of the token" is not what
 * Disconnect promises.
 *
 * Two mechanisms close it, and the split between them is the whole design:
 *
 *   * `gmail_disconnect_prepare` runs BEFORE the network call. It cancels
 *     unconsumed reconnect transactions, so a callback that has not started yet
 *     never exchanges its code — no grant is created to worry about;
 *   * for a callback already mid-exchange, a durable disconnect intent lets it
 *     prove it was superseded by an explicit Disconnect of this same Google
 *     account, and revoke what it obtained. That is not the generic callback
 *     cleanup amendment #2 removed — it is carrying out the newer instruction.
 */

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_DB);

let client: Client;
let realDb: FakeAdminClient;
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
  realDb = createRpcClient(client);
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

async function finish(
  userId: string,
  google: ReturnType<typeof createFakeGoogle>,
  state: string,
  db?: FakeAdminClient,
) {
  return completeGmailAuthorization(
    { userId, state, code: "auth-code", error: null },
    deps(google, db),
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

/** A mailbox connected and consented inside a named Google authorization domain. */
async function connectedIn(project: FakeGoogleProject, label: string, subject?: string) {
  const userId = await createTestUser(client, label);
  const sub = subject ?? `sub-${randomBytes(8).toString("hex")}`;
  const { outcome } = await authorize(userId, { project, subject: sub });
  const mailAccountId = (outcome as { mailAccountId: string }).mailAccountId;
  await grantPrivateProcessingConsent({ userId, mailAccountId }, deps(createFakeGoogle()));
  return { userId, mailAccountId, subject: sub };
}

async function expireCredential(mailAccountId: string) {
  await client.query(
    `select public.gmail_mark_reauth_required($1, (select credential_generation
       from private.gmail_oauth_credentials where mail_account_id = $1))`,
    [mailAccountId],
  );
}

const stateOf = async (id: string) => (await readMailAccount(client, id)).connection_state;

/**
 * A db wrapper that performs the human's Disconnect at the exact moment the
 * callback reaches its local persistence — i.e. AFTER it consumed its state and
 * exchanged its code at Google. This is the hard ordering: cancelling the
 * transaction can no longer help, because it is already gone.
 */
function disconnectDuringPersist(run: () => Promise<unknown>): FakeAdminClient {
  let fired = false;
  return {
    async rpc(name, args) {
      if (name === "gmail_connection_persist" && !fired) {
        fired = true;
        await run();
      }
      return realDb.rpc(name, args);
    },
  };
}

d("amendment #5 — Disconnect dominates the provider authorization too", () => {
  it("A1. a Disconnect before the callback consumes its state stops the exchange entirely", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "a5-1");
    await expireCredential(mailAccountId);

    const begun = await beginAuthorization(
      userId,
      { project, subject },
      { purpose: "reconnect", targetMailAccountId: mailAccountId },
    );
    expect(begun.started.result).toBe("ok");

    const disconnected = await disconnectGmailAccount(
      { userId, mailAccountId },
      deps(createFakeGoogle({ project, subject })),
    );
    expect(disconnected.result).toBe("disconnected");

    // The transaction was cancelled by `prepare`, so the callback finds nothing.
    const outcome = await finish(userId, begun.google, begun.state!);
    expect(outcome.result).toBe("invalid_state");

    // THE POINT: no code was exchanged, so no grant was created to leak. This is
    // better than cleaning up afterwards — there is nothing to clean up.
    expect(begun.google.calls.exchanges).toHaveLength(0);
    expect(await stateOf(mailAccountId)).toBe("disconnected");
    expect(await countCredentials(client, mailAccountId)).toBe(0);
  });

  it("A2. a callback already mid-exchange proves it was superseded, and revokes", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "a5-2");
    await expireCredential(mailAccountId);

    const begun = await beginAuthorization(
      userId,
      { project, subject },
      { purpose: "reconnect", targetMailAccountId: mailAccountId },
    );

    // The Disconnect lands while the callback is between Google and persistence.
    const racing = disconnectDuringPersist(async () => {
      const r = await disconnectGmailAccount(
        { userId, mailAccountId },
        deps(createFakeGoogle({ project, subject })),
      );
      expect(r.result).toBe("disconnected");
    });

    const outcome = await finish(userId, begun.google, begun.state!, racing);
    expect(outcome.result).toBe("state_changed");

    // It DID obtain a grant — and gave it back, because the newer human
    // instruction was "disconnect this Google account".
    expect(begun.google.calls.exchanges).toHaveLength(1);
    expect(begun.google.calls.revocations).toHaveLength(1);
    expect(project.revokedSubjects()).toContain(subject);

    // Nothing persisted locally either.
    expect(await stateOf(mailAccountId)).toBe("disconnected");
    expect(await countCredentials(client, mailAccountId)).toBe(0);
  });

  it("A3. whichever side gets there first, the final provider grant is inactive", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "a5-3");
    await expireCredential(mailAccountId);

    const begun = await beginAuthorization(
      userId,
      { project, subject },
      { purpose: "reconnect", targetMailAccountId: mailAccountId },
    );

    // The callback reaches Google FIRST; the Disconnect intent then wins.
    const racing = disconnectDuringPersist(async () => {
      await disconnectGmailAccount(
        { userId, mailAccountId },
        deps(createFakeGoogle({ project, subject })),
      );
    });
    await finish(userId, begun.google, begun.state!, racing);

    expect(await stateOf(mailAccountId)).toBe("disconnected");
    expect(project.revokedSubjects()).toContain(subject);
  });

  it("A4. disconnecting a connected mailbox revokes the grant", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "a5-4");
    const google = createFakeGoogle({ project, subject });

    const outcome = await disconnectGmailAccount({ userId, mailAccountId }, deps(google));
    expect(outcome.result).toBe("disconnected");
    expect(project.revokedSubjects()).toContain(subject);
    expect(await stateOf(mailAccountId)).toBe("disconnected");
    expect(await countCredentials(client, mailAccountId)).toBe(0);
  });

  it("A5. disconnecting a consent_required mailbox revokes the grant", async () => {
    const project = createFakeGoogleProject();
    const userId = await createTestUser(client, "a5-5");
    const subject = `sub-${randomBytes(8).toString("hex")}`;
    const { outcome } = await authorize(userId, { project, subject });
    const mailAccountId = (outcome as { mailAccountId: string }).mailAccountId;
    expect(await stateOf(mailAccountId)).toBe("consent_required");

    const google = createFakeGoogle({ project, subject });
    const result = await disconnectGmailAccount({ userId, mailAccountId }, deps(google));

    // That mailbox holds a LIVE grant even though it was never `connected`.
    expect(result.result).toBe("disconnected");
    expect(project.revokedSubjects()).toContain(subject);
    expect(await stateOf(mailAccountId)).toBe("disconnected");
  });

  it("A6. disconnecting a credential-less mailbox creates no grant and revokes nothing", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "a5-6");
    await expireCredential(mailAccountId);
    expect(await countCredentials(client, mailAccountId)).toBe(0);

    const google = createFakeGoogle({ project, subject });
    const outcome = await disconnectGmailAccount({ userId, mailAccountId }, deps(google));

    expect(outcome.result).toBe("disconnected");
    // Nothing to revoke, so nothing is claimed.
    expect(google.calls.revocations).toHaveLength(0);
    expect(await stateOf(mailAccountId)).toBe("disconnected");
  });

  it("A7. a transient revoke failure does NOT report disconnected, and can be retried", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "a5-7");

    const failing = createFakeGoogle({
      project,
      subject,
      revokeError: new GoogleAdapterError("backend_error", false),
    });
    const first = await disconnectGmailAccount({ userId, mailAccountId }, deps(failing));

    // We do not know the grant is gone, so we do not say it is.
    expect(first.result).toBe("provider_unavailable");
    // ...and the state says so truthfully rather than claiming completion.
    expect(await stateOf(mailAccountId)).toBe("disconnecting");
    // The credential is KEPT, because it is the only thing that can revoke.
    expect(await countCredentials(client, mailAccountId)).toBe(1);

    // Retry succeeds and finishes the job.
    const google = createFakeGoogle({ project, subject });
    const second = await disconnectGmailAccount({ userId, mailAccountId }, deps(google));
    expect(second.result).toBe("disconnected");
    expect(project.revokedSubjects()).toContain(subject);
    expect(await stateOf(mailAccountId)).toBe("disconnected");
    expect(await countCredentials(client, mailAccountId)).toBe(0);
  });

  it("A8. a callback stale for some OTHER reason does not revoke", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "a5-8");
    await expireCredential(mailAccountId);

    const begun = await beginAuthorization(
      userId,
      { project, subject },
      { purpose: "reconnect", targetMailAccountId: mailAccountId },
    );

    // A lifecycle change that is NOT a Disconnect: a direct scope edit.
    await client.query(
      "update public.mail_accounts set granted_scopes=array['openid']::text[] where id=$1",
      [mailAccountId],
    );

    const outcome = await finish(userId, begun.google, begun.state!);
    expect(outcome.result).toBe("state_changed");
    // No disconnect intent, so amendment #2's rule governs: revoke nothing.
    expect(begun.google.calls.revocations).toHaveLength(0);
    expect(project.revokedSubjects()).toEqual([]);
  });

  it("A9. an old callback must not revoke an authorization the human made SINCE", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "a5-9");
    await expireCredential(mailAccountId);

    // The old flow begins...
    const stale = await beginAuthorization(
      userId,
      { project, subject },
      { purpose: "reconnect", targetMailAccountId: mailAccountId },
    );

    // ...the human disconnects...
    await disconnectGmailAccount(
      { userId, mailAccountId },
      deps(createFakeGoogle({ project, subject })),
    );
    // ...then changes their mind AGAIN and reconnects properly.
    const fresh = await authorize(
      userId,
      { project, subject },
      { purpose: "reconnect", targetMailAccountId: mailAccountId },
    );
    expect(fresh.outcome!.result).toBe("connected");
    expect(await stateOf(mailAccountId)).toBe("connected");
    const revokedBefore = [...project.revokedSubjects()];

    // The ancient callback finally lands. Its state was cancelled by the
    // Disconnect, so it cannot even exchange — and if it could, the mailbox is
    // no longer in a disconnect state, so the revoke branch is unreachable.
    const outcome = await finish(userId, stale.google, stale.state!);
    expect(outcome.result).toBe("invalid_state");
    expect(stale.google.calls.revocations).toHaveLength(0);
    expect(project.revokedSubjects()).toEqual(revokedBefore);

    // The connection the human actually wants is untouched.
    expect(await stateOf(mailAccountId)).toBe("connected");
    expect(await countCredentials(client, mailAccountId)).toBe(1);
  });

  it("A10. account_mismatch and owned_by_other_user still revoke nothing", async () => {
    const project = createFakeGoogleProject();
    const userId = await createTestUser(client, "a5-10");
    const subjectA = `A-${randomBytes(6).toString("hex")}`;
    const subjectB = `B-${randomBytes(6).toString("hex")}`;

    const a = await authorize(userId, { project, subject: subjectA });
    const idA = (a.outcome as { mailAccountId: string }).mailAccountId;
    await grantPrivateProcessingConsent({ userId, mailAccountId: idA }, deps(createFakeGoogle()));
    await expireCredential(idA);

    // Reconnect A, chooser returns B.
    const mismatch = await authorize(
      userId,
      { project, subject: subjectB },
      { purpose: "reconnect", targetMailAccountId: idA },
    );
    expect(mismatch.outcome!.result).toBe("account_mismatch");
    expect(mismatch.google.calls.revocations).toHaveLength(0);

    // A stranger authorizing an owned identity.
    const owner = await connectedIn(project, "a5-10-owner");
    const stranger = await createTestUser(client, "a5-10-stranger");
    const refused = await authorize(stranger, { project, subject: owner.subject });
    expect(refused.outcome!.result).toBe("owned_by_other_user");
    expect(refused.google.calls.revocations).toHaveLength(0);
    expect(project.revokedSubjects()).not.toContain(owner.subject);
  });
});

d("amendment #5 — a deletion owns the lifecycle while it runs", () => {
  async function deletionPending(label: string) {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, label);
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
    await client.query("commit");
    return { project, userId, mailAccountId, subject, requestId: req.rows[0].id as string };
  }

  async function snapshot(mailAccountId: string, requestId: string) {
    const row = await readMailAccount(client, mailAccountId);
    const pointer = await client.query(
      "select current_deletion_request_id from public.mail_accounts where id=$1",
      [mailAccountId],
    );
    const request = await client.query(
      "select status from public.mail_account_deletion_requests where id=$1",
      [requestId],
    );
    return {
      state: row.connection_state,
      pointer: pointer.rows[0].current_deletion_request_id as string | null,
      status: request.rows[0].status as string,
      credentials: await countCredentials(client, mailAccountId),
    };
  }

  it("a user Disconnect against deletion_pending is refused and changes nothing", async () => {
    const { project, userId, mailAccountId, subject, requestId } = await deletionPending("a5-del");
    const before = await snapshot(mailAccountId, requestId);
    expect(before.state).toBe("deletion_pending");
    expect(before.pointer).toBe(requestId);
    expect(before.status).toBe("requested");

    const google = createFakeGoogle({ project, subject });
    const outcome = await disconnectGmailAccount({ userId, mailAccountId }, deps(google));

    // A user-facing Disconnect does not rewrite the deletion lifecycle. Access
    // has already stopped; there is nothing for it to add, and moving the state
    // would stop the account surface saying "Deletion in progress" while the
    // request was still running.
    expect(outcome.result).toBe("deletion_in_progress");

    const after = await snapshot(mailAccountId, requestId);
    expect(after).toEqual(before);
    expect(google.calls.revocations).toHaveLength(0);
  });

  it("the finalize RPC refuses deletion_pending on its own", async () => {
    const { userId, mailAccountId, requestId } = await deletionPending("a5-del2");
    const before = await snapshot(mailAccountId, requestId);

    // Called directly, so removing the orchestration check would not quietly
    // open the second door.
    const direct = await client.query(
      "select public.gmail_disconnect_finalize($1::uuid,$2::uuid) as r",
      [userId, mailAccountId],
    );
    expect((direct.rows[0].r as { result: string }).result).toBe("deletion_in_progress");
    expect(await snapshot(mailAccountId, requestId)).toEqual(before);
  });

  it("a retired mailbox is refused too", async () => {
    const { userId, mailAccountId, requestId } = await deletionPending("a5-del3");
    await client.query("begin");
    await client.query(
      "update public.mail_account_deletion_requests set status='completed', completed_at=now() where id=$1",
      [requestId],
    );
    await client.query("update public.mail_accounts set connection_state='deleted' where id=$1", [
      mailAccountId,
    ]);
    await client.query("commit");

    const prepared = await client.query(
      "select public.gmail_disconnect_prepare($1::uuid,$2::uuid) as r",
      [userId, mailAccountId],
    );
    expect((prepared.rows[0].r as { result: string }).result).toBe("account_retired");
    expect(await stateOf(mailAccountId)).toBe("deleted");
  });
});

describe("amendment #5 — the panel offers Disconnect only where it means something", () => {
  const account = (connectionState: string) => ({ connectionState }) as never;

  it("covers every connection state", () => {
    for (const state of [
      "pending_authorization",
      "consent_required",
      "connected",
      "reauth_required",
      "disconnecting",
    ]) {
      expect(canDisconnect(account(state))).toBe(true);
    }
    // Already done, or owned by the deletion lifecycle.
    for (const state of ["disconnected", "deletion_pending", "deleted"]) {
      expect(canDisconnect(account(state))).toBe(false);
    }
  });
});
