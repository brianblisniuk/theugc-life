import { randomBytes } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  completeGmailAuthorization,
  disconnectGmailAccount,
  getFreshGmailAccessToken,
  grantPrivateProcessingConsent,
  startGmailAuthorization,
  type GmailDeps,
} from "@/lib/gmail/connection.server";
import { resetGmailOAuthConfigCache } from "@/lib/gmail/env.server";
import { GoogleAdapterError } from "@/lib/gmail/google.server";

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
 * B02 EXTERNAL AUDIT AMENDMENT #2.
 *
 * Three things, all of which come down to one habit: acting on a picture of the
 * world that was true when we looked and is not true now.
 *
 *   A  `google.revoke()` was used as callback cleanup, described as "handing
 *      back the token we just received". Google documents revocation as removing
 *      every scope the PROJECT holds for that user and invalidating the tokens
 *      of all clients under it — so refusing a callback destroyed whatever else
 *      that person had authorized. The worst case was a STRANGER authorizing a
 *      Google account they do not own: B01 correctly refused them, and the
 *      refusal disconnected the real owner.
 *
 *   B  a refresh spans a network call, and every mutation afterwards was keyed
 *      on `mail_account_id` alone. A slow worker could overwrite a newer
 *      credential, delete one it had never seen, or drag a mailbox the human had
 *      deliberately disconnected back to `reauth_required`.
 *
 *   C  0036 installed "a connected mailbox holds exactly one credential" as a
 *      write-time trigger and reported success on a database where it was
 *      already false.
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

async function authorize(
  userId: string,
  options: FakeGoogleOptions = {},
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
  if (started.result !== "ok") return { started, google, outcome: null };
  const url = new URL(started.authorizationUrl);
  const outcome = await completeGmailAuthorization(
    { userId, state: url.searchParams.get("state"), code: "auth-code", error: null },
    deps(google),
  );
  return { started, google, outcome };
}

/** A mailbox connected inside a NAMED authorization domain, so damage is visible. */
async function connectedIn(project: FakeGoogleProject, label: string, subject?: string) {
  const userId = await createTestUser(client, label);
  const sub = subject ?? `sub-${randomBytes(8).toString("hex")}`;
  const { outcome } = await authorize(userId, { project, subject: sub });
  const mailAccountId = (outcome as { mailAccountId: string }).mailAccountId;
  await grantPrivateProcessingConsent({ userId, mailAccountId }, deps(createFakeGoogle()));
  return { userId, mailAccountId, subject: sub };
}

/** Does the stored credential still work at Google? The only honest question. */
async function stillUsable(
  project: FakeGoogleProject,
  subject: string,
  mailAccountId: string,
): Promise<string> {
  const outcome = await getFreshGmailAccessToken(
    { mailAccountId },
    deps(createFakeGoogle({ project, subject })),
  );
  return outcome.result;
}

async function generationOf(mailAccountId: string): Promise<number> {
  const res = await client.query(
    "select credential_generation from private.gmail_oauth_credentials where mail_account_id=$1",
    [mailAccountId],
  );
  return res.rows[0] ? Number(res.rows[0].credential_generation) : 0;
}

async function ciphertextOf(mailAccountId: string): Promise<string | null> {
  const res = await client.query(
    "select refresh_token_ciphertext from private.gmail_oauth_credentials where mail_account_id=$1",
    [mailAccountId],
  );
  return res.rows[0]?.refresh_token_ciphertext ?? null;
}

