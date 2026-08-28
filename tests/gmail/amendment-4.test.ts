import { randomBytes } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  completeGmailAuthorization,
  disconnectGmailAccount,
  grantPrivateProcessingConsent,
  listGmailAccounts,
  startGmailAuthorization,
  type GmailDeps,
} from "@/lib/gmail/connection.server";
import { B02_REQUESTED_SCOPES, GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE } from "@/lib/gmail/contract";
import { resetGmailOAuthConfigCache } from "@/lib/gmail/env.server";
import {
  canConnectAnother,
  canDisconnect,
  canReconnect,
  needsPrivateProcessingConsent,
} from "@/lib/gmail/panel-actions";

import {
  createFakeGoogle,
  createFakeGoogleProject,
  type FakeGoogleOptions,
  type FakeGoogleProject,
} from "./fake-google";
import { countCredentials, createRpcClient, createTestUser, readMailAccount } from "./rpc-harness";

/**
 * B02 EXTERNAL AUDIT AMENDMENT #4.
 *
 * Amendment #3 gave OAuth a lifecycle revision. This is about the two ways that
 * was still only nearly true, plus the two places the product could not be used
 * or read honestly.
 *
 *   A  the revision was CHECKED but not RESERVED. A plpgsql function is
 *      VOLATILE, so each statement takes a fresh snapshot: the callback could
 *      read revision N, a Disconnect could commit N+1, and the callback's later
 *      writes would still land. Evidence about a row is not a hold on it.
 *
 *   B  a successful reconnect did not CONSUME its revision. Two flows begun
 *      against the same version could both land, the second replacing the
 *      first's credential — each "current" by every check available to it.
 *
 *   C  `consent_required` with an older `granted` consent for a NARROWER scope
 *      set left the UI showing "Awaiting your permission" with no way to give
 *      it. The database had decided correctly; the panel asked the wrong
 *      question.
 *
 *   D  the contract still told a future maintainer that a failed health check
 *      and an account mismatch revoke the grant — the exact project-wide
 *      revocation defect amendment #2 removed from the code.
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

async function revisionOf(mailAccountId: string): Promise<number> {
  const res = await client.query(
    "select authorization_revision from public.mail_accounts where id = $1",
    [mailAccountId],
  );
  return Number(res.rows[0].authorization_revision);
}

async function ciphertextOf(mailAccountId: string): Promise<string | null> {
  const res = await client.query(
    "select refresh_token_ciphertext from private.gmail_oauth_credentials where mail_account_id=$1",
    [mailAccountId],
  );
  return res.rows[0]?.refresh_token_ciphertext ?? null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The scope set B02 asks for, as the persist RPC wants it. */
const SCOPES = [...B02_REQUESTED_SCOPES];

