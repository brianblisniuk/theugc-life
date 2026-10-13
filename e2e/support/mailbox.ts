/**
 * Seed a fixture mailbox after signup. No Google HTTP.
 * The caller must not sign that user in again: login sync would try Gmail.
 */
import { randomBytes } from "node:crypto";

import { Client } from "pg";

const READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email", READ_SCOPE];

export const FIXTURE_THREAD_ID = "e2e-fixture-thread";

function digest(): string {
  return randomBytes(32).toString("hex");
}

export async function seedMailbox(input: {
  loginEmail: string;
  mailboxEmail: string;
  state: "connected" | "revoked";
  threadId?: string;
}): Promise<void> {
  const databaseUrl = process.env.E2E_DATABASE_URL;
  if (!databaseUrl) throw new Error("E2E_DATABASE_URL is required");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const user = await client.query<{ id: string }>(
      "select id from auth.users where lower(email) = lower($1)",
      [input.loginEmail],
    );
    const userId = user.rows[0]?.id;
    if (!userId) throw new Error("signup user was not stored");

    const subject = `e2e-${randomBytes(8).toString("hex")}`;
    await client.query("begin");
    const account = await client.query<{ id: string }>(
      `insert into public.mail_accounts
         (user_id, provider, provider_account_subject, email_address, connection_state)
       values ($1, 'gmail', $2, $3, 'pending_authorization')
       returning id`,
      [userId, subject, input.mailboxEmail],
    );
    const mailAccountId = account.rows[0]!.id;
    await client.query(
      `update public.mail_accounts
          set connection_state = 'connected', connected_at = now(), granted_scopes = $2
        where id = $1`,
      [mailAccountId, SCOPES],
    );
    const receipt = await client.query<{ id: string; event_seq: string }>(
      `insert into public.mail_account_consent_receipts
         (mail_account_id, user_id, consent_kind, decision, policy_version, consent_text_digest,
          granted_scopes_at_decision, decided_by_user_id, decided_at, receipt_digest)
       values ($1, $2, 'private_gmail_processing', 'granted', 'p/1', $3, $4, $2, now(), $5)
       returning id, event_seq`,
      [mailAccountId, userId, digest(), SCOPES, digest()],
    );
    await client.query(
      `insert into public.mail_account_consents
         (mail_account_id, user_id, consent_kind, state, current_receipt_id, current_event_seq)
       values ($1, $2, 'private_gmail_processing', 'granted', $3, $4)`,
      [mailAccountId, userId, receipt.rows[0]!.id, receipt.rows[0]!.event_seq],
    );
    await client.query(
      `insert into private.gmail_oauth_credentials
         (mail_account_id, user_id, refresh_token_ciphertext, refresh_token_iv,
          refresh_token_auth_tag, encryption_key_version)
       values ($1, $2, 'ct', 'iv', 'tag', 'v1')`,
      [mailAccountId, userId],
    );
    if (input.threadId) {
      await client.query(
        `insert into private.gmail_normalized_threads (user_id, mail_account_id, provider_thread_id)
         values ($1, $2, $3)`,
        [userId, mailAccountId, input.threadId],
      );
    }
    if (input.state === "revoked") {
      await client.query("delete from private.gmail_oauth_credentials where mail_account_id = $1", [
        mailAccountId,
      ]);
      await client.query(
        "update public.mail_accounts set connection_state = 'reauth_required' where id = $1",
        [mailAccountId],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}