d("amendment #2 — revocation is a project-wide operation, not a rollback", () => {
  it("1. authorizing an already-connected account again does NOT invalidate it", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "rev1");
    expect(await stillUsable(project, subject, mailAccountId)).toBe("ok");

    // The human clicks Connect again and picks the same Google account.
    const again = await authorize(userId, { project, subject });
    expect(again.outcome!.result).toBe("already_connected");
    expect(again.google.calls.revocations).toHaveLength(0);
    expect(project.revokedSubjects()).toEqual([]);

    // The connection they already had is untouched — locally AND at Google.
    expect((await readMailAccount(client, mailAccountId)).connection_state).toBe("connected");
    expect(await stillUsable(project, subject, mailAccountId)).toBe("ok");
  });

  it("2. a reconnect that lands on a different mailbox does NOT invalidate that mailbox", async () => {
    const project = createFakeGoogleProject();
    const userId = await createTestUser(client, "rev2");
    const subjectA = `A-${randomBytes(6).toString("hex")}`;
    const subjectB = `B-${randomBytes(6).toString("hex")}`;

    // Mailbox A: reconnectable. Mailbox B: connected and working.
    const a = await authorize(userId, { project, subject: subjectA });
    const idA = (a.outcome as { mailAccountId: string }).mailAccountId;
    await client.query("begin");
    await client.query("delete from private.gmail_oauth_credentials where mail_account_id=$1", [
      idA,
    ]);
    await client.query(
      `update public.mail_accounts set connection_state='disconnected',
          disconnected_at=now(), granted_scopes='{}' where id=$1`,
      [idA],
    );
    await client.query("commit");

    const b = await authorize(userId, { project, subject: subjectB });
    const idB = (b.outcome as { mailAccountId: string }).mailAccountId;
    await grantPrivateProcessingConsent({ userId, mailAccountId: idB }, deps(createFakeGoogle()));
    expect(await stillUsable(project, subjectB, idB)).toBe("ok");

    // "Reconnect A"; the account chooser returns B.
    const attack = await authorize(
      userId,
      { project, subject: subjectB },
      { purpose: "reconnect", targetMailAccountId: idA },
    );
    expect(attack.outcome!.result).toBe("account_mismatch");
    expect(attack.google.calls.revocations).toHaveLength(0);

    // B is still connected AND still works. Revoking here would have killed a
    // mailbox the human never mentioned.
    expect((await readMailAccount(client, idB)).connection_state).toBe("connected");
    expect(await stillUsable(project, subjectB, idB)).toBe("ok");
  });

  it("3. a cross-owner refusal does NOT invalidate the legitimate owner's grant", async () => {
    const project = createFakeGoogleProject();
    const subject = `S-${randomBytes(6).toString("hex")}`;
    const owner = await connectedIn(project, "rev3-owner", subject);
    expect(await stillUsable(project, subject, owner.mailAccountId)).toBe("ok");

    // Somebody else authorizes the same Google account. B01 refuses them.
    const stranger = await createTestUser(client, "rev3-stranger");
    const attack = await authorize(stranger, { project, subject });
    expect(attack.outcome!.result).toBe("owned_by_other_user");
    expect(attack.google.calls.revocations).toHaveLength(0);

    // THE POINT: a stranger must not be able to disconnect somebody else's
    // mailbox by authorizing a Google account and being told no.
    expect(await stillUsable(project, subject, owner.mailAccountId)).toBe("ok");
  });

  it("4. a callback that fails to persist does not kill a pre-existing connection", async () => {
    const project = createFakeGoogleProject();
    const existing = await connectedIn(project, "rev4-existing");
    expect(await stillUsable(project, existing.subject, existing.mailAccountId)).toBe("ok");

    // A brand-new authorization for the same user whose local write fails.
    const failing: FakeAdminClient = {
      async rpc(name, args) {
        if (name === "gmail_connection_persist") {
          return { data: null, error: { message: "storage unavailable" } };
        }
        return realDb.rpc(name, args);
      },
    };
    const newSubject = `N-${randomBytes(6).toString("hex")}`;
    const google = createFakeGoogle({ project, subject: newSubject });
    const started = await startGmailAuthorization(
      { userId: existing.userId, purpose: "connect" },
      deps(google, failing),
    );
    const url = new URL((started as { authorizationUrl: string }).authorizationUrl);
    const outcome = await completeGmailAuthorization(
      { userId: existing.userId, state: url.searchParams.get("state"), code: "c", error: null },
      deps(google, failing),
    );

    expect(outcome.result).toBe("persist_failed");
    expect(google.calls.revocations).toHaveLength(0);
    expect(await stillUsable(project, existing.subject, existing.mailAccountId)).toBe("ok");
  });

  it("5/6. explicit Disconnect DOES revoke the project grant and removes the credential", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "rev5");
    expect(await stillUsable(project, subject, mailAccountId)).toBe("ok");

    const google = createFakeGoogle({ project, subject });
    const outcome = await disconnectGmailAccount({ userId, mailAccountId }, deps(google));

    // This is the one place the project-wide operation is what was asked for.
    expect(outcome.result).toBe("disconnected");
    expect(google.calls.revocations).toHaveLength(1);
    expect(project.revokedSubjects()).toEqual([subject]);
    expect(await countCredentials(client, mailAccountId)).toBe(0);
    expect((await readMailAccount(client, mailAccountId)).connection_state).toBe("disconnected");
  });

  it("7/8. a rejected callback token is neither persisted nor logged", async () => {
    const project = createFakeGoogleProject();
    const userId = await createTestUser(client, "rev7");
    const secret = "1//SECRET-REFRESH-TOKEN-FROM-A-REFUSED-CALLBACK";

    const logged: string[] = [];
    const warn = console.warn;
    const error = console.error;
    console.warn = (...a: unknown[]) => void logged.push(JSON.stringify(a));
    console.error = (...a: unknown[]) => void logged.push(JSON.stringify(a));
    try {
      // A grant carrying a forbidden scope: refused after the token was issued.
      const google = createFakeGoogle({
        project,
        refreshToken: secret,
        grantedScopes: ["https://mail.google.com/"],
      });
      const started = await startGmailAuthorization({ userId, purpose: "connect" }, deps(google));
      const url = new URL((started as { authorizationUrl: string }).authorizationUrl);
      const outcome = await completeGmailAuthorization(
        { userId, state: url.searchParams.get("state"), code: "c", error: null },
        deps(google),
      );
      expect(outcome.result).toBe("scope_refused");
    } finally {
      console.warn = warn;
      console.error = error;
    }

    // Nowhere in the database...
    const stored = await client.query(
      `select count(*)::int n from private.gmail_oauth_credentials
        where refresh_token_ciphertext like '%' || $1 || '%'`,
      [secret],
    );
    expect(stored.rows[0].n).toBe(0);
    const anyCredential = await client.query(
      "select count(*)::int n from private.gmail_oauth_credentials c join public.mail_accounts m on m.id=c.mail_account_id where m.user_id=$1",
      [userId],
    );
    expect(anyCredential.rows[0].n).toBe(0);

    // ...and nowhere in the logs.
    for (const line of logged) expect(line).not.toContain(secret);
  });
});

