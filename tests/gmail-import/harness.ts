import { randomBytes } from "node:crypto";

import { Client } from "pg";

import { B02_REQUESTED_SCOPES } from "@/lib/gmail/contract";
import type { ImportDeps } from "@/lib/gmail/import/worker.server";
import { createRpcClient, createTestUser } from "../gmail/rpc-harness";

/**
 * B03 test fixtures against REAL PostgreSQL.
 *
 * Everything B03 guarantees — atomicity, idempotence, the authorization fence,
 * the lease — lives inside 0037's functions and PostgreSQL's own constraints, so
 * a mocked database would test nothing that matters.
 */

export const READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export function rpc(client: Client) {
  return createRpcClient(client) as unknown as ImportDeps["db"];
}

/**
 * A fully connected, consented mailbox — B02's end state, built directly
 * because B03 does not own the OAuth flow and re-driving it here would be
 * testing B02 again.
 */
export async function connectedMailbox(
  client: Client,
  label: string,
  options: { scopes?: string[] } = {},
): Promise<{ userId: string; mailAccountId: string; subject: string }> {
  const userId = await createTestUser(client, label);
  const subject = `sub-${randomBytes(8).toString("hex")}`;
  const scopes = options.scopes ?? [...B02_REQUESTED_SCOPES];

  await client.query("begin").catch(() => undefined);
  const account = await client.query(
    `insert into public.mail_accounts
       (user_id, provider, provider_account_subject, email_address, connection_state)
     values ($1, 'gmail', $2, $3, 'pending_authorization') returning id`,
    [userId, subject, `${label}@example.invalid`],
  );
  const mailAccountId = account.rows[0].id as string;

  await client.query(
    `update public.mail_accounts
        set connection_state = 'connected', connected_at = now(), granted_scopes = $2
      where id = $1`,
    [mailAccountId, scopes],
  );

  const receipt = await client.query(
    `insert into public.mail_account_consent_receipts
       (mail_account_id, user_id, consent_kind, decision, policy_version, consent_text_digest,
        granted_scopes_at_decision, decided_by_user_id, decided_at, receipt_digest)
     values ($1, $2, 'private_gmail_processing', 'granted', 'p/1', $3, $4, $2, now(), $5)
     returning id, event_seq`,
    [mailAccountId, userId, "a".repeat(64), scopes, "b".repeat(64)],
  );

  await client.query(
    `insert into public.mail_account_consents
       (mail_account_id, user_id, consent_kind, state, current_receipt_id, current_event_seq)
     values ($1, $2, 'private_gmail_processing', 'granted', $3, $4)`,
    [mailAccountId, userId, receipt.rows[0].id, receipt.rows[0].event_seq],
  );

  // A credential, so B02's own load path is reachable in tests that use it.
  await client.query(
    `insert into private.gmail_oauth_credentials
       (mail_account_id, user_id, refresh_token_ciphertext, refresh_token_iv,
        refresh_token_auth_tag, encryption_key_version)
     values ($1, $2, 'ct', 'iv', 'tag', 'v1')`,
    [mailAccountId, userId],
  );
  await client.query("commit");

  return { userId, mailAccountId, subject };
}

/** Withdraw private-processing consent the way B01 requires: a new receipt. */
export async function withdrawConsent(client: Client, mailAccountId: string, userId: string) {
  await client.query("begin");
  const receipt = await client.query(
    `insert into public.mail_account_consent_receipts
       (mail_account_id, user_id, consent_kind, decision, policy_version, consent_text_digest,
        granted_scopes_at_decision, decided_by_user_id, decided_at, receipt_digest)
     values ($1, $2, 'private_gmail_processing', 'withdrawn', 'p/1', $3,
             (select granted_scopes from public.mail_accounts where id = $1), $2, now(), $4)
     returning id, event_seq`,
    [mailAccountId, userId, "a".repeat(64), randomBytes(32).toString("hex")],
  );
  await client.query(
    `update public.mail_account_consents
        set state = 'withdrawn', current_receipt_id = $2, current_event_seq = $3
      where mail_account_id = $1 and consent_kind = 'private_gmail_processing'`,
    [mailAccountId, receipt.rows[0].id, receipt.rows[0].event_seq],
  );
  // B01's consent dominance: a `connected` mailbox without a granted consent
  // cannot COMMIT, so withdrawal necessarily moves the state too. The credential
  // stays, which is exactly what `consent_required` means.
  await client.query(
    "update public.mail_accounts set connection_state = 'consent_required' where id = $1",
    [mailAccountId],
  );
  await client.query("commit");
}