d("amendment #4 — the revision is reserved, not merely inspected", () => {
  /**
   * A REAL two-session race against the REAL production function.
   *
   * No barrier trigger and no sleep inside the function: the callback blocks
   * naturally on the lifecycle session's uncommitted row lock, which is exactly
   * the window an unlocked revision read leaves open. The only thing the test
   * controls is which session gets there first.
   */
  async function raceSetup(label: string) {
    const userId = await createTestUser(client, label);
    const mailAccountId = randomBytes(16)
      .toString("hex")
      .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
    const subject = `race-${randomBytes(6).toString("hex")}`;
    await client.query("begin");
    await client.query(
      `insert into public.mail_accounts (id,user_id,provider,provider_account_subject,email_address,connection_state)
       values ($1,$2,'gmail',$3,'race@example.invalid','pending_authorization')`,
      [mailAccountId, userId, subject],
    );
    await client.query(
      `update public.mail_accounts set connection_state='reauth_required',
          granted_scopes=$2::text[] where id=$1`,
      [mailAccountId, SCOPES],
    );
    await client.query("commit");
    return { userId, mailAccountId, subject, pinned: await revisionOf(mailAccountId) };
  }

  it("ORDER 2 — the lifecycle change commits first, so the callback is refused", async () => {
    const { userId, mailAccountId, subject, pinned } = await raceSetup("race-order2");

    const lifecycle = new Client({ connectionString: TEST_DB });
    const callback = new Client({ connectionString: TEST_DB });
    await lifecycle.connect();
    await callback.connect();
    try {
      // The human's Disconnect takes the row lock and does NOT commit yet.
      await lifecycle.query("begin");
      await lifecycle.query(
        `update public.mail_accounts set connection_state='disconnected',
            disconnected_at=now(), granted_scopes='{}' where id=$1`,
        [mailAccountId],
      );

      // The stale callback enters the REAL persist function, pinned at N.
      const pending = callback.query(
        `select public.gmail_connection_persist(
           $1::uuid, $2, 'race@example.invalid', $3::text[],
           'CALLBACK-CT','iv','tag','v1', null, $4::uuid, $5::bigint, 'p/1') as r`,
        [userId, subject, SCOPES, mailAccountId, pinned],
      );

      // It is now blocked on the lock — before, it would have read the OLD
      // revision here and passed its comparison.
      await sleep(400);
      await lifecycle.query("commit");

      const result = (await pending).rows[0].r as { result: string };
      expect(result.result).toBe("state_changed");
    } finally {
      await lifecycle.end();
      await callback.end();
    }

    // The human's decision stands, and nothing of the callback survived.
    const row = await readMailAccount(client, mailAccountId);
    expect(row.connection_state).toBe("disconnected");
    expect(row.granted_scopes).toEqual([]);
    expect(await countCredentials(client, mailAccountId)).toBe(0);
    expect(await revisionOf(mailAccountId)).toBeGreaterThan(pinned);
  });

  it("ORDER 1 — the callback gets the lock first, and the Disconnect still wins overall", async () => {
    const { userId, mailAccountId, subject, pinned } = await raceSetup("race-order1");

    const lifecycle = new Client({ connectionString: TEST_DB });
    const callback = new Client({ connectionString: TEST_DB });
    await lifecycle.connect();
    await callback.connect();
    try {
      // The callback goes first and holds the target row for its whole
      // transaction.
      await callback.query("begin");
      const persisted = await callback.query(
        `select public.gmail_connection_persist(
           $1::uuid, $2, 'race@example.invalid', $3::text[],
           'CALLBACK-CT','iv','tag','v1', null, $4::uuid, $5::bigint, 'p/1') as r`,
        [userId, subject, SCOPES, mailAccountId, pinned],
      );
      expect((persisted.rows[0].r as { result: string }).result).toBe("consent_required");

      // The human's Disconnect arrives while that transaction is open, through
      // the REAL finalize RPC, and WAITS on the same row lock.
      const waiting = lifecycle.query(
        "select public.gmail_disconnect_finalize($1::uuid, $2::uuid) as r",
        [userId, mailAccountId],
      );
      await sleep(400);

      await callback.query("commit");
      const finalized = await waiting;
      // It picks up the credential the callback just stored and removes it with
      // the state, in one transaction — which is why the deferred
      // state↔credential invariant is satisfied at COMMIT.
      expect((finalized.rows[0].r as { result: string }).result).toBe("ok");
    } finally {
      await lifecycle.end();
      await callback.end();
    }

    // NEITHER ORDER lets an older callback outlive a newer decision.
    const row = await readMailAccount(client, mailAccountId);
    expect(row.connection_state).toBe("disconnected");
    expect(row.granted_scopes).toEqual([]);
    expect(await countCredentials(client, mailAccountId)).toBe(0);

    // HONESTLY, ABOUT THE PROVIDER SIDE OF THIS ORDER: the disconnect
    // orchestration loads the credential BEFORE finalizing, so in this
    // interleaving it found none and called no revoke — the callback's
    // credential did not exist yet. The local state is correct and no usable
    // token is stored, but the Google grant the callback obtained may still be
    // visible in the person's account. That is the refused-callback limitation
    // already documented in §10 of the contract, not a revocation we can claim
    // happened.
  });
});

