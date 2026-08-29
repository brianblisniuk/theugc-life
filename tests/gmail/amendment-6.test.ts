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
import { GoogleAdapterError } from "@/lib/gmail/google.server";

import {
  createFakeGoogle,
  createFakeGoogleProject,
  type FakeGoogleOptions,
  type FakeGoogleProject,
} from "./fake-google";
import { countCredentials, createRpcClient, createTestUser, readMailAccount } from "./rpc-harness";

/**
 * B02 EXTERNAL AUDIT AMENDMENT #6.
 *
 * Amendment #5 made an explicit Disconnect dominate an OAuth flow that was in
 * the air. It left four ways round that, and one place where the dominance
 * stopped short:
 *
 *   A. `superseded_by_disconnect` was UNREACHABLE while the mailbox was
 *      `disconnecting` — the reconnectable-state gate answered `account_mismatch`
 *      first — which is precisely the window in which a live, freshly-created
 *      grant is most likely to exist;
 *   B. when that revocation failed transiently, the newly-issued refresh token
 *      was logged about and dropped, so the grant could stay ACTIVE at Google
 *      with nothing left anywhere that could remove it;
 *   C. `gmail_disconnect_finalize` accepted almost any live mailbox, so the
 *      whole prepare -> revoke -> finalize protocol could be skipped;
 *   D. a stale consent could move a `disconnecting` mailbox to `connected`,
 *      undoing the Disconnect — reachable exactly because #5 deliberately
 *      RETAINS the credential while `disconnecting`;
 *   E. a GENERIC connect had no fence at all. It has no target, so there is no
 *      revision to pin and nothing for `prepare` to cancel; a "Connect another
 *      Gmail" begun before a Disconnect could come back with the disconnected
 *      identity and reauthorize it.
 *
 * The fence for E is a shared monotonic sequence: every OAuth transaction draws
 * a position when it BEGINS, every explicit Disconnect draws one when it is
 * PREPARED, and the comparison works before any Google identity is known.
 */

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_DB);

let client: Client;
let realDb: { rpc: (name: string, args: Record<string, unknown>) => Promise<unknown> };
let deps: (google: ReturnType<typeof createFakeGoogle>, db?: FakeAdminClient) => GmailDeps;

interface FakeAdminClient {
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>;
}

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
  deps = (google, db) => ({
    google,
    db: (db ?? realDb) as unknown as GmailDeps["db"],
  });
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

function finish(
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

/** Performs the human's Disconnect at the moment the callback reaches persist. */
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

d("amendment #6 — the supersession branch is reachable while `disconnecting`", () => {
  it("1. a stale reconnect callback during an unfinished Disconnect is superseded, not mismatched", async () => {
    // A `consent_required` mailbox, deliberately: it is reconnectable AND it
    // holds a credential, which is what lets the Disconnect below actually
    // attempt a revocation and therefore actually FAIL one — leaving the row in
    // `disconnecting`. A mailbox with no credential never calls Google, so it
    // could not produce the state this test is about.
    const project = createFakeGoogleProject();
    const userId = await createTestUser(client, "a6-1");
    const subject = `sub-${randomBytes(8).toString("hex")}`;
    const authorized = await authorize(userId, { project, subject });
    const mailAccountId = (authorized.outcome as { mailAccountId: string }).mailAccountId;
    expect(await stateOf(mailAccountId)).toBe("consent_required");

    const begun = await beginAuthorization(
      userId,
      { project, subject },
      { purpose: "reconnect", targetMailAccountId: mailAccountId },
    );

    // The Disconnect lands mid-persist AND its provider call fails, so the
    // mailbox is left in `disconnecting` — the exact window amendment #5 could
    // not answer truthfully.
    const racing = disconnectDuringPersist(async () => {
      const r = await disconnectGmailAccount(
        { userId, mailAccountId },
        deps(
          createFakeGoogle({
            project,
            subject,
            revokeError: new GoogleAdapterError("backend_error", false),
          }),
        ),
      );
      expect(r.result).toBe("provider_unavailable");
      expect(await stateOf(mailAccountId)).toBe("disconnecting");
    });

    const outcome = await finish(userId, begun.google, begun.state!, racing);

    // Amendment #5 answered `account_mismatch` here and revoked nothing.
    expect(outcome.result).toBe("state_changed");
    expect(begun.google.calls.revocations).toHaveLength(1);
    expect(project.revokedSubjects()).toContain(subject);
    // The Disconnect the human asked for is now actually finished.
    expect(await stateOf(mailAccountId)).toBe("disconnected");
    expect(await countCredentials(client, mailAccountId)).toBe(0);
  });

  it("2. a reconnect begun AFTER the Disconnect is ordinary work, not stale work", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "a6-2");
    await expireCredential(mailAccountId);

    await disconnectGmailAccount(
      { userId, mailAccountId },
      deps(createFakeGoogle({ project, subject })),
    );
    expect(await stateOf(mailAccountId)).toBe("disconnected");

    // Started afterwards: a higher position in the shared sequence.
    const fresh = await authorize(
      userId,
      { project, subject },
      { purpose: "reconnect", targetMailAccountId: mailAccountId },
    );
    expect(fresh.outcome!.result).toBe("connected");
    // It must NOT have been treated as superseded and revoked.
    expect(fresh.google.calls.revocations).toHaveLength(0);
    expect(project.revokedSubjects()).not.toContain(subject);
    expect(await stateOf(mailAccountId)).toBe("connected");
  });
});

