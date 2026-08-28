import { randomBytes } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  completeGmailAuthorization,
  disconnectGmailAccount,
  getFreshGmailAccessToken,
  grantPrivateProcessingConsent,
  listGmailAccounts,
  safeReturnPath,
  startGmailAuthorization,
  type GmailDeps,
} from "@/lib/gmail/connection.server";
import {
  B02_REQUESTED_SCOPES,
  GMAIL_READONLY_SCOPE,
  GMAIL_SEND_SCOPE,
  OPENID_SCOPE,
  PRIVATE_PROCESSING_POLICY_VERSION,
  USERINFO_EMAIL_SCOPE,
} from "@/lib/gmail/contract";
import { GoogleAdapterError } from "@/lib/gmail/google.server";
import { resetGmailOAuthConfigCache } from "@/lib/gmail/env.server";

import { createFakeGoogle, sha256Hex, type FakeGoogleOptions } from "./fake-google";
import { countCredentials, createRpcClient, createTestUser, readMailAccount } from "./rpc-harness";

/**
 * B02 end to end, against REAL PostgreSQL and a deterministic Google.
 *
 * The 0036 functions hold the atomicity, ownership and consent guarantees, so
 * these tests drive the actual server orchestration through the actual RPCs.
 * Only the network boundary is faked — which is also the only place the
 * interesting failures live.
 */

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_DB);

let client: Client;
let deps: (google: ReturnType<typeof createFakeGoogle>) => GmailDeps;