d("amendment #4 — a successful reconnect consumes the revision it used", () => {
  it("two reconnects pinned to the same revision: the second is refused", async () => {
    const project = createFakeGoogleProject();
    const userId = await createTestUser(client, "twice");
    const subject = `sub-${randomBytes(8).toString("hex")}`;

    // A `consent_required` mailbox: credential present, scopes S, revision N.
    const first = await authorize(userId, { project, subject });
    const mailAccountId = (first.outcome as { mailAccountId: string }).mailAccountId;
    expect((await readMailAccount(client, mailAccountId)).connection_state).toBe(
      "consent_required",
    );
    const pinned = await revisionOf(mailAccountId);

    // TWO flows begin, both pinning N.
    const a = await beginAuthorization(
      userId,
      { project, subject },
      { purpose: "reconnect", targetMailAccountId: mailAccountId },
    );
    const b = await beginAuthorization(
      userId,
      { project, subject },
      { purpose: "reconnect", targetMailAccountId: mailAccountId },
    );
    expect(a.started.result).toBe("ok");
    expect(b.started.result).toBe("ok");

    // A lands: same subject, same scope set, same state — and still consumes N.
    const outcomeA = await finish(userId, a.google, a.state!);
    expect(outcomeA.result).toBe("consent_required");
    const afterA = await revisionOf(mailAccountId);
    expect(afterA).toBeGreaterThan(pinned);
    const credentialA = await ciphertextOf(mailAccountId);

    // B is now stale even though nothing "changed" in the old sense.
    const outcomeB = await finish(userId, b.google, b.state!);
    expect(outcomeB.result).toBe("state_changed");
    expect(await revisionOf(mailAccountId)).toBe(afterA);
    expect(await ciphertextOf(mailAccountId)).toBe(credentialA);
  });

  it("a scope-changing reconnect advances the revision", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "rev-scope");
    await expireCredential(mailAccountId);
    const pinned = await revisionOf(mailAccountId);

    const outcome = await authorize(
      userId,
      { project, subject, grantedScopes: [...SCOPES, GMAIL_SEND_SCOPE] },
      { purpose: "reconnect", targetMailAccountId: mailAccountId },
    );
    expect(outcome.outcome!.result).toBe("consent_required");
    expect(await revisionOf(mailAccountId)).toBeGreaterThan(pinned);
  });

  it("a state-changing reconnect advances the revision", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "rev-state");
    await expireCredential(mailAccountId);
    const pinned = await revisionOf(mailAccountId);

    // reauth_required -> connected, because the consent still covers the scopes.
    const outcome = await authorize(
      userId,
      { project, subject },
      { purpose: "reconnect", targetMailAccountId: mailAccountId },
    );
    expect(outcome.outcome!.result).toBe("connected");
    expect(await revisionOf(mailAccountId)).toBeGreaterThan(pinned);
  });

  it("a background refresh rotation does NOT advance the authorization revision", async () => {
    const project = createFakeGoogleProject();
    const { mailAccountId } = await connectedIn(project, "rev-rotation4");
    const pinned = await revisionOf(mailAccountId);

    await client.query(
      `select public.gmail_credential_replace($1, (select credential_generation
         from private.gmail_oauth_credentials where mail_account_id=$1),
         'ROTATED','iv','tag','v1', null)`,
      [mailAccountId],
    );

    // A rotation is not a human authorization event. Bumping here would cancel
    // unrelated in-flight OAuth flows for no reason — `credential_generation`
    // is the clock for rotation, this one is the clock for the lifecycle.
    expect(await revisionOf(mailAccountId)).toBe(pinned);
    expect(await ciphertextOf(mailAccountId)).toBe("ROTATED");
  });

  it("an unrelated metadata update does NOT advance it; a lifecycle SQL update DOES", async () => {
    const project = createFakeGoogleProject();
    const { mailAccountId } = await connectedIn(project, "rev-meta4");
    const pinned = await revisionOf(mailAccountId);

    await client.query("update public.mail_accounts set email_address=$2 where id=$1", [
      mailAccountId,
      "renamed@example.invalid",
    ]);
    expect(await revisionOf(mailAccountId)).toBe(pinned);

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
    expect(await revisionOf(mailAccountId)).toBeGreaterThan(pinned);
  });

  it("the revision is database-owned on INSERT and on UPDATE", async () => {
    const userId = await createTestUser(client, "rev-owned");

    // A writer supplying their own value on INSERT does not get it.
    const inserted = await client.query(
      `insert into public.mail_accounts
         (user_id, provider, provider_account_subject, email_address, connection_state,
          authorization_revision)
       values ($1,'gmail',$2,'owned@example.invalid','pending_authorization', 1)
       returning id, authorization_revision`,
      [userId, `sub-${randomBytes(8).toString("hex")}`],
    );
    const id = inserted.rows[0].id as string;
    expect(Number(inserted.rows[0].authorization_revision)).not.toBe(1);
    const assigned = Number(inserted.rows[0].authorization_revision);

    // Nor on UPDATE: a metadata write with a chosen revision keeps the old one.
    await client.query(
      "update public.mail_accounts set email_address=$2, authorization_revision=1 where id=$1",
      [id, "again@example.invalid"],
    );
    expect(await revisionOf(id)).toBe(assigned);

    // ...and a lifecycle write with a chosen revision gets the sequence's next
    // value, not the caller's.
    await client.query(
      "update public.mail_accounts set connection_state='reauth_required', authorization_revision=1 where id=$1",
      [id],
    );
    const after = await revisionOf(id);
    expect(after).not.toBe(1);
    expect(after).toBeGreaterThan(assigned);
  });
});