d("amendment #6 — a superseded revocation that fails is retried, not forgotten", () => {
  /**
   * Drive the callback to `superseded_by_disconnect` and control what Google
   * does with the revoke. Returns everything a test needs to inspect after.
   */
  async function supersededCallback(
    label: string,
    callbackGoogle: (project: FakeGoogleProject, subject: string) => FakeGoogleOptions,
  ) {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, label);
    await expireCredential(mailAccountId);

    const begun = await beginAuthorization(userId, callbackGoogle(project, subject), {
      purpose: "reconnect",
      targetMailAccountId: mailAccountId,
    });

    const racing = disconnectDuringPersist(async () => {
      await disconnectGmailAccount(
        { userId, mailAccountId },
        deps(createFakeGoogle({ project, subject })),
      );
    });

    const outcome = await finish(userId, begun.google, begun.state!, racing);
    return { project, userId, mailAccountId, subject, begun, outcome };
  }

  it("3. success: the provider grant is inactive and the mailbox is disconnected", async () => {
    const { project, subject, mailAccountId, outcome, begun } = await supersededCallback(
      "a6-3",
      (project, subject) => ({ project, subject }),
    );
    expect(outcome.result).toBe("state_changed");
    expect(begun.google.calls.exchanges).toHaveLength(1);
    expect(project.isSubjectAuthorized(subject)).toBe(false);
    expect(await stateOf(mailAccountId)).toBe("disconnected");
    expect(await countCredentials(client, mailAccountId)).toBe(0);
  });

  it("4. transient failure: the fresh token is kept, and nothing claims to be disconnected", async () => {
    const { project, subject, mailAccountId, outcome } = await supersededCallback(
      "a6-4",
      (project, subject) => ({
        project,
        subject,
        revokeError: new GoogleAdapterError("backend_error", false),
      }),
    );

    // NOT `state_changed`: that would read as "the world moved on, nothing to
    // see". The provider grant is live and we know it.
    expect(outcome.result).toBe("disconnect_incomplete");
    expect(project.isSubjectAuthorized(subject)).toBe(true);

    // The row does not claim completion, and the retry material is there.
    expect(await stateOf(mailAccountId)).toBe("disconnecting");
    expect(await countCredentials(client, mailAccountId)).toBe(1);

    // Encrypted, never plaintext.
    const stored = await client.query(
      `select refresh_token_ciphertext, refresh_token_iv, refresh_token_auth_tag
         from private.gmail_oauth_credentials where mail_account_id = $1`,
      [mailAccountId],
    );
    const row = stored.rows[0];
    expect(row.refresh_token_ciphertext.length).toBeGreaterThan(0);
    expect(row.refresh_token_ciphertext).not.toContain("refresh-");
    expect(row.refresh_token_iv.length).toBeGreaterThan(0);
    expect(row.refresh_token_auth_tag.length).toBeGreaterThan(0);
  });

  it("5. and the retry actually revokes the grant that was left alive", async () => {
    const { project, subject, userId, mailAccountId } = await supersededCallback(
      "a6-5",
      (project, subject) => ({
        project,
        subject,
        revokeError: new GoogleAdapterError("backend_error", false),
      }),
    );
    expect(project.isSubjectAuthorized(subject)).toBe(true);

    // The human presses Disconnect again. It loads the stored FRESH token — the
    // one representing the grant that is actually live — and revokes with it.
    const retry = await disconnectGmailAccount(
      { userId, mailAccountId },
      deps(createFakeGoogle({ project, subject })),
    );
    expect(retry.result).toBe("disconnected");
    expect(project.isSubjectAuthorized(subject)).toBe(false);
    expect(await stateOf(mailAccountId)).toBe("disconnected");
    expect(await countCredentials(client, mailAccountId)).toBe(0);
  });

  it("6. `invalid_token` on the token this callback just received completes the cleanup", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "a6-6");
    await expireCredential(mailAccountId);

    const begun = await beginAuthorization(
      userId,
      { project, subject, revokeError: new GoogleAdapterError("invalid_token", true) },
      { purpose: "reconnect", targetMailAccountId: mailAccountId },
    );
    const racing = disconnectDuringPersist(async () => {
      await disconnectGmailAccount(
        { userId, mailAccountId },
        deps(createFakeGoogle({ project, subject })),
      );
    });
    const outcome = await finish(userId, begun.google, begun.state!, racing);

    // The token minted seconds ago is already unusable, which is the outcome the
    // revocation was asking for. Nothing is left pending.
    expect(outcome.result).toBe("state_changed");
    expect(await stateOf(mailAccountId)).toBe("disconnected");
    expect(await countCredentials(client, mailAccountId)).toBe(0);
  });

  it("7. `invalid_token` on an OLD token proves nothing about a newer grant", async () => {
    // The claim under test is a NEGATIVE one, so it is asserted against the
    // provider model rather than against our code: a dead old token cannot
    // revoke, and the subject stays authorized. Any code that finalized a
    // Disconnect on the strength of that `invalid_token` would be asserting
    // something this shows to be false.
    const project = createFakeGoogleProject();
    const subject = `sub-${randomBytes(6).toString("hex")}`;
    const oldToken = project.issueRefreshToken(subject);
    const newToken = project.issueRefreshToken(subject);

    // The old token dies on its own — superseded, not revoked.
    project.invalidateToken(oldToken);
    expect(project.isTokenValid(oldToken)).toBe(false);
    expect(project.isTokenValid(newToken)).toBe(true);

    const google = createFakeGoogle({ project, subject });
    await expect(google.revoke({ token: oldToken })).rejects.toMatchObject({
      code: "invalid_token",
    });

    // THE POINT: the grant is untouched, and the newer token still works.
    expect(project.isSubjectAuthorized(subject)).toBe(true);
    expect(project.isTokenValid(newToken)).toBe(true);

    // Revoking with the token that actually represents the live grant does work.
    await google.revoke({ token: newToken });
    expect(project.isSubjectAuthorized(subject)).toBe(false);
  });

  it("8. a newer successful Reconnect refuses both the store and the revoke", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "a6-8");
    await expireCredential(mailAccountId);

    const begun = await beginAuthorization(
      userId,
      { project, subject, revokeError: new GoogleAdapterError("backend_error", false) },
      { purpose: "reconnect", targetMailAccountId: mailAccountId },
    );

    // Disconnect lands mid-persist... and then the human changes their mind AGAIN
    // and reconnects successfully, before the stale callback's persist runs.
    const racing = disconnectDuringPersist(async () => {
      await disconnectGmailAccount(
        { userId, mailAccountId },
        deps(createFakeGoogle({ project, subject })),
      );
      const fresh = await authorize(
        userId,
        { project, subject },
        { purpose: "reconnect", targetMailAccountId: mailAccountId },
      );
      expect(fresh.outcome!.result).toBe("connected");
    });

    const outcome = await finish(userId, begun.google, begun.state!, racing);

    // The stale callback is refused, and it must neither store its token over
    // the live credential nor revoke the authorization the human just made.
    // `account_mismatch` rather than `state_changed`: the mailbox is `connected`
    // again, so it fails the ordinary reconnectable-state gate — which is the
    // point. Reaching a refusal that does not revoke is what matters, and the
    // supersession branch was ruled out before the gate was consulted.
    expect(outcome.result).toBe("account_mismatch");
    expect(begun.google.calls.revocations).toHaveLength(0);
    expect(project.isSubjectAuthorized(subject)).toBe(true);
    expect(await stateOf(mailAccountId)).toBe("connected");
    expect(await countCredentials(client, mailAccountId)).toBe(1);
  });
});

