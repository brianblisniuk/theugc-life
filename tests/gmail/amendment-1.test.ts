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
import { B02_REQUESTED_SCOPES, GMAIL_READONLY_SCOPE } from "@/lib/gmail/contract";
import { resetGmailOAuthConfigCache } from "@/lib/gmail/env.server";
import { GoogleAdapterError } from "@/lib/gmail/google.server";

import { createFakeGoogle, type FakeGoogleOptions } from "./fake-google";
import {
  countCredentials,
  createRpcClient,
  createTestUser,
  readMailAccount,
  type FakeAdminClient,
} from "./rpc-harness";

/**
 * B02 EXTERNAL AUDIT AMENDMENT #1.
 *
 * Five things the first round got wrong, each of which was reproducible as a
 * real committed state rather than a theoretical worry:
 *
 *   A  a successful Google authorization sat in `pending_authorization` — a
 *      state 0035 defines as "the human has not authorized and we hold no
 *      access" — while holding gmail.readonly and a live refresh token.
 *   B  "reconnect mailbox A" fell through to a generic connect when the human
 *      picked a different Google account at the account chooser, silently
 *      creating a new mailbox or reporting success for one they never named.
 *   C  three errors Google documents against OUR client and OUR request were
 *      treated as proof that the CREATOR's refresh token was dead, so one wrong
 *      environment variable would delete every credential it touched.
 *   D  a rotated refresh token whose storage failed was reported as a successful
 *      refresh, leaving a mailbox holding a value that stops working.
 *   E  Disconnect loaded the encrypted credential for a browser-supplied mailbox
 *      id and compared owners afterwards.
 *
 * Every test below fails against the audited head and passes here.
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

/** Drive a whole authorization: start, capture the real state, complete. */
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

/** A mailbox that is connected for real: credential, scopes, consent, state. */
async function connectedMailbox(label: string, options: FakeGoogleOptions = {}) {
  const userId = await createTestUser(client, label);
  const subject = options.subject ?? `sub-${randomBytes(8).toString("hex")}`;
  const { outcome } = await authorize(userId, { ...options, subject });
  const mailAccountId = (outcome as { mailAccountId: string }).mailAccountId;
  await grantPrivateProcessingConsent({ userId, mailAccountId }, deps(createFakeGoogle()));
  return { userId, mailAccountId, subject };
}