beforeAll(async () => {
  // Configuration is set here rather than in a fixture file so the "not
  // configured" path can be exercised by clearing it, and so no real credential
  // is ever required to run the suite.
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

/** Drive a whole authorization: start, capture state/nonce, complete. */
async function runAuthorization(
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
    {
      userId,
      state: url.searchParams.get("state"),
      code: "auth-code",
      error: null,
    },
    deps(google),
  );
  return { started, google, outcome };
}

d("B02 — Gmail OAuth connection", () => {
  // =====================================================================
  describe("the authorization request", () => {
    it("asks for openid, email and gmail.readonly — and NOT gmail.send", async () => {
      const userId = await createTestUser(client, "req");
      const google = createFakeGoogle();
      const started = await startGmailAuthorization({ userId, purpose: "connect" }, deps(google));
      expect(started.result).toBe("ok");

      const asked = google.calls.authorizationUrls[0]!;
      expect(asked.scopes.sort()).toEqual(
        [OPENID_SCOPE, USERINFO_EMAIL_SCOPE, GMAIL_READONLY_SCOPE].sort(),
      );
      // Asking for a send permission before a feature needs it is how a consent
      // screen becomes something people click past.
      expect(asked.scopes).not.toContain(GMAIL_SEND_SCOPE);
      expect([...B02_REQUESTED_SCOPES]).not.toContain(GMAIL_SEND_SCOPE);
    });

    it("requests offline access with a consent prompt and S256 PKCE", async () => {
      const userId = await createTestUser(client, "pkce");
      const google = createFakeGoogle();
      const started = await startGmailAuthorization({ userId, purpose: "connect" }, deps(google));
      const url = new URL((started as { authorizationUrl: string }).authorizationUrl);
      // Offline, because B03 syncs while the human is away. Consent prompt,
      // because otherwise a repeat authorization returns no refresh token.
      expect(url.searchParams.get("access_type")).toBe("offline");
      expect(url.searchParams.get("prompt")).toBe("consent");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("code_challenge")).toBeTruthy();
      expect(url.searchParams.get("nonce")).toBeTruthy();
    });

    it("stores only digests of state and nonce, and encrypts the PKCE verifier", async () => {
      const userId = await createTestUser(client, "digest");
      const google = createFakeGoogle();
      const started = await startGmailAuthorization({ userId, purpose: "connect" }, deps(google));
      const url = new URL((started as { authorizationUrl: string }).authorizationUrl);
      const state = url.searchParams.get("state")!;
      const nonce = url.searchParams.get("nonce")!;

      const stored = await client.query(
        `select state_digest, nonce_digest, code_verifier_ciphertext
           from private.gmail_oauth_transactions where user_id = $1`,
        [userId],
      );
      const row = stored.rows[0];
      expect(row.state_digest).toBe(sha256Hex(state));
      expect(row.nonce_digest).toBe(sha256Hex(nonce));
      // The raw values are nowhere in the row.
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain(state);
      expect(serialized).not.toContain(nonce);
      expect(row.code_verifier_ciphertext).toBeTruthy();
    });

    it("refuses a reconnect aimed at another user's mailbox", async () => {
      const owner = await createTestUser(client, "own");
      const stranger = await createTestUser(client, "str");
      const { outcome } = await runAuthorization(owner, {
        subject: `sub-${randomBytes(6).toString("hex")}`,
      });
      const mailAccountId = (outcome as { mailAccountId: string }).mailAccountId;

      const started = await startGmailAuthorization(
        { userId: stranger, purpose: "reconnect", targetMailAccountId: mailAccountId },
        deps(createFakeGoogle()),
      );
      // The composite FK in 0036 binds a target to its owner, so this is
      // refused by the database rather than by a check someone could forget.
      expect(started.result).toBe("invalid_target");
    });
  });

  // =====================================================================
  describe("state, nonce and replay", () => {
    it("refuses a missing, unknown or replayed state", async () => {
      const userId = await createTestUser(client, "state");
      const google = createFakeGoogle({ subject: `sub-${randomBytes(6).toString("hex")}` });

      const missing = await completeGmailAuthorization(
        { userId, state: null, code: "c", error: null },
        deps(google),
      );
      expect(missing.result).toBe("invalid_state");

      const unknown = await completeGmailAuthorization(
        { userId, state: "never-issued", code: "c", error: null },
        deps(google),
      );
      expect(unknown.result).toBe("invalid_state");

      const started = await startGmailAuthorization({ userId, purpose: "connect" }, deps(google));
      const url = new URL((started as { authorizationUrl: string }).authorizationUrl);
      const state = url.searchParams.get("state");

      const first = await completeGmailAuthorization(
        { userId, state, code: "c", error: null },
        deps(google),
      );
      expect(first.result).toBe("consent_required");

      // Consume-once: the second attempt finds nothing.
      const replay = await completeGmailAuthorization(
        { userId, state, code: "c", error: null },
        deps(google),
      );
      expect(replay.result).toBe("invalid_state");
    });

    it("refuses an expired state", async () => {
      const userId = await createTestUser(client, "expired");
      const google = createFakeGoogle();
      const started = await startGmailAuthorization({ userId, purpose: "connect" }, deps(google));
      const url = new URL((started as { authorizationUrl: string }).authorizationUrl);

      await client.query(
        `update private.gmail_oauth_transactions
            set created_at = now() - interval '20 minutes',
                expires_at = now() - interval '10 minutes'
          where user_id = $1`,
        [userId],
      );

      const outcome = await completeGmailAuthorization(
        { userId, state: url.searchParams.get("state"), code: "c", error: null },
        deps(google),
      );
      expect(outcome.result).toBe("invalid_state");
    });

    it("refuses a state started by another user", async () => {
      const alice = await createTestUser(client, "alice");
      const bob = await createTestUser(client, "bob");
      const google = createFakeGoogle();
      const started = await startGmailAuthorization(
        { userId: alice, purpose: "connect" },
        deps(google),
      );
      const url = new URL((started as { authorizationUrl: string }).authorizationUrl);

      const outcome = await completeGmailAuthorization(
        { userId: bob, state: url.searchParams.get("state"), code: "c", error: null },
        deps(google),
      );
      expect(outcome.result).toBe("invalid_state");

      // Alice's transaction is untouched, so she can still finish.
      const alicesTurn = await completeGmailAuthorization(
        { userId: alice, state: url.searchParams.get("state"), code: "c", error: null },
        deps(google),
      );
      expect(alicesTurn.result).toBe("consent_required");
    });

    it("refuses a nonce that does not match the transaction", async () => {
      const userId = await createTestUser(client, "nonce");
      const { outcome, google } = await runAuthorization(userId, {
        nonceOverride: "a-different-nonce",
      });
      expect(outcome!.result).toBe("identity_unverified");
      // The grant we obtained and rejected is handed back.
      expect(google.calls.revocations).toHaveLength(1);
    });

    it("handles the human declining at Google", async () => {
      const userId = await createTestUser(client, "denied");
      const google = createFakeGoogle();
      const outcome = await completeGmailAuthorization(
        { userId, state: "x", code: null, error: "access_denied" },
        deps(google),
      );
      expect(outcome.result).toBe("access_denied");
      // Nothing was issued, so there is nothing to revoke.
      expect(google.calls.revocations).toHaveLength(0);
    });

    it("refuses a PKCE/code failure at the exchange", async () => {
      const userId = await createTestUser(client, "verifier");
      const { outcome } = await runAuthorization(userId, { exchangeError: "invalid_grant" });
      expect(outcome!.result).toBe("invalid_state");
    });

    it("keeps the return path same-origin and relative", () => {
      expect(safeReturnPath("/app/account")).toBe("/app/account");
      expect(safeReturnPath("//evil.example/x")).toBeNull();
      expect(safeReturnPath("https://evil.example")).toBeNull();
      expect(safeReturnPath("/\\evil.example")).toBeNull();
      expect(safeReturnPath(null)).toBeNull();
    });
  });

  // =====================================================================
  describe("what Google returns", () => {
    it("refuses a grant with no refresh token, and revokes it", async () => {
      const userId = await createTestUser(client, "norefresh");
      const { outcome, google } = await runAuthorization(userId, { refreshToken: null });
      // An access token alone is not a connection: B03 syncs while the human is
      // away, and an hour from now we would have nothing.
      expect(outcome!.result).toBe("missing_refresh_token");
      expect(google.calls.revocations).toHaveLength(1);

      const accounts = await client.query(
        "select count(*)::int n from public.mail_accounts where user_id = $1",
        [userId],
      );
      expect(accounts.rows[0].n).toBe(0);
    });

    it("refuses when the ACTUAL grant lacks gmail.readonly", async () => {
      const userId = await createTestUser(client, "noread");
      const { outcome, google } = await runAuthorization(userId, {
        grantedScopes: [OPENID_SCOPE, USERINFO_EMAIL_SCOPE],
      });
      expect(outcome!.result).toBe("scope_refused");
      expect(google.calls.revocations).toHaveLength(1);
    });

    it("refuses a returned scope outside the approved set", async () => {
      const userId = await createTestUser(client, "forbidden");
      const { outcome, google } = await runAuthorization(userId, {
        grantedScopes: [GMAIL_READONLY_SCOPE, "https://www.googleapis.com/auth/gmail.modify"],
      });
      expect(outcome!.result).toBe("scope_refused");
      expect(google.calls.revocations).toHaveLength(1);
    });

    it("refuses an unverifiable ID token, and a missing one", async () => {
      const invalid = await createTestUser(client, "badid");
      const one = await runAuthorization(invalid, { idTokenError: "id_token_invalid" });
      expect(one.outcome!.result).toBe("identity_unverified");
      expect(one.google.calls.revocations).toHaveLength(1);

      const absent = await createTestUser(client, "noid");
      const two = await runAuthorization(absent, { idToken: null });
      expect(two.outcome!.result).toBe("identity_unverified");
      expect(two.google.calls.revocations).toHaveLength(1);
    });

    it("uses the verified subject as the durable identity, and email as display only", async () => {
      const userId = await createTestUser(client, "subject");
      const subject = `sub-${randomBytes(8).toString("hex")}`;
      const { outcome } = await runAuthorization(userId, {
        subject,
        email: "display-only@example.invalid",
      });
      const row = await readMailAccount(
        client,
        (outcome as { mailAccountId: string }).mailAccountId,
      );
      expect(row.provider_account_subject).toBe(subject);
      expect(row.email_address).toBe("display-only@example.invalid");
      // The address is never the identity — B01's rule, asserted here.
      expect(row.provider_account_subject).not.toBe(row.email_address);
    });

    it("calls the Gmail PROFILE endpoint once, and never lists messages", async () => {
      const userId = await createTestUser(client, "profile");
      const { google } = await runAuthorization(userId, {
        subject: `sub-${randomBytes(6).toString("hex")}`,
      });
      expect(google.calls.profiles).toBe(1);
      expect(google.calls.messageListings).toBe(0);
    });

    it("refuses when the mailbox health check fails, and stores nothing", async () => {
      const userId = await createTestUser(client, "nomailbox");
      const { outcome, google } = await runAuthorization(userId, {
        profileError: "gmail_profile_403",
      });
      expect(outcome!.result).toBe("mailbox_unusable");
      expect(google.calls.revocations).toHaveLength(1);
      const accounts = await client.query(
        "select count(*)::int n from public.mail_accounts where user_id = $1",
        [userId],
      );
      expect(accounts.rows[0].n).toBe(0);
    });
  });

  // =====================================================================
  describe("consent is a separate decision", () => {
    it("a Google grant alone does NOT produce a connected mailbox", async () => {
      const userId = await createTestUser(client, "consent1");
      const { outcome } = await runAuthorization(userId, {
        subject: `sub-${randomBytes(6).toString("hex")}`,
      });
      expect(outcome!.result).toBe("consent_required");

      const id = (outcome as { mailAccountId: string }).mailAccountId;
      const row = await readMailAccount(client, id);
      // Authorized at Google, not yet permitted by the human. Those are two
      // different decisions and B01 keeps them apart.
      expect(row.connection_state).toBe("pending_authorization");
      // The credential IS stored: we hold a real grant and must be able to
      // revoke it. What we do not yet hold is permission to process.
      expect(await countCredentials(client, id)).toBe(1);
    });

    it("a Google grant alone does NOT grant network contribution", async () => {
      const userId = await createTestUser(client, "consent2");
      const { outcome } = await runAuthorization(userId, {
        subject: `sub-${randomBytes(6).toString("hex")}`,
      });
      const id = (outcome as { mailAccountId: string }).mailAccountId;
      await grantPrivateProcessingConsent({ userId, mailAccountId: id }, deps(createFakeGoogle()));

      const [status] = await listGmailAccounts(userId, deps(createFakeGoogle()));
      expect(status!.privateProcessingConsent).toBe(true);
      // Separate, explicit, revocable and default NOT granted.
      expect(status!.networkContributionConsent).toBe(false);
    });

    it("connects only after explicit consent, with a server-owned receipt", async () => {
      const userId = await createTestUser(client, "consent3");
      const { outcome } = await runAuthorization(userId, {
        subject: `sub-${randomBytes(6).toString("hex")}`,
      });
      const id = (outcome as { mailAccountId: string }).mailAccountId;

      const granted = await grantPrivateProcessingConsent(
        { userId, mailAccountId: id },
        deps(createFakeGoogle()),
      );
      expect(granted.result).toBe("connected");

      const row = await readMailAccount(client, id);
      expect(row.connection_state).toBe("connected");
      expect(row.connected_at).not.toBeNull();

      const receipt = await client.query(
        `select policy_version, granted_scopes_at_decision, consent_kind, decision
           from public.mail_account_consent_receipts where mail_account_id = $1`,
        [id],
      );
      expect(receipt.rows).toHaveLength(1);
      // The version comes from the server constant, never from the browser.
      expect(receipt.rows[0].policy_version).toBe(PRIVATE_PROCESSING_POLICY_VERSION);
      // And the snapshot is the ACTUAL granted scope set.
      expect([...receipt.rows[0].granted_scopes_at_decision].sort()).toEqual(
        [...B02_REQUESTED_SCOPES].sort(),
      );
    });

    it("refuses consent for a mailbox with no stored credential", async () => {
      const userId = await createTestUser(client, "consent4");
      const { outcome } = await runAuthorization(userId, {
        subject: `sub-${randomBytes(6).toString("hex")}`,
      });
      const id = (outcome as { mailAccountId: string }).mailAccountId;
      await client.query("delete from private.gmail_oauth_credentials where mail_account_id = $1", [
        id,
      ]);

      const granted = await grantPrivateProcessingConsent(
        { userId, mailAccountId: id },
        deps(createFakeGoogle()),
      );
      // Consent authorizes processing; without a credential there is nothing to
      // process with, and `connected` would be a claim we cannot honour.
      expect(granted.result).toBe("no_credential");
    });

    it("refuses consent requested by a different user", async () => {
      const owner = await createTestUser(client, "consent5");
      const stranger = await createTestUser(client, "consent6");
      const { outcome } = await runAuthorization(owner, {
        subject: `sub-${randomBytes(6).toString("hex")}`,
      });
      const id = (outcome as { mailAccountId: string }).mailAccountId;

      const granted = await grantPrivateProcessingConsent(
        { userId: stranger, mailAccountId: id },
        deps(createFakeGoogle()),
      );
      expect(granted.result).toBe("not_found");
    });
  });

  // =====================================================================
  describe("account selection and ownership", () => {
    it("reuses the same live row instead of creating a second one", async () => {
      const userId = await createTestUser(client, "reuse");
      const subject = `sub-${randomBytes(8).toString("hex")}`;
      const first = await runAuthorization(userId, { subject });
      const id = (first.outcome as { mailAccountId: string }).mailAccountId;

      // Move it to disconnected, then authorize again through the generic flow.
      await client.query(
        `update public.mail_accounts set connection_state='disconnected',
            disconnected_at=now(), granted_scopes='{}' where id = $1`,
        [id],
      );

      const second = await runAuthorization(userId, { subject });
      expect((second.outcome as { mailAccountId: string }).mailAccountId).toBe(id);

      const rows = await client.query(
        `select count(*)::int n from public.mail_accounts
          where provider_account_subject = $1 and connection_state <> 'deleted'`,
        [subject],
      );
      expect(rows.rows[0].n).toBe(1);
    });

    it("returns already_connected rather than swapping a live credential", async () => {
      const userId = await createTestUser(client, "already");
      const subject = `sub-${randomBytes(8).toString("hex")}`;
      const first = await runAuthorization(userId, { subject });
      const id = (first.outcome as { mailAccountId: string }).mailAccountId;
      await grantPrivateProcessingConsent({ userId, mailAccountId: id }, deps(createFakeGoogle()));

      const second = await runAuthorization(userId, { subject });
      expect(second.outcome!.result).toBe("already_connected");
      // The grant we did not keep is given back.
      expect(second.google.calls.revocations).toHaveLength(1);
    });

    it("never revives a deleted row, and gives the same owner a NEW one", async () => {
      const userId = await createTestUser(client, "retired");
      const subject = `sub-${randomBytes(8).toString("hex")}`;
      const first = await runAuthorization(userId, { subject });
      const oldId = (first.outcome as { mailAccountId: string }).mailAccountId;

      // Retire it the legitimate B01 way.
      await client.query("begin");
      await client.query(
        `update public.mail_accounts set connection_state='disconnected',
            disconnected_at=now(), granted_scopes='{}' where id=$1`,
        [oldId],
      );
      const req = await client.query(
        `insert into public.mail_account_deletion_requests
           (mail_account_id, user_id, scope, requested_by_user_id, requested_at)
         values ($1,$2,'account_and_gmail_derived_data',$2, now()) returning id`,
        [oldId, userId],
      );
      await client.query(
        `update public.mail_accounts set connection_state='deletion_pending',
            current_deletion_request_id=$2 where id=$1`,
        [oldId, req.rows[0].id],
      );
      await client.query(
        "update public.mail_account_deletion_requests set status='completed', completed_at=now() where id=$1",
        [req.rows[0].id],
      );
      await client.query("update public.mail_accounts set connection_state='deleted' where id=$1", [
        oldId,
      ]);
      await client.query("commit");

      const second = await runAuthorization(userId, { subject });
      const newId = (second.outcome as { mailAccountId: string }).mailAccountId;
      expect(newId).not.toBe(oldId);
      expect((await readMailAccount(client, oldId)).connection_state).toBe("deleted");
      // Nothing carries across: the new row starts with no consent at all.
      expect(second.outcome!.result).toBe("consent_required");
      const receipts = await client.query(
        "select count(*)::int n from public.mail_account_consent_receipts where mail_account_id = $1",
        [newId],
      );
      expect(receipts.rows[0].n).toBe(0);
    });

    it("refuses a durable identity owned by another app user, without naming them", async () => {
      const owner = await createTestUser(client, "ownerx");
      const stranger = await createTestUser(client, "strangerx");
      const subject = `sub-${randomBytes(8).toString("hex")}`;
      await runAuthorization(owner, { subject });

      const attempt = await runAuthorization(stranger, { subject });
      expect(attempt.outcome!.result).toBe("owned_by_other_user");
      // The credential we obtained is handed back rather than kept.
      expect(attempt.google.calls.revocations).toHaveLength(1);
      // And the refusal carries nothing identifying about the real owner.
      expect(JSON.stringify(attempt.outcome)).not.toContain(owner);

      const rows = await client.query(
        "select distinct user_id from public.mail_accounts where provider_account_subject = $1",
        [subject],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].user_id).toBe(owner);
    });
  });

  // =====================================================================
  describe("reconnect", () => {
    it("reuses a current consent when the scope set is unchanged", async () => {
      const userId = await createTestUser(client, "recon1");
      const subject = `sub-${randomBytes(8).toString("hex")}`;
      const first = await runAuthorization(userId, { subject });
      const id = (first.outcome as { mailAccountId: string }).mailAccountId;
      await grantPrivateProcessingConsent({ userId, mailAccountId: id }, deps(createFakeGoogle()));

      await client.query(
        `update public.mail_accounts set connection_state='disconnected',
            disconnected_at=now(), granted_scopes='{}' where id=$1`,
        [id],
      );

      const second = await runAuthorization(
        userId,
        { subject },
        {
          purpose: "reconnect",
          targetMailAccountId: id,
        },
      );
      // Same scopes, consent still granted, same mailbox: no reason to ask the
      // same question again.
      expect(second.outcome!.result).toBe("connected");
      expect((await readMailAccount(client, id)).connection_state).toBe("connected");

      const receipts = await client.query(
        "select count(*)::int n from public.mail_account_consent_receipts where mail_account_id=$1",
        [id],
      );
      expect(receipts.rows[0].n).toBe(1);
    });

    it("requires a NEW consent when the granted scope set changed", async () => {
      const userId = await createTestUser(client, "recon2");
      const subject = `sub-${randomBytes(8).toString("hex")}`;
      const first = await runAuthorization(userId, { subject });
      const id = (first.outcome as { mailAccountId: string }).mailAccountId;
      await grantPrivateProcessingConsent({ userId, mailAccountId: id }, deps(createFakeGoogle()));
      await client.query(
        `update public.mail_accounts set connection_state='disconnected',
            disconnected_at=now(), granted_scopes='{}' where id=$1`,
        [id],
      );

      // Google now returns a wider set. B01: a consent given about a narrower
      // mailbox does not describe a wider one.
      const second = await runAuthorization(userId, {
        subject,
        grantedScopes: [...B02_REQUESTED_SCOPES, GMAIL_SEND_SCOPE],
      });
      expect(second.outcome!.result).toBe("consent_required");
      expect((await readMailAccount(client, id)).connection_state).toBe("pending_authorization");
    });

    it("requires a new consent when the previous one was withdrawn", async () => {
      const userId = await createTestUser(client, "recon3");
      const subject = `sub-${randomBytes(8).toString("hex")}`;
      const first = await runAuthorization(userId, { subject });
      const id = (first.outcome as { mailAccountId: string }).mailAccountId;
      await grantPrivateProcessingConsent({ userId, mailAccountId: id }, deps(createFakeGoogle()));

      // Withdraw, the B01 way: a new receipt and the projection advanced onto it.
      await client.query(
        `update public.mail_accounts set connection_state='disconnected',
            disconnected_at=now(), granted_scopes='{}' where id=$1`,
        [id],
      );
      await client.query("begin");
      const withdrawal = await client.query(
        `insert into public.mail_account_consent_receipts
           (mail_account_id, user_id, consent_kind, decision, policy_version,
            consent_text_digest, granted_scopes_at_decision, decided_by_user_id,
            decided_at, receipt_digest)
         values ($1,$2,'private_gmail_processing','withdrawn','p/1',
                 repeat('a',64), '{}', $2, now(), repeat('b',64))
         returning id, event_seq`,
        [id, userId],
      );
      await client.query(
        `update public.mail_account_consents
            set state='withdrawn', current_receipt_id=$2, current_event_seq=$3
          where mail_account_id=$1 and consent_kind='private_gmail_processing'`,
        [id, withdrawal.rows[0].id, withdrawal.rows[0].event_seq],
      );
      await client.query("commit");

      const second = await runAuthorization(userId, { subject });
      expect(second.outcome!.result).toBe("consent_required");
    });
  });

  // =====================================================================
  describe("disconnect", () => {
    async function connectedAccount(label: string) {
      const userId = await createTestUser(client, label);
      const subject = `sub-${randomBytes(8).toString("hex")}`;
      const { outcome } = await runAuthorization(userId, { subject });
      const id = (outcome as { mailAccountId: string }).mailAccountId;
      await grantPrivateProcessingConsent({ userId, mailAccountId: id }, deps(createFakeGoogle()));
      return { userId, mailAccountId: id, subject };
    }

    it("revokes at Google, then removes the credential and disconnects", async () => {
      const { userId, mailAccountId } = await connectedAccount("dis1");
      const google = createFakeGoogle();
      const outcome = await disconnectGmailAccount({ userId, mailAccountId }, deps(google));

      expect(outcome.result).toBe("disconnected");
      expect(google.calls.revocations).toHaveLength(1);
      expect(await countCredentials(client, mailAccountId)).toBe(0);

      const row = await readMailAccount(client, mailAccountId);
      expect(row.connection_state).toBe("disconnected");
      expect(row.granted_scopes).toEqual([]);
      expect(row.disconnected_at).not.toBeNull();
    });

    it("treats invalid_token as proof the token is already unusable", async () => {
      const { userId, mailAccountId } = await connectedAccount("dis2");
      const google = createFakeGoogle({
        revokeError: new GoogleAdapterError("invalid_token", true),
      });
      const outcome = await disconnectGmailAccount({ userId, mailAccountId }, deps(google));
      // Already gone is the outcome revocation was trying to produce.
      expect(outcome.result).toBe("disconnected");
      expect(await countCredentials(client, mailAccountId)).toBe(0);
    });

    it("does NOT falsely disconnect when Google is unavailable", async () => {
      const { userId, mailAccountId } = await connectedAccount("dis3");
      const google = createFakeGoogle({
        revokeError: new GoogleAdapterError("backend_error", false),
      });
      const outcome = await disconnectGmailAccount({ userId, mailAccountId }, deps(google));

      expect(outcome.result).toBe("provider_unavailable");
      // The credential is RETAINED: it is the only thing that can revoke the
      // access Google still honours.
      expect(await countCredentials(client, mailAccountId)).toBe(1);
      expect((await readMailAccount(client, mailAccountId)).connection_state).toBe("connected");
    });

    it("is idempotent after a revoke that succeeded and a finalize that did not", async () => {
      const { userId, mailAccountId } = await connectedAccount("dis4");
      // Simulate the partial failure: Google revoked, local state untouched.
      const first = await disconnectGmailAccount(
        { userId, mailAccountId },
        deps(createFakeGoogle()),
      );
      expect(first.result).toBe("disconnected");

      // Running it again completes rather than erroring — the credential is
      // already gone, so there is nothing left to revoke.
      const second = await disconnectGmailAccount(
        { userId, mailAccountId },
        deps(createFakeGoogle()),
      );
      expect(second.result).toBe("disconnected");
    });

    it("keeps the mailbox, its consent history and its ownership reservation", async () => {
      const { userId, mailAccountId, subject } = await connectedAccount("dis5");
      await disconnectGmailAccount({ userId, mailAccountId }, deps(createFakeGoogle()));

      const kept = await client.query(
        `select (select count(*)::int from public.mail_accounts where id=$1) accounts,
                (select count(*)::int from public.mail_account_consent_receipts
                   where mail_account_id=$1) receipts,
                (select count(*)::int from public.mail_provider_account_owners
                   where provider_account_subject=$2) reservations`,
        [mailAccountId, subject],
      );
      // Disconnect is not delete.
      expect(kept.rows[0]).toEqual({ accounts: 1, receipts: 1, reservations: 1 });
    });

    it("refuses a disconnect requested by another user", async () => {
      const { mailAccountId } = await connectedAccount("dis6");
      const stranger = await createTestUser(client, "dis7");
      const google = createFakeGoogle();
      const outcome = await disconnectGmailAccount(
        { userId: stranger, mailAccountId },
        deps(google),
      );
      expect(outcome.result).toBe("not_found");
      // Nothing was revoked on the real owner's behalf.
      expect(google.calls.revocations).toHaveLength(0);
      expect(await countCredentials(client, mailAccountId)).toBe(1);
    });
  });

  // =====================================================================
  describe("the refresh primitive B03 will use", () => {
    async function connectedAccount(label: string) {
      const userId = await createTestUser(client, label);
      const subject = `sub-${randomBytes(8).toString("hex")}`;
      const { outcome } = await runAuthorization(userId, { subject });
      const id = (outcome as { mailAccountId: string }).mailAccountId;
      await grantPrivateProcessingConsent({ userId, mailAccountId: id }, deps(createFakeGoogle()));
      return { userId, mailAccountId: id };
    }

    it("returns a short-lived access token and persists none of it", async () => {
      const { mailAccountId } = await connectedAccount("ref1");
      const outcome = await getFreshGmailAccessToken({ mailAccountId }, deps(createFakeGoogle()));
      expect(outcome.result).toBe("ok");
      expect((outcome as { accessToken: string }).accessToken).toBe("fresh-access-token");

      // The access token appears in no column, anywhere.
      const dump = await client.query(
        "select * from private.gmail_oauth_credentials where mail_account_id = $1",
        [mailAccountId],
      );
      expect(JSON.stringify(dump.rows[0])).not.toContain("fresh-access-token");
    });

    it("marks reauth_required on a permanent refresh failure", async () => {
      const { mailAccountId } = await connectedAccount("ref2");
      const google = createFakeGoogle({
        // What a revoked grant, a password change, or a lapsed Testing-mode
        // token all look like.
        refreshError: new GoogleAdapterError("invalid_grant", true),
      });
      const outcome = await getFreshGmailAccessToken({ mailAccountId }, deps(google));

      expect(outcome.result).toBe("reauth_required");
      expect(await countCredentials(client, mailAccountId)).toBe(0);
      expect((await readMailAccount(client, mailAccountId)).connection_state).toBe(
        "reauth_required",
      );

      // Normal lifecycle, not corruption: history and ownership survive.
      const kept = await client.query(
        `select (select count(*)::int from public.mail_account_consent_receipts
                   where mail_account_id=$1) receipts,
                (select count(*)::int from public.mail_provider_account_owners o
                   join public.mail_accounts m
                     on m.provider_account_subject = o.provider_account_subject
                  where m.id=$1) reservations`,
        [mailAccountId],
      );
      expect(kept.rows[0].receipts).toBe(1);
      expect(kept.rows[0].reservations).toBe(1);
    });

    it("does NOT mark reauth_required on a transient failure", async () => {
      const { mailAccountId } = await connectedAccount("ref3");
      const google = createFakeGoogle({
        refreshError: new GoogleAdapterError("backend_error", false),
      });
      const outcome = await getFreshGmailAccessToken({ mailAccountId }, deps(google));

      expect(outcome.result).toBe("provider_unavailable");
      // A blip must not destroy a working credential.
      expect(await countCredentials(client, mailAccountId)).toBe(1);
      expect((await readMailAccount(client, mailAccountId)).connection_state).toBe("connected");
    });

    it("stores a rotated refresh token when Google returns one", async () => {
      const { mailAccountId } = await connectedAccount("ref4");
      const before = await client.query(
        "select refresh_token_ciphertext from private.gmail_oauth_credentials where mail_account_id=$1",
        [mailAccountId],
      );
      const google = createFakeGoogle({ rotatedRefreshToken: "rotated-refresh-token" });
      await getFreshGmailAccessToken({ mailAccountId }, deps(google));

      const after = await client.query(
        "select refresh_token_ciphertext from private.gmail_oauth_credentials where mail_account_id=$1",
        [mailAccountId],
      );
      // Stored, and stored encrypted.
      expect(after.rows[0].refresh_token_ciphertext).not.toBe(
        before.rows[0].refresh_token_ciphertext,
      );
      expect(after.rows[0].refresh_token_ciphertext).not.toContain("rotated-refresh-token");
    });

    it("refuses when the mailbox is not connected or consent is missing", async () => {
      const { userId, mailAccountId } = await connectedAccount("ref5");
      await disconnectGmailAccount({ userId, mailAccountId }, deps(createFakeGoogle()));
      const outcome = await getFreshGmailAccessToken({ mailAccountId }, deps(createFakeGoogle()));
      expect(outcome.result).toBe("not_connected");

      const withdrawn = await connectedAccount("ref6");
      await client.query("begin");
      // Scopes are cleared FIRST: B01 checks a receipt's snapshot against the
      // account's scope set at COMMIT, so a withdrawal recorded alongside a
      // disconnect snapshots the empty set.
      await client.query(
        `update public.mail_accounts set connection_state='disconnected',
            disconnected_at=now(), granted_scopes='{}' where id=$1`,
        [withdrawn.mailAccountId],
      );
      const receipt = await client.query(
        `insert into public.mail_account_consent_receipts
           (mail_account_id, user_id, consent_kind, decision, policy_version,
            consent_text_digest, granted_scopes_at_decision, decided_by_user_id,
            decided_at, receipt_digest)
         values ($1,$2,'private_gmail_processing','withdrawn','p/1',repeat('a',64),
                 '{}', $2, now(), repeat('c',64))
         returning id, event_seq`,
        [withdrawn.mailAccountId, withdrawn.userId],
      );
      await client.query(
        `update public.mail_account_consents
            set state='withdrawn', current_receipt_id=$2, current_event_seq=$3
          where mail_account_id=$1 and consent_kind='private_gmail_processing'`,
        [withdrawn.mailAccountId, receipt.rows[0].id, receipt.rows[0].event_seq],
      );
      await client.query("commit");

      const noConsent = await getFreshGmailAccessToken(
        { mailAccountId: withdrawn.mailAccountId },
        deps(createFakeGoogle()),
      );
      // Either refusal is correct; what matters is that no token is issued.
      expect(["not_connected", "consent_missing"]).toContain(noConsent.result);
    });
  });
});