d("amendment #4 — exact-scope reconsent is reachable", () => {
  it("a widened reconnect leaves a granted consent that does NOT cover the new scopes", async () => {
    const project = createFakeGoogleProject();
    const { userId, mailAccountId, subject } = await connectedIn(project, "reconsent");

    // Consent was given about S1.
    const consentedScopes = (
      await client.query(
        `select r.granted_scopes_at_decision s
           from public.mail_account_consents c
           join public.mail_account_consent_receipts r on r.id = c.current_receipt_id
          where c.mail_account_id=$1 and c.consent_kind='private_gmail_processing'`,
        [mailAccountId],
      )
    ).rows[0].s as string[];
    expect(consentedScopes).toContain(GMAIL_READONLY_SCOPE);
    expect(consentedScopes).not.toContain(GMAIL_SEND_SCOPE);

    // Google later approves S2 ⊃ S1 on an explicit reconnect.
    await expireCredential(mailAccountId);
    const widened = await authorize(
      userId,
      { project, subject, grantedScopes: [...SCOPES, GMAIL_SEND_SCOPE] },
      { purpose: "reconnect", targetMailAccountId: mailAccountId },
    );
    expect(widened.outcome!.result).toBe("consent_required");

    // THE SHAPE THAT USED TO BE A DEAD END: the state says a decision is needed,
    // and the consent projection still says `granted` — about a narrower mailbox.
    const [status] = await listGmailAccounts(userId, deps(createFakeGoogle()));
    expect(status!.connectionState).toBe("consent_required");
    expect(status!.hasCredential).toBe(true);
    expect(status!.privateProcessingConsent).toBe(true);

    // The old rule hid the prompt exactly here.
    const oldRule =
      status!.hasCredential &&
      !status!.privateProcessingConsent &&
      status!.connectionState !== "connected";
    expect(oldRule).toBe(false);

    // The state-driven rule shows it.
    expect(needsPrivateProcessingConsent(status!)).toBe(true);

    // And granting again completes the loop: a NEW receipt snapshotting S2, the
    // projection advanced onto it, and the mailbox connected.
    const granted = await grantPrivateProcessingConsent(
      { userId, mailAccountId },
      deps(createFakeGoogle()),
    );
    expect(granted.result).toBe("connected");

    const receipts = await client.query(
      `select r.granted_scopes_at_decision s, r.decision
         from public.mail_account_consent_receipts r
        where r.mail_account_id=$1 and r.consent_kind='private_gmail_processing'
        order by r.event_seq`,
      [mailAccountId],
    );
    expect(receipts.rows).toHaveLength(2);
    expect(receipts.rows[1].s).toContain(GMAIL_SEND_SCOPE);

    const current = await client.query(
      `select r.granted_scopes_at_decision s
         from public.mail_account_consents c
         join public.mail_account_consent_receipts r on r.id = c.current_receipt_id
        where c.mail_account_id=$1 and c.consent_kind='private_gmail_processing'`,
      [mailAccountId],
    );
    expect(current.rows[0].s).toContain(GMAIL_SEND_SCOPE);
    expect((await readMailAccount(client, mailAccountId)).connection_state).toBe("connected");

    // Network contribution never moved.
    const [after] = await listGmailAccounts(userId, deps(createFakeGoogle()));
    expect(after!.networkContributionConsent).toBe(false);
  });
});

describe("amendment #4 — the panel offers what the database will accept", () => {
  const account = (
    connectionState: string,
    hasCredential = true,
  ): Parameters<typeof canReconnect>[0] & { hasCredential: boolean } =>
    ({ connectionState, hasCredential }) as never;

  it("Reconnect is offered only for the reconnectable states", () => {
    for (const state of [
      "pending_authorization",
      "consent_required",
      "reauth_required",
      "disconnected",
    ]) {
      expect(canReconnect(account(state))).toBe(true);
    }
    // Offering it here would offer something `gmail_oauth_begin` refuses.
    for (const state of ["connected", "deletion_pending", "deleted"]) {
      expect(canReconnect(account(state))).toBe(false);
    }
  });

  it("the consent prompt follows the state, not the consent projection", () => {
    expect(needsPrivateProcessingConsent(account("consent_required", true))).toBe(true);
    // No credential: nothing to process with, so nothing to consent to yet.
    expect(needsPrivateProcessingConsent(account("consent_required", false))).toBe(false);
    expect(needsPrivateProcessingConsent(account("connected", true))).toBe(false);
    expect(needsPrivateProcessingConsent(account("reauth_required", true))).toBe(false);
  });

  it("Disconnect disappears once access has already stopped", () => {
    expect(canDisconnect(account("connected"))).toBe(true);
    expect(canDisconnect(account("consent_required"))).toBe(true);
    expect(canDisconnect(account("disconnected"))).toBe(false);
  });

  it("Connect another Gmail is available once at least one mailbox exists", () => {
    // Zero accounts: the panel renders the primary Connect instead.
    expect(canConnectAnother(true, 0)).toBe(false);
    // One, and more than one: a creator may legitimately have a personal and a
    // business Gmail, and B01 has always allowed it.
    expect(canConnectAnother(true, 1)).toBe(true);
    expect(canConnectAnother(true, 3)).toBe(true);
    // Not offered when the deployment has no Gmail configuration at all.
    expect(canConnectAnother(false, 2)).toBe(false);
  });
});