/** Stop a connection the way 0036 does: credential and state in ONE transaction. */
async function releaseConnection(mailAccountId: string): Promise<void> {
  await client.query("begin");
  try {
    await client.query("delete from private.gmail_oauth_credentials where mail_account_id = $1", [
      mailAccountId,
    ]);
    await client.query(
      `update public.mail_accounts set connection_state='disconnected',
          disconnected_at=now(), granted_scopes='{}' where id=$1`,
      [mailAccountId],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

/** Run a statement inside a transaction and return the COMMIT-time error, if any. */
async function commitError(run: () => Promise<void>): Promise<string | null> {
  await client.query("begin");
  try {
    await run();
    await client.query("commit");
    return null;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    return (error as Error).message;
  }
}

d("amendment #1 — the state word tells the truth", () => {
  it("1. a Google grant with no product consent is `consent_required`, not `pending_authorization`", async () => {
    const userId = await createTestUser(client, "state1");
    const { outcome } = await authorize(userId);
    expect(outcome!.result).toBe("consent_required");

    const id = (outcome as { mailAccountId: string }).mailAccountId;
    const row = await readMailAccount(client, id);

    // The three facts that made `pending_authorization` a lie here.
    expect(row.connection_state).toBe("consent_required");
    expect(row.granted_scopes).toContain(GMAIL_READONLY_SCOPE);
    expect(await countCredentials(client, id)).toBe(1);
  });

  it("2. `pending_authorization` may not hold a credential", async () => {
    const userId = await createTestUser(client, "state2");
    const [row] = (
      await client.query(
        `insert into public.mail_accounts (user_id, provider, provider_account_subject, email_address)
         values ($1,'gmail',$2,'x@example.invalid') returning id`,
        [userId, `sub-${randomBytes(8).toString("hex")}`],
      )
    ).rows;

    expect(await countCredentials(client, row.id)).toBe(0);
    const error = await commitError(async () => {
      await client.query(
        `insert into private.gmail_oauth_credentials
           (mail_account_id, user_id, refresh_token_ciphertext, refresh_token_iv,
            refresh_token_auth_tag, encryption_key_version)
         values ($1,$2,'ct','iv','tag','v1')`,
        [row.id, userId],
      );
    });
    expect(error).toMatch(/is `pending_authorization` while a Gmail refresh credential/);
  });

  it("3. `connected` requires a credential", async () => {
    const { mailAccountId } = await connectedMailbox("state3");
    expect(await countCredentials(client, mailAccountId)).toBe(1);
  });

  it("4. deleting the credential of a connected mailbox is refused at COMMIT", async () => {
    const { mailAccountId } = await connectedMailbox("state4");
    const error = await commitError(async () => {
      await client.query("delete from private.gmail_oauth_credentials where mail_account_id = $1", [
        mailAccountId,
      ]);
    });
    expect(error).toMatch(/is `connected` with 0 stored credentials/);
    expect(await countCredentials(client, mailAccountId)).toBe(1);
  });

  it("5. inserting a credential under a disconnected mailbox is refused at COMMIT", async () => {
    const { userId, mailAccountId } = await connectedMailbox("state5");
    await releaseConnection(mailAccountId);

    const error = await commitError(async () => {
      await client.query(
        `insert into private.gmail_oauth_credentials
           (mail_account_id, user_id, refresh_token_ciphertext, refresh_token_iv,
            refresh_token_auth_tag, encryption_key_version)
         values ($1,$2,'ct','iv','tag','v1')`,
        [mailAccountId, userId],
      );
    });
    expect(error).toMatch(/is `disconnected` while a Gmail refresh credential/);
  });

  it("6. `reauth_required` holds no credential", async () => {
    const { mailAccountId } = await connectedMailbox("state6");
    await client.query("select public.gmail_mark_reauth_required($1)", [mailAccountId]);
    expect((await readMailAccount(client, mailAccountId)).connection_state).toBe("reauth_required");
    expect(await countCredentials(client, mailAccountId)).toBe(0);
  });

  it("7. `disconnected` holds no credential", async () => {
    const { userId, mailAccountId } = await connectedMailbox("state7");
    const outcome = await disconnectGmailAccount(
      { userId, mailAccountId },
      deps(createFakeGoogle()),
    );
    expect(outcome.result).toBe("disconnected");
    expect(await countCredentials(client, mailAccountId)).toBe(0);
  });

  it("8. `consent_required` cannot survive a matching granted consent", async () => {
    const { mailAccountId } = await connectedMailbox("state8");
    // A granted, exact-scope consent is on file, so the decision this state is
    // waiting for has already been made.
    const error = await commitError(async () => {
      await client.query(
        `update public.mail_accounts set connection_state='consent_required',
            last_state_change_at=now() where id=$1`,
        [mailAccountId],
      );
    });
    expect(error).toMatch(/while holding a granted private_gmail_processing consent/);
  });

  it("9. `consent_required` is accepted when the consent is absent, withdrawn or narrower", async () => {
    // Absent: this is what a fresh authorization produces.
    const fresh = await createTestUser(client, "state9a");
    const { outcome } = await authorize(fresh);
    const freshId = (outcome as { mailAccountId: string }).mailAccountId;
    expect((await readMailAccount(client, freshId)).connection_state).toBe("consent_required");

    // Withdrawn: the receipt says no, so the mailbox is waiting again.
    const { userId, mailAccountId, subject } = await connectedMailbox("state9b");
    await releaseConnection(mailAccountId);
    await client.query("begin");
    const withdrawal = await client.query(
      `insert into public.mail_account_consent_receipts
         (mail_account_id, user_id, consent_kind, decision, policy_version,
          consent_text_digest, granted_scopes_at_decision, decided_by_user_id,
          decided_at, receipt_digest)
       values ($1,$2,'private_gmail_processing','withdrawn','p/1',
               repeat('a',64), '{}', $2, now(), repeat('b',64))
       returning id, event_seq`,
      [mailAccountId, userId],
    );
    await client.query(
      `update public.mail_account_consents
          set state='withdrawn', current_receipt_id=$2, current_event_seq=$3
        where mail_account_id=$1 and consent_kind='private_gmail_processing'`,
      [mailAccountId, withdrawal.rows[0].id, withdrawal.rows[0].event_seq],
    );
    await client.query("commit");

    const again = await authorize(userId, { subject });
    expect(again.outcome!.result).toBe("consent_required");
    expect((await readMailAccount(client, mailAccountId)).connection_state).toBe(
      "consent_required",
    );

    // Mismatched: a granted consent whose snapshot describes a NARROWER mailbox
    // than the one now authorized. B01 already says that is not consent for the
    // wider set, and `consent_required` is the state that says so out loud.
    const widened = await connectedMailbox("state9c-narrow");
    await releaseConnection(widened.mailAccountId);
    const wider = await authorize(widened.userId, {
      subject: widened.subject,
      grantedScopes: [...B02_REQUESTED_SCOPES, "https://www.googleapis.com/auth/gmail.send"],
    });
    expect(wider.outcome!.result).toBe("consent_required");
    expect((await readMailAccount(client, widened.mailAccountId)).connection_state).toBe(
      "consent_required",
    );
  });

  it("`consent_required` without gmail.readonly is refused", async () => {
    const userId = await createTestUser(client, "state9c");
    const [row] = (
      await client.query(
        `insert into public.mail_accounts (user_id, provider, provider_account_subject, email_address)
         values ($1,'gmail',$2,'x@example.invalid') returning id`,
        [userId, `sub-${randomBytes(8).toString("hex")}`],
      )
    ).rows;

    const error = await commitError(async () => {
      await client.query(
        `update public.mail_accounts
            set connection_state='consent_required', granted_scopes=array['openid']::text[]
          where id=$1`,
        [row.id],
      );
      await client.query(
        `insert into private.gmail_oauth_credentials
           (mail_account_id, user_id, refresh_token_ciphertext, refresh_token_iv,
            refresh_token_auth_tag, encryption_key_version)
         values ($1,$2,'ct','iv','tag','v1')`,
        [row.id, userId],
      );
    });
    expect(error).toMatch(/is `consent_required` without `gmail.readonly`/);
  });
});

d("amendment #1 — a reconnect is bound to the mailbox it names", () => {
  it("10. reconnect A + an unseen Google account is account_mismatch, and creates nothing", async () => {
    const userId = await createTestUser(client, "recon-b1");
    const subjectA = `sub-a-${randomBytes(8).toString("hex")}`;
    const first = await authorize(userId, { subject: subjectA });
    const idA = (first.outcome as { mailAccountId: string }).mailAccountId;
    await releaseConnection(idA);

    const before = await client.query(
      "select count(*)::int n from public.mail_accounts where user_id=$1",
      [userId],
    );

    // The account chooser produced a Google identity we have never seen.
    const subjectB = `sub-b-${randomBytes(8).toString("hex")}`;
    const attack = await authorize(
      userId,
      { subject: subjectB },
      { purpose: "reconnect", targetMailAccountId: idA },
    );

    expect(attack.outcome!.result).toBe("account_mismatch");

    // NO new mailbox for B.
    const after = await client.query(
      "select count(*)::int n from public.mail_accounts where user_id=$1",
      [userId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const bRows = await client.query(
      "select count(*)::int n from public.mail_accounts where provider_account_subject=$1",
      [subjectB],
    );
    expect(bRows.rows[0].n).toBe(0);

    // The grant we refused to keep is handed back to Google.
    expect(attack.google.calls.revocations).toHaveLength(1);
  });

  it("11. reconnect A + an already-connected B is account_mismatch, not already_connected", async () => {
    const userId = await createTestUser(client, "recon-b2");

    const subjectA = `sub-a-${randomBytes(8).toString("hex")}`;
    const a = await authorize(userId, { subject: subjectA });
    const idA = (a.outcome as { mailAccountId: string }).mailAccountId;
    await releaseConnection(idA);

    const subjectB = `sub-b-${randomBytes(8).toString("hex")}`;
    const b = await authorize(userId, { subject: subjectB });
    const idB = (b.outcome as { mailAccountId: string }).mailAccountId;
    await grantPrivateProcessingConsent({ userId, mailAccountId: idB }, deps(createFakeGoogle()));
    const bCipherBefore = (
      await client.query(
        "select refresh_token_ciphertext from private.gmail_oauth_credentials where mail_account_id=$1",
        [idB],
      )
    ).rows[0].refresh_token_ciphertext;

    const attack = await authorize(
      userId,
      { subject: subjectB },
      { purpose: "reconnect", targetMailAccountId: idA },
    );

    expect(attack.outcome!.result).toBe("account_mismatch");
    // B's live credential is untouched: no swap under a working connection.
    const bCipherAfter = (
      await client.query(
        "select refresh_token_ciphertext from private.gmail_oauth_credentials where mail_account_id=$1",
        [idB],
      )
    ).rows[0].refresh_token_ciphertext;
    expect(bCipherAfter).toBe(bCipherBefore);
    expect((await readMailAccount(client, idB)).connection_state).toBe("connected");
  });

  it("12. reconnect A + the verified subject A is allowed", async () => {
    const userId = await createTestUser(client, "recon-ok");
    const subject = `sub-${randomBytes(8).toString("hex")}`;
    const first = await authorize(userId, { subject });
    const id = (first.outcome as { mailAccountId: string }).mailAccountId;
    await releaseConnection(id);

    const again = await authorize(
      userId,
      { subject },
      { purpose: "reconnect", targetMailAccountId: id },
    );
    expect(again.outcome!.result).toBe("consent_required");
    expect((again.outcome as { mailAccountId: string }).mailAccountId).toBe(id);
    expect(await countCredentials(client, id)).toBe(1);
  });

  it("13. a reconnect aimed at a retired mailbox is refused as retired", async () => {
    const userId = await createTestUser(client, "recon-dead");
    const subject = `sub-${randomBytes(8).toString("hex")}`;
    const first = await authorize(userId, { subject });
    const id = (first.outcome as { mailAccountId: string }).mailAccountId;

    // Retire it the legitimate B01 way.
    await client.query("begin");
    await client.query("delete from private.gmail_oauth_credentials where mail_account_id = $1", [
      id,
    ]);
    await client.query(
      `update public.mail_accounts set connection_state='disconnected',
          disconnected_at=now(), granted_scopes='{}' where id=$1`,
      [id],
    );
    const req = await client.query(
      `insert into public.mail_account_deletion_requests
         (mail_account_id, user_id, scope, requested_by_user_id, requested_at)
       values ($1,$2,'account_and_gmail_derived_data',$2, now()) returning id`,
      [id, userId],
    );
    await client.query(
      `update public.mail_accounts set connection_state='deletion_pending',
          current_deletion_request_id=$2 where id=$1`,
      [id, req.rows[0].id],
    );
    await client.query(
      "update public.mail_account_deletion_requests set status='completed', completed_at=now() where id=$1",
      [req.rows[0].id],
    );
    await client.query("update public.mail_accounts set connection_state='deleted' where id=$1", [
      id,
    ]);
    await client.query("commit");

    // The transaction can still name it — the composite FK only proves ownership
    // — so the refusal has to come from the persist step.
    const attack = await authorize(
      userId,
      { subject },
      { purpose: "reconnect", targetMailAccountId: id },
    );
    expect(attack.outcome!.result).toBe("account_retired");
    expect((await readMailAccount(client, id)).connection_state).toBe("deleted");
    expect(attack.google.calls.revocations).toHaveLength(1);
  });

  it("14. a `connect` transaction carrying a target is refused by the database", async () => {
    // The target is THIS user's own mailbox, so the composite FK is satisfied
    // and the IFF is the only thing left that can refuse. A target belonging to
    // somebody else would fail the foreign key and prove nothing about purpose.
    const { userId, mailAccountId } = await connectedMailbox("iff-connect");
    await expect(
      client.query(
        `insert into private.gmail_oauth_transactions
           (user_id, state_digest, nonce_digest, code_verifier_ciphertext, code_verifier_iv,
            code_verifier_auth_tag, encryption_key_version, purpose, target_mail_account_id,
            requested_scopes, expires_at)
         values ($1, repeat('a',64), repeat('b',64), 'ct','iv','tag','v1',
                 'connect', $2, $3::text[], now() + interval '10 minutes')`,
        [userId, mailAccountId, [...B02_REQUESTED_SCOPES]],
      ),
    ).rejects.toThrow(/purpose_target_iff/i);
  });

  it("15. a `reconnect` transaction with no target is refused by the database", async () => {
    const userId = await createTestUser(client, "iff-reconnect");
    await expect(
      client.query(
        `insert into private.gmail_oauth_transactions
           (user_id, state_digest, nonce_digest, code_verifier_ciphertext, code_verifier_iv,
            code_verifier_auth_tag, encryption_key_version, purpose, target_mail_account_id,
            requested_scopes, expires_at)
         values ($1, repeat('c',64), repeat('d',64), 'ct','iv','tag','v1',
                 'reconnect', null, $2::text[], now() + interval '10 minutes')`,
        [userId, [...B02_REQUESTED_SCOPES]],
      ),
    ).rejects.toThrow(/purpose_target_iff|violates check constraint/i);
  });

  it("16. a connect never carries a target, even when one is supplied", async () => {
    const { userId, mailAccountId } = await connectedMailbox("iff-drop");
    const google = createFakeGoogle();
    // The orchestration is what the route calls; a target on a connect is
    // dropped rather than passed through, so the insert cannot violate the IFF.
    const started = await startGmailAuthorization(
      { userId, purpose: "connect", targetMailAccountId: mailAccountId },
      deps(google),
    );
    expect(started.result).toBe("ok");

    const stored = await client.query(
      `select purpose, target_mail_account_id from private.gmail_oauth_transactions
        where user_id=$1 order by created_at desc limit 1`,
      [userId],
    );
    expect(stored.rows[0].purpose).toBe("connect");
    expect(stored.rows[0].target_mail_account_id).toBeNull();
  });
});

d("amendment #1 — only a dead token may destroy a credential", () => {
  const retained = [
    ["18. invalid_client", "invalid_client", "configuration_error"],
    ["19. invalid_request", "invalid_request", "configuration_error"],
    ["20. unauthorized_client", "unauthorized_client", "configuration_error"],
    ["21a. backend_error", "backend_error", "provider_unavailable"],
    ["21b. unknown_error", "unknown_error", "provider_unavailable"],
  ] as const;

  it("17. invalid_grant removes the credential and asks for reauthorization", async () => {
    const { mailAccountId } = await connectedMailbox("refresh-dead");
    const google = createFakeGoogle({
      refreshError: new GoogleAdapterError("invalid_grant", true),
    });
    const outcome = await getFreshGmailAccessToken({ mailAccountId }, deps(google));

    expect(outcome.result).toBe("reauth_required");
    expect(await countCredentials(client, mailAccountId)).toBe(0);
    expect((await readMailAccount(client, mailAccountId)).connection_state).toBe("reauth_required");
  });

  for (const [label, code, expected] of retained) {
    it(`${label} leaves the credential and the state alone`, async () => {
      const { mailAccountId } = await connectedMailbox(`refresh-${code}`);
      const before = (
        await client.query(
          "select refresh_token_ciphertext from private.gmail_oauth_credentials where mail_account_id=$1",
          [mailAccountId],
        )
      ).rows[0].refresh_token_ciphertext;

      // `permanent: true` on the adapter error is deliberately the WRONG answer
      // here: the refresh path has its own taxonomy and must not defer to a flag
      // any caller can set.
      const google = createFakeGoogle({ refreshError: new GoogleAdapterError(code, true) });
      const outcome = await getFreshGmailAccessToken({ mailAccountId }, deps(google));

      expect(outcome.result).toBe(expected);
      expect(await countCredentials(client, mailAccountId)).toBe(1);
      expect((await readMailAccount(client, mailAccountId)).connection_state).toBe("connected");
      const after = (
        await client.query(
          "select refresh_token_ciphertext from private.gmail_oauth_credentials where mail_account_id=$1",
          [mailAccountId],
        )
      ).rows[0].refresh_token_ciphertext;
      expect(after).toBe(before);
    });
  }
});

d("amendment #1 — storing a rotated token is part of refreshing", () => {
  it("22. a rotated token that IS stored is a success", async () => {
    const { mailAccountId } = await connectedMailbox("rot-ok");
    const before = (
      await client.query(
        "select refresh_token_ciphertext from private.gmail_oauth_credentials where mail_account_id=$1",
        [mailAccountId],
      )
    ).rows[0].refresh_token_ciphertext;

    const google = createFakeGoogle({ rotatedRefreshToken: "replacement-token" });
    const outcome = await getFreshGmailAccessToken({ mailAccountId }, deps(google));

    expect(outcome.result).toBe("ok");
    const after = (
      await client.query(
        "select refresh_token_ciphertext from private.gmail_oauth_credentials where mail_account_id=$1",
        [mailAccountId],
      )
    ).rows[0].refresh_token_ciphertext;
    expect(after).not.toBe(before);
  });

  it("23. a transport failure on the replacement write is NOT a success", async () => {
    const { mailAccountId } = await connectedMailbox("rot-transport");
    const faulty: FakeAdminClient = {
      async rpc(name, args) {
        if (name === "gmail_credential_replace") {
          return { data: null, error: { message: "storage unavailable" } };
        }
        return realDb.rpc(name, args);
      },
    };
    const google = createFakeGoogle({ rotatedRefreshToken: "replacement-token" });
    const outcome = await getFreshGmailAccessToken({ mailAccountId }, deps(google, faulty));

    expect(outcome.result).toBe("credential_storage_failed");
    // The PREVIOUS credential is kept: we cannot know from here whether Google
    // has already invalidated it, and destroying it would turn a storage blip
    // into a re-authorization the human has to perform by hand.
    expect(await countCredentials(client, mailAccountId)).toBe(1);
    expect((await readMailAccount(client, mailAccountId)).connection_state).toBe("connected");
  });

  it("24. a semantic failure on the replacement write is NOT a success", async () => {
    const { mailAccountId } = await connectedMailbox("rot-semantic");
    const faulty: FakeAdminClient = {
      async rpc(name, args) {
        if (name === "gmail_credential_replace") {
          return { data: { result: "no_credential" } as never, error: null };
        }
        return realDb.rpc(name, args);
      },
    };
    const google = createFakeGoogle({ rotatedRefreshToken: "replacement-token" });
    const outcome = await getFreshGmailAccessToken({ mailAccountId }, deps(google, faulty));

    // The RPC answered without erroring, and answered that nothing was written.
    // Reading only the transport error would have called this a success.
    expect(outcome.result).toBe("credential_storage_failed");
    expect(await countCredentials(client, mailAccountId)).toBe(1);
  });

  it("25. a refresh response with no access token is not a success either", async () => {
    const { mailAccountId } = await connectedMailbox("rot-noaccess");
    const google = createFakeGoogle();
    google.refreshAccessToken = async () => ({
      accessToken: "",
      refreshToken: "replacement-token",
      grantedScopes: [...B02_REQUESTED_SCOPES],
      idToken: null,
      expiryDate: null,
      refreshTokenExpiresAt: null,
    });
    const outcome = await getFreshGmailAccessToken({ mailAccountId }, deps(google));

    expect(outcome.result).toBe("provider_unavailable");
    // Settled BEFORE rotation is even attempted: an unusable response is not a
    // refresh, so nothing about it gets stored.
    const stored = await client.query(
      "select refresh_token_ciphertext from private.gmail_oauth_credentials where mail_account_id=$1",
      [mailAccountId],
    );
    expect(stored.rows).toHaveLength(1);
  });
});

d("amendment #1 — a user action loads only its own credential", () => {
  it("26. a stranger's mailbox id returns not_found, and no envelope is built", async () => {
    const victim = await connectedMailbox("owner-victim");
    const strangerId = await createTestUser(client, "owner-stranger");

    // At the RPC boundary: the owner is part of the lookup, so the envelope is
    // never assembled — not assembled and then discarded.
    const rpc = await client.query("select public.gmail_credential_load_for_owner($1,$2) as r", [
      strangerId,
      victim.mailAccountId,
    ]);
    const loaded = rpc.rows[0].r as Record<string, unknown>;
    expect(loaded.result).toBe("not_found");
    expect(Object.keys(loaded)).not.toContain("refresh_token_ciphertext");
    expect(Object.keys(loaded)).not.toContain("user_id");

    // And through the action the browser actually reaches. The RPCs it calls are
    // recorded, because the outcome alone cannot tell the two orderings apart:
    // loading the credential and THEN comparing owners also answers
    // `not_found`, having already crossed the boundary to get there.
    const called: string[] = [];
    const recording: FakeAdminClient = {
      async rpc(name, args) {
        called.push(name);
        return realDb.rpc(name, args);
      },
    };
    const google = createFakeGoogle();
    const outcome = await disconnectGmailAccount(
      { userId: strangerId, mailAccountId: victim.mailAccountId },
      deps(google, recording),
    );
    expect(called).toContain("gmail_credential_load_for_owner");
    // The ownerless loader is for trusted internal callers only; a user-initiated
    // action must never reach it with an id that came from a form.
    expect(called).not.toContain("gmail_credential_load");
    expect(outcome.result).toBe("not_found");
    expect(google.calls.revocations).toHaveLength(0);
    // The victim's connection is entirely untouched.
    expect(await countCredentials(client, victim.mailAccountId)).toBe(1);
    expect((await readMailAccount(client, victim.mailAccountId)).connection_state).toBe(
      "connected",
    );
  });

  it("27. the owner's own disconnect loads, revokes and finalizes", async () => {
    const { userId, mailAccountId } = await connectedMailbox("owner-self");
    const google = createFakeGoogle();
    const outcome = await disconnectGmailAccount({ userId, mailAccountId }, deps(google));

    expect(outcome.result).toBe("disconnected");
    expect(google.calls.revocations).toHaveLength(1);
    expect(await countCredentials(client, mailAccountId)).toBe(0);
  });

  it("disconnect revokes a mailbox that never reached `connected`", async () => {
    // A `consent_required` mailbox holds a LIVE Google grant. A disconnect that
    // skipped revoking it would leave the human authorized to an application
    // whose UI just told them they had stopped it.
    const userId = await createTestUser(client, "owner-consentless");
    const { outcome } = await authorize(userId);
    const mailAccountId = (outcome as { mailAccountId: string }).mailAccountId;

    const google = createFakeGoogle();
    const result = await disconnectGmailAccount({ userId, mailAccountId }, deps(google));
    expect(result.result).toBe("disconnected");
    expect(google.calls.revocations).toHaveLength(1);
    expect(await countCredentials(client, mailAccountId)).toBe(0);
  });
});

d("amendment #1 — a denied callback still ends its transaction", () => {
  it("28. a valid state with access_denied consumes the transaction", async () => {
    const userId = await createTestUser(client, "denied-consume");
    const google = createFakeGoogle();
    const started = await startGmailAuthorization({ userId, purpose: "connect" }, deps(google));
    const state = new URL(
      (started as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state")!;

    expect(
      (
        await client.query(
          "select count(*)::int n from private.gmail_oauth_transactions where user_id=$1",
          [userId],
        )
      ).rows[0].n,
    ).toBe(1);

    const outcome = await completeGmailAuthorization(
      { userId, state, code: null, error: "access_denied" },
      deps(google),
    );
    expect(outcome.result).toBe("access_denied");
    expect(google.calls.exchanges).toHaveLength(0);

    // The state digest, nonce digest and encrypted PKCE verifier are gone.
    expect(
      (
        await client.query(
          "select count(*)::int n from private.gmail_oauth_transactions where user_id=$1",
          [userId],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("29. replaying the same denied state is invalid_state", async () => {
    const userId = await createTestUser(client, "denied-replay");
    const google = createFakeGoogle();
    const started = await startGmailAuthorization({ userId, purpose: "connect" }, deps(google));
    const state = new URL(
      (started as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state")!;

    expect(
      (
        await completeGmailAuthorization(
          { userId, state, code: null, error: "access_denied" },
          deps(google),
        )
      ).result,
    ).toBe("access_denied");
    expect(
      (
        await completeGmailAuthorization(
          { userId, state, code: null, error: "access_denied" },
          deps(google),
        )
      ).result,
    ).toBe("invalid_state");
  });

  it("30. another user's denied state is refused, and the owner's survives", async () => {
    const owner = await createTestUser(client, "denied-owner");
    const stranger = await createTestUser(client, "denied-stranger");
    const google = createFakeGoogle();
    const started = await startGmailAuthorization(
      { userId: owner, purpose: "connect" },
      deps(google),
    );
    const state = new URL(
      (started as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state")!;

    const stolen = await completeGmailAuthorization(
      { userId: stranger, state, code: null, error: "access_denied" },
      deps(google),
    );
    expect(stolen.result).toBe("invalid_state");

    // Consumption is scoped by owner, so the real one is still there to use.
    expect(
      (
        await client.query(
          "select count(*)::int n from private.gmail_oauth_transactions where user_id=$1",
          [owner],
        )
      ).rows[0].n,
    ).toBe(1);
    const real = await completeGmailAuthorization(
      { userId: owner, state, code: null, error: "access_denied" },
      deps(google),
    );
    expect(real.result).toBe("access_denied");
  });
});

d("amendment #1 — what must not have changed", () => {
  it("31/32/33. PKCE S256, a verified nonce, and no raw state or nonce stored", async () => {
    const userId = await createTestUser(client, "preserve-a");
    const google = createFakeGoogle();
    const started = await startGmailAuthorization({ userId, purpose: "connect" }, deps(google));
    const url = new URL((started as { authorizationUrl: string }).authorizationUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("nonce")).toBeTruthy();

    const stored = await client.query(
      `select state_digest, nonce_digest from private.gmail_oauth_transactions
        where user_id=$1`,
      [userId],
    );
    // Digests, not values: what came back from Google cannot be read out of here.
    expect(stored.rows[0].state_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0].state_digest).not.toBe(url.searchParams.get("state"));
    expect(stored.rows[0].nonce_digest).not.toBe(url.searchParams.get("nonce"));

    // A mismatched nonce still refuses the whole authorization.
    const badNonce = await authorize(await createTestUser(client, "preserve-nonce"), {
      nonceOverride: "not-the-nonce-we-sent",
    });
    expect(badNonce.outcome!.result).toBe("identity_unverified");
    expect(badNonce.google.calls.revocations).toHaveLength(1);
  });

  it("34. the durable identity is still the verified Google subject, never the email", async () => {
    const userId = await createTestUser(client, "preserve-sub");
    const subject = `sub-${randomBytes(8).toString("hex")}`;
    const first = await authorize(userId, { subject, email: "before@example.invalid" });
    const id = (first.outcome as { mailAccountId: string }).mailAccountId;
    await releaseConnection(id);

    // Same Google account, new address: the SAME mailbox row.
    const second = await authorize(userId, { subject, email: "after@example.invalid" });
    expect((second.outcome as { mailAccountId: string }).mailAccountId).toBe(id);
    expect((await readMailAccount(client, id)).provider_account_subject).toBe(subject);
  });

  it("35/36/37. no send scope, no message store, no persisted access token", async () => {
    expect([...B02_REQUESTED_SCOPES]).not.toContain("https://www.googleapis.com/auth/gmail.send");

    const tables = await client.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname in ('public','private') and c.relkind='r'`,
    );
    const names = tables.rows.map((r) => r.relname as string);
    for (const forbidden of ["gmail_messages", "gmail_threads", "mail_messages", "mail_threads"]) {
      expect(names).not.toContain(forbidden);
    }

    const columns = await client.query(
      `select a.attname from pg_attribute a
         join pg_class c on c.oid=a.attrelid
         join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='private' and c.relkind='r' and a.attnum>0 and not a.attisdropped`,
    );
    const attrs = columns.rows.map((r) => r.attname as string);
    expect(attrs).not.toContain("access_token");
    expect(attrs).not.toContain("id_token");
    expect(attrs).not.toContain("authorization_code");
  });

  it("38. network contribution is still off after connecting and consenting", async () => {
    const { mailAccountId } = await connectedMailbox("preserve-network");
    const consented = await client.query(
      `select public.mail_account_has_consent($1,'network_intelligence_contribution') as net,
              public.mail_account_has_consent($1,'private_gmail_processing') as priv`,
      [mailAccountId],
    );
    expect(consented.rows[0].priv).toBe(true);
    expect(consented.rows[0].net).toBe(false);
  });

  it("39. B01's durable provider ownership still refuses a cross-owner claim", async () => {
    const subject = `sub-${randomBytes(8).toString("hex")}`;
    const first = await connectedMailbox("preserve-own-a", { subject });
    expect(first.mailAccountId).toBeTruthy();

    const other = await createTestUser(client, "preserve-own-b");
    const attack = await authorize(other, { subject });
    expect(attack.outcome!.result).toBe("owned_by_other_user");
    expect(attack.google.calls.revocations).toHaveLength(1);
  });

  it("40. B02 still reads no mail: only the profile endpoint is ever called", async () => {
    const userId = await createTestUser(client, "preserve-nomail");
    const { google } = await authorize(userId);
    expect(google.calls.profiles).toBe(1);
    expect(google.calls.messageListings).toBe(0);
  });
});