d("amendment #6 — finalize requires a prepared Disconnect", () => {
  it("9. a connected mailbox cannot be finalized without prepare", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "a6-9");

    const res = await client.query(
      "select public.gmail_disconnect_finalize($1, $2, null::bigint, null::bigint) as r",
      [userId, mailAccountId],
    );
    expect(res.rows[0].r).toMatchObject({
      result: "prepare_required",
      connection_state: "connected",
    });

    // Nothing moved, nothing was destroyed, and Google was never told anything.
    expect(await stateOf(mailAccountId)).toBe("connected");
    expect(await countCredentials(client, mailAccountId)).toBe(1);
    expect(project.isSubjectAuthorized(subject)).toBe(true);
  });

  it("10. and neither can any other unprepared state", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId } = await connectedIn(project, "a6-10");

    // `reauth_required` — a live lifecycle, no disconnect intent.
    await expireCredential(mailAccountId);
    const reauth = await client.query(
      "select public.gmail_disconnect_finalize($1, $2, null::bigint, null::bigint) as r",
      [userId, mailAccountId],
    );
    expect(reauth.rows[0].r).toMatchObject({
      result: "prepare_required",
      connection_state: "reauth_required",
    });
    expect(await stateOf(mailAccountId)).toBe("reauth_required");

    // `consent_required` — credential held, product permission outstanding.
    const other = await createTestUser(client, "a6-10b");
    const authorized = await authorize(other, { project });
    const consentId = (authorized.outcome as { mailAccountId: string }).mailAccountId;
    expect(await stateOf(consentId)).toBe("consent_required");
    const consent = await client.query(
      "select public.gmail_disconnect_finalize($1, $2, null::bigint, null::bigint) as r",
      [other, consentId],
    );
    expect(consent.rows[0].r).toMatchObject({
      result: "prepare_required",
      connection_state: "consent_required",
    });
    expect(await countCredentials(client, consentId)).toBe(1);
  });

  it("11. the prepared path still works, and stays idempotent", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "a6-11");

    const first = await disconnectGmailAccount(
      { userId, mailAccountId },
      deps(createFakeGoogle({ project, subject })),
    );
    expect(first.result).toBe("disconnected");

    const again = await disconnectGmailAccount(
      { userId, mailAccountId },
      deps(createFakeGoogle({ project, subject })),
    );
    expect(again.result).toBe("disconnected");
    expect(await stateOf(mailAccountId)).toBe("disconnected");
  });
});