/** Move a mailbox to a lifecycle state, keeping B01's shape rules satisfied. */
export async function setConnectionState(
  client: Client,
  mailAccountId: string,
  state: string,
): Promise<void> {
  await client.query("begin");
  if (state !== "connected" && state !== "consent_required") {
    await client.query("delete from private.gmail_oauth_credentials where mail_account_id = $1", [
      mailAccountId,
    ]);
  }
  if (["disconnecting", "disconnected", "deletion_pending", "deleted"].includes(state)) {
    await client.query(
      `update public.mail_accounts
          set connection_state = $2, disconnected_at = now(), granted_scopes = '{}'
        where id = $1`,
      [mailAccountId, state === "disconnecting" ? "disconnecting" : "disconnected"],
    );
  } else {
    await client.query("update public.mail_accounts set connection_state = $2 where id = $1", [
      mailAccountId,
      state,
    ]);
  }
  await client.query("commit");
}

/** An open deletion request, and the mailbox waiting on it. */
export async function startDeletion(
  client: Client,
  mailAccountId: string,
  userId: string,
  scope: "gmail_derived_data" | "account_and_gmail_derived_data" = "account_and_gmail_derived_data",
): Promise<string> {
  await client.query("begin");
  await client.query("delete from private.gmail_oauth_credentials where mail_account_id = $1", [
    mailAccountId,
  ]);
  const request = await client.query(
    `insert into public.mail_account_deletion_requests
       (mail_account_id, user_id, scope, requested_by_user_id, requested_at, status)
     values ($1, $2, $3, $2, now(), 'in_progress') returning id`,
    [mailAccountId, userId, scope],
  );
  await client.query(
    `update public.mail_accounts
        set connection_state = 'deletion_pending',
            current_deletion_request_id = $2,
            disconnected_at = now(),
            granted_scopes = '{}'
      where id = $1`,
    [mailAccountId, request.rows[0].id],
  );
  await client.query("commit");
  return request.rows[0].id as string;
}

export const stateOf = async (client: Client, id: string): Promise<string> => {
  const res = await client.query(
    "select connection_state from public.mail_accounts where id = $1",
    [id],
  );
  return res.rows[0].connection_state as string;
};

export const runRow = async (client: Client, runId: string) => {
  const res = await client.query(
    "select * from private.gmail_historical_import_runs where id = $1",
    [runId],
  );
  return res.rows[0];
};

export const threadRows = async (client: Client, runId: string) => {
  const res = await client.query(
    "select * from private.gmail_historical_import_threads where run_id = $1 order by provider_thread_id",
    [runId],
  );
  return res.rows;
};

export const rawMessages = async (client: Client, mailAccountId: string) => {
  const res = await client.query(
    "select * from private.gmail_raw_messages where mail_account_id = $1 order by provider_message_id",
    [mailAccountId],
  );
  return res.rows;
};

/** Import deps that never wait and never call Google unless a fake says so. */
export function importDeps(client: Client, overrides: Partial<ImportDeps> = {}): ImportDeps {
  return {
    db: rpc(client),
    gmail: overrides.gmail ?? ({} as ImportDeps["gmail"]),
    sleep: overrides.sleep ?? (async () => undefined),
    now: overrides.now ?? (() => Date.now()),
    random: overrides.random ?? (() => 0.5),
    accessToken: overrides.accessToken ?? (async () => ({ result: "ok", accessToken: "fake" })),
    ...overrides,
  };
}

/**
 * One header occurrence, by name, from the lossless list B03 now stores.
 *
 * `headerValues` returns EVERY occurrence, because that is the property the
 * storage shape exists to preserve — a test that only ever asked for the first
 * could not tell a list from the map it replaced.
 */
export const headerValues = (
  headers: { name: string; value: string }[] | undefined,
  name: string,
): string[] => (headers ?? []).filter((h) => h.name === name).map((h) => h.value);

export const headerValue = (
  headers: { name: string; value: string }[] | undefined,
  name: string,
): string | undefined => headerValues(headers, name)[0];