d("amendment #2 — a credential mutation names the credential it came from", () => {
  it("9. a stale worker cannot overwrite a newer rotated credential", async () => {
    const project = createFakeGoogleProject();
    const { mailAccountId } = await connectedIn(project, "cas1");

    // Both workers load the SAME generation.
    const loaded = await generationOf(mailAccountId);

    // Worker B rotates first.
    const rotated = await client.query(
      "select public.gmail_credential_replace($1, $2, 'R2', 'iv', 'tag', 'v1', null) as r",
      [mailAccountId, loaded],
    );
    expect(rotated.rows[0].r.result).toBe("ok");
    const afterB = await generationOf(mailAccountId);
    expect(afterB).toBeGreaterThan(loaded);

    // Worker A, still holding the old generation, writes its own successor.
    const stale = await client.query(
      "select public.gmail_credential_replace($1, $2, 'R1-DERIVED-STALE', 'iv', 'tag', 'v1', null) as r",
      [mailAccountId, loaded],
    );
    expect(stale.rows[0].r.result).toBe("stale_credential");
    expect(await generationOf(mailAccountId)).toBe(afterB);
    expect(await ciphertextOf(mailAccountId)).toBe("R2");
  });

  it("10. a stale invalid_grant cannot delete a newer credential", async () => {
    const project = createFakeGoogleProject();
    const { mailAccountId } = await connectedIn(project, "cas2");
    const loaded = await generationOf(mailAccountId);

    await client.query(
      "select public.gmail_credential_replace($1, $2, 'R2', 'iv', 'tag', 'v1', null)",
      [mailAccountId, loaded],
    );
    const afterRotation = await generationOf(mailAccountId);
    expect(afterRotation).toBeGreaterThan(loaded);

    // Worker A holds the old generation and Google rejects the token IT loaded.
    const stale = await client.query("select public.gmail_mark_reauth_required($1, $2) as r", [
      mailAccountId,
      loaded,
    ]);
    expect(stale.rows[0].r.result).toBe("stale_credential");

    // The newer credential survives, and the mailbox stays connected: nothing
    // has shown that R2 is dead.
    expect(await countCredentials(client, mailAccountId)).toBe(1);
    expect(await generationOf(mailAccountId)).toBe(afterRotation);
    expect((await readMailAccount(client, mailAccountId)).connection_state).toBe("connected");
  });

  it("11. a stale invalid_grant cannot undo an explicit Disconnect", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "cas3");
    // A worker is mid-refresh holding this generation. The human disconnects.
    const loaded = await generationOf(mailAccountId);

    await disconnectGmailAccount(
      { userId, mailAccountId },
      deps(createFakeGoogle({ project, subject })),
    );
    expect((await readMailAccount(client, mailAccountId)).connection_state).toBe("disconnected");

    const stale = await client.query("select public.gmail_mark_reauth_required($1, $2) as r", [
      mailAccountId,
      loaded,
    ]);
    expect(stale.rows[0].r.result).toBe("state_changed");

    // `reauth_required` would read as "please reconnect" about a decision they
    // already made. It stays disconnected.
    expect((await readMailAccount(client, mailAccountId)).connection_state).toBe("disconnected");
    expect(await countCredentials(client, mailAccountId)).toBe(0);
  });

  it("12. rotation CAS refuses once the human has disconnected", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "cas4");
    const loaded = await generationOf(mailAccountId);
    await disconnectGmailAccount(
      { userId, mailAccountId },
      deps(createFakeGoogle({ project, subject })),
    );

    const late = await client.query(
      "select public.gmail_credential_replace($1, $2, 'LATE', 'iv', 'tag', 'v1', null) as r",
      [mailAccountId, loaded],
    );
    expect(late.rows[0].r.result).toBe("state_changed");
    expect(await countCredentials(client, mailAccountId)).toBe(0);
  });

  it("13. the application does NOT claim reauth_required on a transport failure", async () => {
    const project = createFakeGoogleProject();
    const { mailAccountId } = await connectedIn(project, "cas5");

    const faulty: FakeAdminClient = {
      async rpc(name, args) {
        if (name === "gmail_mark_reauth_required") {
          return { data: null, error: { message: "unavailable" } };
        }
        return realDb.rpc(name, args);
      },
    };
    const google = createFakeGoogle({
      refreshError: new GoogleAdapterError("invalid_grant", true),
    });
    const outcome = await getFreshGmailAccessToken({ mailAccountId }, deps(google, faulty));

    // The transition did not happen, so it is not reported.
    expect(outcome.result).not.toBe("reauth_required");
    expect(outcome.result).toBe("provider_unavailable");
    expect((await readMailAccount(client, mailAccountId)).connection_state).toBe("connected");
    expect(await countCredentials(client, mailAccountId)).toBe(1);
  });

  it("14. the application does NOT claim reauth_required on a stale refusal", async () => {
    const project = createFakeGoogleProject();
    const { mailAccountId } = await connectedIn(project, "cas6");

    const faulty: FakeAdminClient = {
      async rpc(name, args) {
        if (name === "gmail_mark_reauth_required") {
          return { data: { result: "stale_credential" } as never, error: null };
        }
        return realDb.rpc(name, args);
      },
    };
    const google = createFakeGoogle({
      refreshError: new GoogleAdapterError("invalid_grant", true),
    });
    const outcome = await getFreshGmailAccessToken({ mailAccountId }, deps(google, faulty));

    expect(outcome.result).toBe("state_changed");
    expect((await readMailAccount(client, mailAccountId)).connection_state).toBe("connected");
    expect(await countCredentials(client, mailAccountId)).toBe(1);
  });

  it("15. a successful rotation advances the generation and returns a token", async () => {
    const project = createFakeGoogleProject();
    const { mailAccountId, subject } = await connectedIn(project, "cas7");
    const before = await ciphertextOf(mailAccountId);
    const loaded = await generationOf(mailAccountId);

    const google = createFakeGoogle({
      project,
      subject,
      rotatedRefreshToken: "replacement-token",
    });
    const outcome = await getFreshGmailAccessToken({ mailAccountId }, deps(google));

    expect(outcome.result).toBe("ok");
    expect(await generationOf(mailAccountId)).toBeGreaterThan(loaded);
    expect(await ciphertextOf(mailAccountId)).not.toBe(before);
  });

  it("16. a rotation whose CAS is stale returns no access token", async () => {
    const project = createFakeGoogleProject();
    const { mailAccountId, subject } = await connectedIn(project, "cas8");

    // Somebody rotates between our load and our write.
    const racing: FakeAdminClient = {
      async rpc(name, args) {
        if (name === "gmail_credential_replace") {
          await realDb.rpc("gmail_credential_replace", {
            p_mail_account_id: mailAccountId,
            p_expected_generation: args.p_expected_generation,
            p_refresh_ciphertext: "SOMEBODY-ELSES-R2",
            p_refresh_iv: "iv",
            p_refresh_auth_tag: "tag",
            p_key_version: "v1",
            p_provider_refresh_expires_at: null,
          });
          return realDb.rpc(name, args);
        }
        return realDb.rpc(name, args);
      },
    };
    const google = createFakeGoogle({ project, subject, rotatedRefreshToken: "ours" });
    const outcome = await getFreshGmailAccessToken({ mailAccountId }, deps(google, racing));

    expect(outcome.result).toBe("state_changed");
    // Theirs stands; ours is discarded rather than forced through.
    expect(await ciphertextOf(mailAccountId)).toBe("SOMEBODY-ELSES-R2");
  });

  it("17. a disconnect during the refresh call withholds the access token", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "cas9");

    // The human disconnects while we are talking to Google — modelled by
    // disconnecting between the refresh call and the currentness check.
    const racing: FakeAdminClient = {
      async rpc(name, args) {
        if (name === "gmail_credential_currentness") {
          await disconnectGmailAccount(
            { userId, mailAccountId },
            deps(createFakeGoogle({ project, subject })),
          );
        }
        return realDb.rpc(name, args);
      },
    };
    const google = createFakeGoogle({ project, subject });
    const outcome = await getFreshGmailAccessToken({ mailAccountId }, deps(google, racing));

    // The token exists in memory and is thrown away: handing it to a caller
    // would be acting on an authorization the human just withdrew.
    expect(outcome.result).toBe("state_changed");
    expect(await countCredentials(client, mailAccountId)).toBe(0);
  });

  it("18. an unchanged, still-current connection returns its access token", async () => {
    const project = createFakeGoogleProject();
    const { mailAccountId, subject } = await connectedIn(project, "cas10");
    const before = await generationOf(mailAccountId);
    const outcome = await getFreshGmailAccessToken(
      { mailAccountId },
      deps(createFakeGoogle({ project, subject })),
    );
    expect(outcome.result).toBe("ok");
    // No rotation happened, so the generation is untouched.
    expect(await generationOf(mailAccountId)).toBe(before);
  });

  it("19. a reconnection advances the generation, so work in flight is stale", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "cas11");
    const before = await generationOf(mailAccountId);

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

    const again = await authorize(userId, { project, subject });
    expect((again.outcome as { mailAccountId: string }).mailAccountId).toBe(mailAccountId);
    // A fresh credential is a NEW generation even though the row is the same and
    // the old credential row was deleted in between — a per-row counter would
    // have restarted at 1 and matched a stale worker's remembered value.
    expect(await generationOf(mailAccountId)).toBeGreaterThan(before);
  });

  it("20. the generation is a database-owned counter, not a timestamp", async () => {
    const res = await client.query(
      `select data_type, column_default, is_nullable
         from information_schema.columns
        where table_schema='private' and table_name='gmail_oauth_credentials'
          and column_name='credential_generation'`,
    );
    // Two writes in the same microsecond compare equal, and clock order is not
    // causal order — so the concurrency token is an integer, not a time.
    expect(res.rows[0].data_type).toBe("bigint");
    expect(res.rows[0].is_nullable).toBe("NO");
    // ...and it comes from a sequence, so a number is never reissued.
    expect(res.rows[0].column_default).toContain("gmail_credential_generation_seq");
  });
});