d("amendment #6 — consent may only connect from `consent_required`", () => {
  it("12. a stale consent cannot revive a mailbox that is disconnecting", async () => {
    const project = createFakeGoogleProject();
    const userId = await createTestUser(client, "a6-12");
    const subject = `sub-${randomBytes(8).toString("hex")}`;
    const authorized = await authorize(userId, { project, subject });
    const mailAccountId = (authorized.outcome as { mailAccountId: string }).mailAccountId;
    expect(await stateOf(mailAccountId)).toBe("consent_required");

    // The human presses Disconnect instead, and the provider call fails.
    const disconnected = await disconnectGmailAccount(
      { userId, mailAccountId },
      deps(
        createFakeGoogle({
          project,
          subject,
          revokeError: new GoogleAdapterError("backend_error", false),
        }),
      ),
    );
    expect(disconnected.result).toBe("provider_unavailable");
    expect(await stateOf(mailAccountId)).toBe("disconnecting");

    const receiptsBefore = await client.query(
      "select count(*)::int as n from public.mail_account_consent_receipts where mail_account_id = $1",
      [mailAccountId],
    );

    // The consent form the human submitted BEFORE changing their mind lands now.
    const granted = await grantPrivateProcessingConsent(
      { userId, mailAccountId },
      deps(createFakeGoogle()),
    );
    expect(granted.result).toBe("consent_not_applicable");

    // The newer decision stands, and no receipt was written for a decision that
    // did not take effect.
    expect(await stateOf(mailAccountId)).toBe("disconnecting");
    const receiptsAfter = await client.query(
      "select count(*)::int as n from public.mail_account_consent_receipts where mail_account_id = $1",
      [mailAccountId],
    );
    expect(receiptsAfter.rows[0].n).toBe(receiptsBefore.rows[0].n);
  });

  it("13. no other state can be moved to `connected` through the consent RPC", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "a6-13");

    // connected — already there; the RPC must not re-decide it.
    const whileConnected = await grantPrivateProcessingConsent(
      { userId, mailAccountId },
      deps(createFakeGoogle()),
    );
    expect(whileConnected.result).toBe("consent_not_applicable");

    // reauth_required
    await expireCredential(mailAccountId);
    expect(
      (await grantPrivateProcessingConsent({ userId, mailAccountId }, deps(createFakeGoogle())))
        .result,
    ).toBe("consent_not_applicable");
    expect(await stateOf(mailAccountId)).toBe("reauth_required");

    // disconnected
    await disconnectGmailAccount(
      { userId, mailAccountId },
      deps(createFakeGoogle({ project, subject })),
    );
    expect(
      (await grantPrivateProcessingConsent({ userId, mailAccountId }, deps(createFakeGoogle())))
        .result,
    ).toBe("consent_not_applicable");
    expect(await stateOf(mailAccountId)).toBe("disconnected");

    // pending_authorization
    const pendingUser = await createTestUser(client, "a6-13b");
    const pending = await client.query(
      `insert into public.mail_accounts (user_id, provider, provider_account_subject, email_address, connection_state)
       values ($1, 'gmail', $2, 'pending@example.invalid', 'pending_authorization') returning id`,
      [pendingUser, `sub-${randomBytes(6).toString("hex")}`],
    );
    expect(
      (
        await grantPrivateProcessingConsent(
          { userId: pendingUser, mailAccountId: pending.rows[0].id },
          deps(createFakeGoogle()),
        )
      ).result,
    ).toBe("consent_not_applicable");
  });

  it("14. ORDER A — consent wins the row lock, connects, and the Disconnect then applies", async () => {
    const project = createFakeGoogleProject();
    const userId = await createTestUser(client, "a6-14");
    const subject = `sub-${randomBytes(8).toString("hex")}`;
    const authorized = await authorize(userId, { project, subject });
    const mailAccountId = (authorized.outcome as { mailAccountId: string }).mailAccountId;

    const consentSession = new Client({ connectionString: TEST_DB });
    await consentSession.connect();
    try {
      await consentSession.query("begin");
      const granted = await consentSession.query(
        `select public.gmail_grant_private_processing_consent($1::uuid, $2::uuid, 'p/1', $3, $4) as r`,
        [userId, mailAccountId, "a".repeat(64), "b".repeat(64)],
      );
      expect((granted.rows[0].r as { result: string }).result).toBe("connected");

      // The Disconnect arrives and WAITS on the same lock.
      const waiting = disconnectGmailAccount(
        { userId, mailAccountId },
        deps(createFakeGoogle({ project, subject })),
      );
      await new Promise((r) => setTimeout(r, 300));
      await consentSession.query("commit");
      expect((await waiting).result).toBe("disconnected");
    } finally {
      await consentSession.end();
    }

    expect(await stateOf(mailAccountId)).toBe("disconnected");
    expect(await countCredentials(client, mailAccountId)).toBe(0);
    expect(project.isSubjectAuthorized(subject)).toBe(false);
  });

  it("15. ORDER B — the Disconnect wins the row lock, and the waiting consent refuses", async () => {
    const project = createFakeGoogleProject();
    const userId = await createTestUser(client, "a6-15");
    const authorized = await authorize(userId, { project });
    const mailAccountId = (authorized.outcome as { mailAccountId: string }).mailAccountId;

    const disconnectSession = new Client({ connectionString: TEST_DB });
    const consentSession = new Client({ connectionString: TEST_DB });
    await disconnectSession.connect();
    await consentSession.connect();
    try {
      await disconnectSession.query("begin");
      await disconnectSession.query("select public.gmail_disconnect_prepare($1::uuid, $2::uuid)", [
        userId,
        mailAccountId,
      ]);

      // The stale consent enters the REAL function and blocks on the lock.
      const waiting = consentSession.query(
        `select public.gmail_grant_private_processing_consent($1::uuid, $2::uuid, 'p/1', $3, $4) as r`,
        [userId, mailAccountId, "a".repeat(64), "b".repeat(64)],
      );
      await new Promise((r) => setTimeout(r, 300));
      await disconnectSession.query("commit");

      const granted = await waiting;
      // It wakes up, sees the newer decision, and changes nothing.
      expect(granted.rows[0].r).toMatchObject({
        result: "consent_not_applicable",
        connection_state: "disconnecting",
      });
    } finally {
      await disconnectSession.end();
      await consentSession.end();
    }

    expect(await stateOf(mailAccountId)).toBe("disconnecting");
  });
});

d("amendment #6 — the fence covers generic CONNECT flows too", () => {
  it("G1. a generic Connect begun BEFORE the Disconnect cannot reauthorize that identity", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "a6-g1");

    // "Connect another Gmail" — no target, nothing to pin, invisible to
    // `prepare`'s transaction cancellation.
    const begun = await beginAuthorization(userId, { project, subject });
    expect(begun.started.result).toBe("ok");

    await disconnectGmailAccount(
      { userId, mailAccountId },
      deps(createFakeGoogle({ project, subject })),
    );
    expect(await stateOf(mailAccountId)).toBe("disconnected");
    expect(project.isSubjectAuthorized(subject)).toBe(false);

    // The account chooser hands back the mailbox they just disconnected.
    const outcome = await finish(userId, begun.google, begun.state!);

    // Amendment #5 answered `reconnect_required` here and revoked nothing,
    // leaving the grant this exchange created ACTIVE.
    expect(begun.google.calls.exchanges).toHaveLength(1);
    expect(outcome.result).toBe("state_changed");
    expect(begun.google.calls.revocations).toHaveLength(1);
    expect(project.isSubjectAuthorized(subject)).toBe(false);
    expect(await stateOf(mailAccountId)).toBe("disconnected");
    expect(await countCredentials(client, mailAccountId)).toBe(0);
  });

  it("G2. ...and when that revocation fails, the token is kept and the retry finishes it", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "a6-g2");

    const begun = await beginAuthorization(userId, {
      project,
      subject,
      revokeError: new GoogleAdapterError("backend_error", false),
    });
    await disconnectGmailAccount(
      { userId, mailAccountId },
      deps(createFakeGoogle({ project, subject })),
    );

    const outcome = await finish(userId, begun.google, begun.state!);
    expect(outcome.result).toBe("disconnect_incomplete");
    // Not falsely final, and the material to finish exists.
    expect(await stateOf(mailAccountId)).toBe("disconnecting");
    expect(await countCredentials(client, mailAccountId)).toBe(1);
    expect(project.isSubjectAuthorized(subject)).toBe(true);

    const retry = await disconnectGmailAccount(
      { userId, mailAccountId },
      deps(createFakeGoogle({ project, subject })),
    );
    expect(retry.result).toBe("disconnected");
    expect(project.isSubjectAuthorized(subject)).toBe(false);
    expect(await countCredentials(client, mailAccountId)).toBe(0);
  });

  it("G3. a generic Connect begun AFTER the Disconnect keeps the ordinary policy", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "a6-g3");

    await disconnectGmailAccount(
      { userId, mailAccountId },
      deps(createFakeGoogle({ project, subject })),
    );

    // Started afterwards: newer position, so it is NOT stale work.
    const outcome = await authorize(userId, { project, subject });
    expect(outcome.outcome!.result).toBe("reconnect_required");
    // Ordinary refusals revoke nothing — amendment #2's rule, intact.
    expect(outcome.google.calls.revocations).toHaveLength(0);
    expect(await stateOf(mailAccountId)).toBe("disconnected");
  });

  it("G4. a generic Connect that selects an UNRELATED account is unaffected", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "a6-g4");
    const subjectB = `sub-B-${randomBytes(6).toString("hex")}`;

    // Begun before the Disconnect of A, but the chooser returns B.
    const begun = await beginAuthorization(userId, { project, subject: subjectB });
    await disconnectGmailAccount(
      { userId, mailAccountId },
      deps(createFakeGoogle({ project, subject })),
    );

    const outcome = await finish(userId, begun.google, begun.state!);
    expect(outcome.result).toBe("consent_required");
    // B is a normal new connection, and the Disconnect of A did not revoke it.
    expect(begun.google.calls.revocations).toHaveLength(0);
    expect(project.isSubjectAuthorized(subjectB)).toBe(true);
    const created = (outcome as { mailAccountId: string }).mailAccountId;
    expect(created).not.toBe(mailAccountId);
    expect(await countCredentials(client, created)).toBe(1);
  });

  it("G5. a generic Connect onto an identity owned by another user is still refused silently", async () => {
    const project = createFakeGoogleProject();
    const owner = await connectedIn(project, "a6-g5-owner");
    const stranger = await createTestUser(client, "a6-g5-stranger");

    const begun = await beginAuthorization(stranger, { project, subject: owner.subject });
    await disconnectGmailAccount(
      { userId: owner.userId, mailAccountId: owner.mailAccountId },
      deps(createFakeGoogle({ project, subject: owner.subject })),
    );

    const outcome = await finish(stranger, begun.google, begun.state!);
    // The ownership refusal comes first and says nothing about who owns it —
    // and, critically, it does not revoke: that was amendment #2's blocker.
    expect(outcome.result).toBe("owned_by_other_user");
    expect(begun.google.calls.revocations).toHaveLength(0);
  });

  it("G6. an explicit Reconnect still uses the exact-revision CAS", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "a6-g6");
    await expireCredential(mailAccountId);

    const pinned = await client.query(
      "select authorization_revision as r from public.mail_accounts where id = $1",
      [mailAccountId],
    );

    // A lifecycle change that is NOT a Disconnect: the revision moves, the
    // intent sequence does not, and the callback must still be refused.
    await client.query(
      "update public.mail_accounts set granted_scopes = array['openid']::text[] where id = $1",
      [mailAccountId],
    );

    const late = await client.query(
      `select public.gmail_connection_persist(
         $1::uuid, $2, 'g6@example.invalid', $3::text[],
         'CT','iv','tag','v1', null, $4::uuid, $5::bigint, 'p/1', null) as r`,
      [userId, subject, B02_REQUESTED_SCOPES, mailAccountId, pinned.rows[0].r],
    );
    expect(late.rows[0].r).toMatchObject({ result: "state_changed" });
    expect(await countCredentials(client, mailAccountId)).toBe(0);
  });
});