d("amendment #2 — pending_authorization means the whole sentence", () => {
  it("21. `pending_authorization` may not hold a granted scope set", async () => {
    const userId = await createTestUser(client, "pending-scope");
    const [row] = (
      await client.query(
        `insert into public.mail_accounts (user_id, provider, provider_account_subject, email_address)
         values ($1,'gmail',$2,'x@example.invalid') returning id`,
        [userId, `sub-${randomBytes(8).toString("hex")}`],
      )
    ).rows;

    await client.query("begin");
    let message = "";
    try {
      await client.query(
        `update public.mail_accounts
            set granted_scopes = array['https://www.googleapis.com/auth/gmail.readonly']::text[]
          where id = $1`,
        [row.id],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      message = (error as Error).message;
    }
    expect(message).toMatch(/is `pending_authorization` holding scopes/);
  });

  it("22. `reauth_required` still keeps the last known scope set", async () => {
    const project = createFakeGoogleProject();
    const { mailAccountId } = await connectedIn(project, "reauth-scope");
    const before = (await readMailAccount(client, mailAccountId)).granted_scopes;

    await client.query(
      `select public.gmail_mark_reauth_required($1, (select credential_generation from private.gmail_oauth_credentials where mail_account_id = $1))`,
      [mailAccountId],
    );
    const after = await readMailAccount(client, mailAccountId);

    // The two states say different things and must not be collapsed: this one
    // records what the human actually authorized, which is what a reconnection
    // is trying to restore.
    expect(after.connection_state).toBe("reauth_required");
    expect(after.granted_scopes).toEqual(before);
  });
});
