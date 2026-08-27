/**
 * B01 — MAIL ACCOUNT, CONSENT AND THE PRIVATE COMMUNICATION BOUNDARY (0035).
 *
 * Phase A's tables are editorial internals: admin/editor read provider evidence
 * because reviewing hotel data is their job. This plane is different in kind. A
 * creator's mailbox is private correspondence, most of it about people who never
 * agreed to anything with us, and under Google's restricted-scope rules the
 * obligations follow the data — including everything derived from it.
 *
 * So the suite is organised around the ways a private-communication boundary
 * fails:
 *
 *   1. SOMEONE ELSE READING IT. Another creator, an admin through a client
 *      session, or anon. Holding an internal role is not a reason to read a
 *      stranger's mail.
 *   2. CONSENT THAT WAS NEVER GIVEN. The absence of a receipt read as
 *      agreement, or a blanket "connect Gmail" silently authorizing shared
 *      intelligence.
 *   3. HISTORY REWRITTEN. A withdrawal that edits what a human is recorded as
 *      having agreed to, rather than adding a new fact.
 *   4. A PROJECTION THAT LIES. Current state disagreeing with the receipt it
 *      claims to represent, or naming another mailbox's decision.
 *   5. DISCONNECT SOLD AS DELETE. A state label standing in for evidence that
 *      data was actually removed.
 *   6. A CREDENTIAL IN A QUERYABLE TABLE.
 *
 * No Gmail account is connected here, no OAuth token exists, and no message,
 * thread or attachment table is created. Every fixture is synthetic.
 */
import { createHash } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "./harness";
import { seed, USERS } from "../rls/seed";

const d = describe.skipIf(!hasTestDb);

const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
const POLICY_VERSION = "gmail-consent/1";

let counter = 0;
const uniq = () => `b${Date.now().toString(36)}${(counter += 1)}`;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

interface Account {
  id: string;
  userId: string;
  subject: string;
}

/**
 * A mailbox in `pending_authorization` — the state a connection starts in,
 * before Google's consent screen has been completed.
 */
async function pendingAccount(userId: string = USERS.pro): Promise<Account> {
  const subject = `google-sub-${uniq()}`;
  const [row] = await adminQuery<{ id: string }>(
    `insert into public.mail_accounts
       (user_id, provider, provider_account_subject, email_address)
     values ($1, 'gmail', $2, $3) returning id`,
    [userId, subject, `${subject}@example.invalid`],
  );
  return { id: row!.id, userId, subject };
}

const RECEIPT_INSERT = `insert into public.mail_account_consent_receipts
   (mail_account_id, user_id, consent_kind, decision, policy_version,
    consent_text_digest, granted_scopes_at_decision, decided_by_user_id,
    decided_at, receipt_digest)
 values ($1,$2,$3,$4,$5,$6,$7,$2, now(), $8) returning id, event_seq`;

const PROJECTION_UPSERT = `insert into public.mail_account_consents
   (mail_account_id, user_id, consent_kind, state, current_receipt_id, current_event_seq)
 values ($1,$2,$3,$4,$5,$6)
 on conflict (mail_account_id, consent_kind)
   do update set state = excluded.state,
                 current_receipt_id = excluded.current_receipt_id,
                 current_event_seq = excluded.current_event_seq`;

function receiptParams(
  account: Account,
  kind: string,
  decision: string,
  scopes: string[],
): unknown[] {
  return [
    account.id,
    account.userId,
    kind,
    decision,
    POLICY_VERSION,
    digest(`${kind}|${decision}|${POLICY_VERSION}`),
    scopes,
    digest(`${account.id}|${kind}|${decision}|${uniq()}`),
  ];
}

/**
 * Record one consent decision and advance the current projection onto it — in
 * ONE transaction, because after the amendment the two halves are a single act:
 * a receipt the projection never reaches is a decision that never takes effect.
 */
async function decideConsent(
  account: Account,
  kind: "private_gmail_processing" | "network_intelligence_contribution",
  decision: "granted" | "withdrawn",
  opts: { scopes?: string[] } = {},
): Promise<string> {
  let receiptId = "";
  await txOk(async (q) => {
    const inserted = await q(
      RECEIPT_INSERT,
      receiptParams(account, kind, decision, opts.scopes ?? [GMAIL_READONLY]),
    );
    const row = inserted.rows[0] as { id: string; event_seq: string };
    receiptId = row.id;
    await q(PROJECTION_UPSERT, [account.id, account.userId, kind, decision, row.id, row.event_seq]);
  });
  return receiptId;
}

/**
 * A fully connected mailbox: scopes, private-processing consent and the
 * `connected` state established together. They have to be one transaction now:
 * the receipt's scope snapshot is checked against the account's ACTUAL scopes at
 * COMMIT, so a fixture that granted consent first and widened access afterwards
 * would be recording a consent about a mailbox that did not yet exist.
 */
async function connectedAccount(
  userId: string = USERS.pro,
  scopes: string[] = [GMAIL_READONLY],
): Promise<Account> {
  const account = await pendingAccount(userId);
  await txOk(async (q) => {
    await q(
      `update public.mail_accounts
          set connection_state = 'connected', connected_at = now(),
              granted_scopes = $2::text[], last_state_change_at = now()
        where id = $1`,
      [account.id, scopes],
    );
    const inserted = await q(
      RECEIPT_INSERT,
      receiptParams(account, "private_gmail_processing", "granted", scopes),
    );
    const row = inserted.rows[0] as { id: string; event_seq: string };
    await q(PROJECTION_UPSERT, [
      account.id,
      account.userId,
      "private_gmail_processing",
      "granted",
      row.id,
      row.event_seq,
    ]);
  });
  return account;
}

/** Stop provider access. Stored data is untouched — that is the whole point. */
async function disconnectAccount(account: Account): Promise<void> {
  await adminQuery(
    `update public.mail_accounts
        set connection_state = 'disconnected', disconnected_at = now(),
            granted_scopes = '{}', last_state_change_at = now()
      where id = $1`,
    [account.id],
  );
}

async function openDeletionRequest(
  account: Account,
  scope: "gmail_derived_data" | "account_and_gmail_derived_data",
): Promise<string> {
  const [row] = await adminQuery<{ id: string }>(
    `insert into public.mail_account_deletion_requests
       (mail_account_id, user_id, scope, requested_by_user_id, requested_at)
     values ($1,$2,$3,$2, now()) returning id`,
    [account.id, account.userId, scope],
  );
  return row!.id;
}

/**
 * The whole legitimate retirement, as a writer would perform it: the account
 * waits on the request it will later be retired by, and only then is it
 * `deleted`.
 */
async function retireAccount(account: Account): Promise<string> {
  let requestId = "";
  await txOk(async (q) => {
    const opened = await q(
      `insert into public.mail_account_deletion_requests
         (mail_account_id, user_id, scope, requested_by_user_id, requested_at)
       values ($1,$2,'account_and_gmail_derived_data',$2, now()) returning id`,
      [account.id, account.userId],
    );
    requestId = (opened.rows[0] as { id: string }).id;
    await q(
      `update public.mail_accounts
          set connection_state = 'deletion_pending', current_deletion_request_id = $2
        where id = $1`,
      [account.id, requestId],
    );
    await q(
      "update public.mail_account_deletion_requests set status='completed', completed_at=now() where id=$1",
      [requestId],
    );
    await q("update public.mail_accounts set connection_state = 'deleted' where id = $1", [
      account.id,
    ]);
  });
  return requestId;
}

async function accountRow(id: string) {
  const [row] = await adminQuery<{
    connection_state: string;
    granted_scopes: string[];
    connected_at: string | null;
    disconnected_at: string | null;
  }>(
    `select connection_state, granted_scopes, connected_at, disconnected_at
       from public.mail_accounts where id = $1`,
    [id],
  );
  return row!;
}

/** The one definition of "may we?", asked exactly as a future caller would. */
async function hasConsent(account: Account, kind: string): Promise<boolean> {
  const [row] = await adminQuery<{ granted: boolean }>(
    "select public.mail_account_has_consent($1,$2) granted",
    [account.id, kind],
  );
  return row!.granted;
}

async function currentReceipt(account: Account, kind: string) {
  const [row] = await adminQuery<{
    id: string;
    event_seq: string;
    granted_scopes_at_decision: string[];
  }>(
    `select r.id, r.event_seq, r.granted_scopes_at_decision
       from public.mail_account_consents c
       join public.mail_account_consent_receipts r on r.id = c.current_receipt_id
      where c.mail_account_id = $1 and c.consent_kind = $2`,
    [account.id, kind],
  );
  return row!;
}

/** Run several statements in ONE transaction and report what COMMIT decided. */
async function inTransaction(work: (q: Client["query"]) => Promise<void>): Promise<string | null> {
  const c = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    await c.query("begin");
    await work(c.query.bind(c) as Client["query"]);
    await c.query("commit");
    return null;
  } catch (error) {
    await c.query("rollback").catch(() => undefined);
    return (error as Error).message;
  } finally {
    await c.end();
  }
}

/** The same, for setup that is expected to succeed: a refusal fails the test loudly. */
async function txOk(work: (q: Client["query"]) => Promise<void>): Promise<void> {
  const message = await inTransaction(work);
  if (message !== null) throw new Error(`fixture transaction was refused: ${message}`);
}

d("B01 mail account, consent and the private communication boundary (0035)", () => {
  beforeAll(async () => {
    await setupDatabase();
    await seed();
  });
  afterAll(teardownDatabase);

  // =====================================================================
  describe("ownership", () => {
    it("1/2. the server creates a mailbox and its owner can read it", async () => {
      const account = await connectedAccount();
      const owner = await queryAs(
        { role: "authenticated", sub: USERS.pro },
        "select id, provider, connection_state from public.mail_accounts where id = $1",
        [account.id],
      );
      expect(owner.error).toBeNull();
      expect(owner.rows).toHaveLength(1);
    });

    it("3. a second creator sees zero", async () => {
      const account = await connectedAccount(USERS.pro);
      const other = await queryAs(
        { role: "authenticated", sub: USERS.free },
        "select id from public.mail_accounts where id = $1",
        [account.id],
      );
      expect(other.error).toBeNull();
      expect(other.rows).toHaveLength(0);
    });

    it("4. anon holds no privilege at all — not merely no rows", async () => {
      await connectedAccount();
      for (const table of [
        "mail_accounts",
        "mail_account_consent_receipts",
        "mail_account_consents",
        "mail_account_deletion_requests",
      ]) {
        const anon = await queryAs(
          { role: "anon", sub: null },
          `select * from public.${table} limit 1`,
        );
        expect(anon.error, table).not.toBeNull();
      }
    });

    it("5. an admin/editor client session gets NO blanket private access", async () => {
      // The whole point of this plane. Every table in 0027-0034 answers
      // `is_admin_or_editor()`; none of these does, because reviewing hotel data
      // is a job and reading a stranger's mail is not.
      const account = await connectedAccount(USERS.pro);
      await decideConsent(account, "network_intelligence_contribution", "granted");
      await adminQuery(
        `insert into public.mail_account_deletion_requests
           (mail_account_id, user_id, scope, requested_by_user_id, requested_at)
         values ($1,$2,'gmail_derived_data',$2, now())`,
        [account.id, account.userId],
      );

      for (const role of [USERS.admin, USERS.editor]) {
        for (const table of [
          "mail_accounts",
          "mail_account_consent_receipts",
          "mail_account_consents",
          "mail_account_deletion_requests",
        ]) {
          const staff = await queryAs(
            { role: "authenticated", sub: role },
            `select * from public.${table}`,
          );
          expect(staff.error, `${role} ${table}`).toBeNull();
          expect(staff.rows, `${role} ${table}`).toHaveLength(0);
        }
      }

      // ...and the policies genuinely do not mention the staff helper.
      const policies = await adminQuery<{ qual: string | null }>(
        `select qual from pg_policies
          where schemaname = 'public' and tablename like 'mail_account%'`,
      );
      expect(policies.length).toBeGreaterThan(0);
      for (const p of policies) expect(p.qual ?? "").not.toMatch(/is_admin_or_editor/);
    });

    it("6. one user may own multiple mailboxes", async () => {
      const first = await connectedAccount(USERS.free);
      const second = await pendingAccount(USERS.free);
      expect(second.id).not.toBe(first.id);
      const owned = await queryAs(
        { role: "authenticated", sub: USERS.free },
        "select id from public.mail_accounts where user_id = $1",
        [USERS.free],
      );
      expect(owned.rows.length).toBeGreaterThanOrEqual(2);
    });

    it("7. the same provider account cannot silently belong to two app users", async () => {
      const account = await pendingAccount(USERS.pro);
      await expect(
        adminQuery(
          `insert into public.mail_accounts (user_id, provider, provider_account_subject)
           values ($1, 'gmail', $2)`,
          [USERS.free, account.subject],
        ),
      ).rejects.toThrow(/provider_account_uidx|duplicate key/i);
    });

    it("14. the trusted server path remains possible", async () => {
      // Service-role capability is not a user-facing permission, and it must
      // still exist or B02 could not write anything after an OAuth callback.
      const grants = await adminQuery<{ privilege_type: string }>(
        `select privilege_type from information_schema.role_table_grants
          where table_schema = 'public' and table_name = 'mail_accounts'
            and grantee = 'service_role' order by privilege_type`,
      );
      expect(grants.map((g) => g.privilege_type).sort()).toEqual([
        "DELETE",
        "INSERT",
        "SELECT",
        "UPDATE",
      ]);
    });
  });

  // =====================================================================
  describe("consent", () => {
    it("8. private-processing consent grants and is readable by its owner", async () => {
      const account = await connectedAccount();
      const [row] = await adminQuery<{ state: string }>(
        `select state from public.mail_account_consents
          where mail_account_id = $1 and consent_kind = 'private_gmail_processing'`,
        [account.id],
      );
      expect(row!.state).toBe("granted");
      const owner = await queryAs(
        { role: "authenticated", sub: USERS.pro },
        "select state from public.mail_account_consents where mail_account_id = $1",
        [account.id],
      );
      expect(owner.rows).toHaveLength(1);
    });

    it("9/10. network contribution is SEPARATE, and absent means NOT granted", async () => {
      const account = await connectedAccount();

      // Connecting a mailbox grants private processing and NOTHING else. A
      // blanket "connect Gmail" must never authorize cross-creator learning.
      const [before] = await adminQuery<{ granted: boolean }>(
        "select public.mail_account_has_consent($1, 'network_intelligence_contribution') granted",
        [account.id],
      );
      expect(before!.granted).toBe(false);
      const rows = await adminQuery(
        `select id from public.mail_account_consents
          where mail_account_id = $1 and consent_kind = 'network_intelligence_contribution'`,
        [account.id],
      );
      expect(rows).toHaveLength(0);

      // ...and it is separately grantable, without touching the first one.
      await decideConsent(account, "network_intelligence_contribution", "granted");
      const [after] = await adminQuery<{ granted: boolean }>(
        "select public.mail_account_has_consent($1, 'network_intelligence_contribution') granted",
        [account.id],
      );
      expect(after!.granted).toBe(true);
      const [priv] = await adminQuery<{ granted: boolean }>(
        "select public.mail_account_has_consent($1, 'private_gmail_processing') granted",
        [account.id],
      );
      expect(priv!.granted).toBe(true);
    });

    it("connecting a mailbox is meaningful with network contribution false", async () => {
      // The product must work privately for a creator who never opts in, or the
      // second consent is a dark pattern wearing a checkbox.
      const account = await connectedAccount();
      expect((await accountRow(account.id)).connection_state).toBe("connected");
      const [n] = await adminQuery<{ granted: boolean }>(
        "select public.mail_account_has_consent($1, 'network_intelligence_contribution') granted",
        [account.id],
      );
      expect(n!.granted).toBe(false);
    });

    it("11/12/13. withdrawal is a NEW immutable receipt and the projection advances", async () => {
      const account = await connectedAccount();
      const grantId = await decideConsent(account, "network_intelligence_contribution", "granted");
      const withdrawId = await decideConsent(
        account,
        "network_intelligence_contribution",
        "withdrawn",
      );
      expect(withdrawId).not.toBe(grantId);

      const history = await adminQuery<{ id: string; decision: string }>(
        `select id, decision from public.mail_account_consent_receipts
          where mail_account_id = $1 and consent_kind = 'network_intelligence_contribution'
          order by decided_at`,
        [account.id],
      );
      expect(history.map((h) => h.decision)).toEqual(["granted", "withdrawn"]);

      const [projection] = await adminQuery<{ state: string; current_receipt_id: string }>(
        `select state, current_receipt_id from public.mail_account_consents
          where mail_account_id = $1 and consent_kind = 'network_intelligence_contribution'`,
        [account.id],
      );
      expect(projection!.state).toBe("withdrawn");
      expect(projection!.current_receipt_id).toBe(withdrawId);

      const [now] = await adminQuery<{ granted: boolean }>(
        "select public.mail_account_has_consent($1, 'network_intelligence_contribution') granted",
        [account.id],
      );
      expect(now!.granted).toBe(false);

      // The earlier GRANT is still there, byte-unchanged. What a human agreed to
      // at a moment that has passed is not edited by later disagreement.
      await expect(
        adminQuery(
          "update public.mail_account_consent_receipts set decision = 'withdrawn' where id = $1",
          [grantId],
        ),
      ).rejects.toThrow(/APPEND-ONLY/);
      await expect(
        adminQuery("delete from public.mail_account_consent_receipts where id = $1", [grantId]),
      ).rejects.toThrow(/removed only by deleting the mailbox/);

      const [still] = await adminQuery<{ decision: string }>(
        "select decision from public.mail_account_consent_receipts where id = $1",
        [grantId],
      );
      expect(still!.decision).toBe("granted");
    });

    it("14/15. the projection cannot name another mailbox's or another kind's receipt", async () => {
      const a = await connectedAccount(USERS.pro);
      const b = await connectedAccount(USERS.free);
      const [bReceipt] = await adminQuery<{ id: string }>(
        `select id from public.mail_account_consent_receipts
          where mail_account_id = $1 and consent_kind = 'private_gmail_processing'`,
        [b.id],
      );

      // Wrong mailbox. The event ordinal is carried across too, so what refuses
      // is the FK and not merely a missing column.
      await expect(
        adminQuery(
          `update public.mail_account_consents
              set current_receipt_id = $2,
                  current_event_seq = (select event_seq
                                         from public.mail_account_consent_receipts where id = $2)
            where mail_account_id = $1 and consent_kind = 'private_gmail_processing'`,
          [a.id, bReceipt!.id],
        ),
      ).rejects.toThrow(/consents_receipt_fk|foreign key/i);

      // Wrong permission: a private-processing receipt cannot back a network
      // contribution projection.
      const [aReceipt] = await adminQuery<{ id: string; event_seq: string }>(
        `select id, event_seq from public.mail_account_consent_receipts
          where mail_account_id = $1 and consent_kind = 'private_gmail_processing'`,
        [a.id],
      );
      await expect(
        adminQuery(
          `insert into public.mail_account_consents
             (mail_account_id, user_id, consent_kind, state, current_receipt_id, current_event_seq)
           values ($1,$2,'network_intelligence_contribution','granted',$3,$4)`,
          [a.id, a.userId, aReceipt!.id, aReceipt!.event_seq],
        ),
      ).rejects.toThrow(/consents_receipt_fk|foreign key/i);
    });

    it("8b. the projection cannot disagree with the decision it represents", async () => {
      const account = await connectedAccount();
      // In ONE transaction, because a receipt with no projection is now itself
      // refused: the point under test is the composite FK, so nothing else may
      // be what fails.
      const error = await inTransaction(async (q) => {
        const withdrawn = await q(
          `insert into public.mail_account_consent_receipts
             (mail_account_id, user_id, consent_kind, decision, policy_version,
              consent_text_digest, granted_scopes_at_decision, decided_by_user_id,
              decided_at, receipt_digest)
           values ($1,$2,'network_intelligence_contribution','withdrawn',$3,$4,
                   array[$6]::text[],$2, now(), $5)
           returning id, event_seq`,
          [account.id, account.userId, POLICY_VERSION, digest("x"), digest(uniq()), GMAIL_READONLY],
        );
        const row = withdrawn.rows[0] as { id: string; event_seq: string };
        // `granted` while naming a withdrawal is unrepresentable, not merely
        // unlikely: the composite FK carries the decision itself.
        await q(
          `insert into public.mail_account_consents
             (mail_account_id, user_id, consent_kind, state, current_receipt_id, current_event_seq)
           values ($1,$2,'network_intelligence_contribution','granted',$3,$4)`,
          [account.id, account.userId, row.id, row.event_seq],
        );
      });
      expect(error).toMatch(/consents_receipt_fk|foreign key/i);
    });

    it("4b. a consent receipt cannot be attributed to the wrong owner", async () => {
      const account = await connectedAccount(USERS.pro);
      await expect(
        adminQuery(
          `insert into public.mail_account_consent_receipts
             (mail_account_id, user_id, consent_kind, decision, policy_version,
              consent_text_digest, decided_by_user_id, decided_at, receipt_digest)
           values ($1,$2,'private_gmail_processing','granted',$3,$4,$2, now(), $5)`,
          [account.id, USERS.free, POLICY_VERSION, digest("x"), digest(uniq())],
        ),
      ).rejects.toThrow(/receipts_account_fk|foreign key/i);
    });

    it("nobody may decide on another human's behalf in B01", async () => {
      const account = await connectedAccount(USERS.pro);
      await expect(
        adminQuery(
          `insert into public.mail_account_consent_receipts
             (mail_account_id, user_id, consent_kind, decision, policy_version,
              consent_text_digest, decided_by_user_id, decided_at, receipt_digest)
           values ($1,$2,'network_intelligence_contribution','granted',$3,$4,$5, now(), $6)`,
          [account.id, account.userId, POLICY_VERSION, digest("x"), USERS.admin, digest(uniq())],
        ),
      ).rejects.toThrow(/self_decided|violates check constraint/i);
    });

    it("a mailbox cannot be `connected` without granted private-processing consent", async () => {
      const account = await pendingAccount();
      const error = await inTransaction(async (q) => {
        await q(
          `update public.mail_accounts
              set connection_state = 'connected', connected_at = now(),
                  granted_scopes = array[$2]::text[]
            where id = $1`,
          [account.id, GMAIL_READONLY],
        );
      });
      expect(error).toMatch(/cannot be `connected` without a granted private_gmail_processing/);
      expect((await accountRow(account.id)).connection_state).toBe("pending_authorization");
    });

    it("withdrawing private processing cannot leave the mailbox `connected`", async () => {
      const account = await connectedAccount();
      const error = await inTransaction(async (q) => {
        const r = await q(
          `insert into public.mail_account_consent_receipts
             (mail_account_id, user_id, consent_kind, decision, policy_version,
              consent_text_digest, granted_scopes_at_decision, decided_by_user_id,
              decided_at, receipt_digest)
           values ($1,$2,'private_gmail_processing','withdrawn',$3,$4,
                   array[$6]::text[],$2, now(), $5)
           returning id, event_seq`,
          [account.id, account.userId, POLICY_VERSION, digest("x"), digest(uniq()), GMAIL_READONLY],
        );
        const row = r.rows[0] as { id: string; event_seq: string };
        await q(
          `update public.mail_account_consents
              set state = 'withdrawn', current_receipt_id = $2, current_event_seq = $3
            where mail_account_id = $1 and consent_kind = 'private_gmail_processing'`,
          [account.id, row.id, row.event_seq],
        );
      });
      expect(error).toMatch(/cannot be `connected` without a granted private_gmail_processing/);
      expect((await accountRow(account.id)).connection_state).toBe("connected");
    });
  });

  // =====================================================================
  describe("scopes are a contract, not a preference", () => {
    it("gmail.readonly and gmail.send are both permitted, together", async () => {
      const account = await connectedAccount(USERS.pro, [GMAIL_READONLY, GMAIL_SEND]);
      expect((await accountRow(account.id)).granted_scopes).toEqual([GMAIL_READONLY, GMAIL_SEND]);
    });

    it("the broader Gmail scopes are refused by the database", async () => {
      const account = await connectedAccount();
      for (const scope of [
        "https://mail.google.com/",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.compose",
        "https://www.googleapis.com/auth/gmail.insert",
        "https://www.googleapis.com/auth/gmail.metadata",
        "https://www.googleapis.com/auth/gmail.settings.basic",
        "https://www.googleapis.com/auth/gmail.settings.sharing",
      ]) {
        await expect(
          adminQuery(
            "update public.mail_accounts set granted_scopes = array[$2,$3]::text[] where id = $1",
            [account.id, GMAIL_READONLY, scope],
          ),
          scope,
        ).rejects.toThrow(/scope_allowlist|violates check constraint/i);
      }
    });

    it("a provider other than gmail is a contract, not a value", async () => {
      await expect(
        adminQuery(
          `insert into public.mail_accounts (user_id, provider, provider_account_subject)
           values ($1, 'outlook', $2)`,
          [USERS.pro, `sub-${uniq()}`],
        ),
      ).rejects.toThrow(/violates check constraint/i);
    });
  });

  // =====================================================================
  describe("disconnect is not delete", () => {
    it("16. disconnected is represented distinctly from any deletion", async () => {
      const account = await connectedAccount();
      await adminQuery(
        `update public.mail_accounts
            set connection_state = 'disconnected', disconnected_at = now(),
                granted_scopes = '{}', last_state_change_at = now()
          where id = $1`,
        [account.id],
      );
      const row = await accountRow(account.id);
      expect(row.connection_state).toBe("disconnected");
      expect(row.granted_scopes).toEqual([]);
      // Disconnected and NOT deleted: no request exists, and stored data (none
      // yet) would legitimately remain.
      const requests = await adminQuery(
        "select id from public.mail_account_deletion_requests where mail_account_id = $1",
        [account.id],
      );
      expect(requests).toHaveLength(0);
    });

    it("a disconnected mailbox may not keep usable scopes", async () => {
      const account = await connectedAccount();
      await expect(
        adminQuery(
          `update public.mail_accounts
              set connection_state = 'disconnected', disconnected_at = now()
            where id = $1`,
          [account.id],
        ),
      ).rejects.toThrow(/disconnected_shape|violates check constraint/i);
    });

    it("17/19. a deletion request is explicit and stays owner-bound", async () => {
      const account = await connectedAccount();
      await adminQuery(
        `update public.mail_accounts
            set connection_state = 'disconnected', disconnected_at = now(), granted_scopes = '{}'
          where id = $1`,
        [account.id],
      );
      const [request] = await adminQuery<{ id: string; status: string }>(
        `insert into public.mail_account_deletion_requests
           (mail_account_id, user_id, scope, requested_by_user_id, requested_at)
         values ($1,$2,'account_and_gmail_derived_data',$2, now())
         returning id, status`,
        [account.id, account.userId],
      );
      expect(request!.status).toBe("requested");

      const owner = await queryAs(
        { role: "authenticated", sub: USERS.pro },
        "select id, status from public.mail_account_deletion_requests where id = $1",
        [request!.id],
      );
      expect(owner.rows).toHaveLength(1);

      // Not the owner's mailbox: refused at the composite FK.
      const other = await connectedAccount(USERS.free);
      await expect(
        adminQuery(
          `insert into public.mail_account_deletion_requests
             (mail_account_id, user_id, scope, requested_by_user_id, requested_at)
           values ($1,$2,'gmail_derived_data',$2, now())`,
          [other.id, USERS.pro],
        ),
      ).rejects.toThrow(/deletion_requests_account_fk|foreign key/i);
    });

    it("only the owner may request deletion — no staff-initiated path exists", async () => {
      const account = await connectedAccount(USERS.pro);
      await expect(
        adminQuery(
          `insert into public.mail_account_deletion_requests
             (mail_account_id, user_id, scope, requested_by_user_id, requested_at)
           values ($1,$2,'gmail_derived_data',$3, now())`,
          [account.id, account.userId, USERS.admin],
        ),
      ).rejects.toThrow(/self_requested|violates check constraint/i);
    });

    it("18. `deleted` requires a COMPLETED deletion, and `deletion_pending` an open one", async () => {
      const account = await connectedAccount();
      await adminQuery(
        `update public.mail_accounts
            set connection_state = 'disconnected', disconnected_at = now(), granted_scopes = '{}'
          where id = $1`,
        [account.id],
      );

      // A label with nothing behind it is a promise to the user that nothing is
      // keeping. The pointer is what makes the promise checkable, so a deletion
      // state that names no request cannot even be written.
      const pendingWithoutRequest = await inTransaction(async (q) => {
        await q(
          "update public.mail_accounts set connection_state = 'deletion_pending' where id = $1",
          [account.id],
        );
      });
      expect(pendingWithoutRequest).toMatch(/naming a deletion request that does not exist yet/);

      const deletedWithoutCompletion = await inTransaction(async (q) => {
        const r = await q(
          `insert into public.mail_account_deletion_requests
             (mail_account_id, user_id, scope, requested_by_user_id, requested_at)
           values ($1,$2,'account_and_gmail_derived_data',$2, now()) returning id`,
          [account.id, account.userId],
        );
        const requestId = (r.rows[0] as { id: string }).id;
        await q(
          `update public.mail_accounts
              set connection_state = 'deletion_pending', current_deletion_request_id = $2
            where id = $1`,
          [account.id, requestId],
        );
        await q("update public.mail_accounts set connection_state = 'deleted' where id = $1", [
          account.id,
        ]);
      });
      expect(deletedWithoutCompletion).toMatch(/the deletion request it names is requested/);

      // The legitimate path: request -> pending on it -> complete -> deleted.
      const ok = await inTransaction(async (q) => {
        const r = await q(
          `insert into public.mail_account_deletion_requests
             (mail_account_id, user_id, scope, requested_by_user_id, requested_at)
           values ($1,$2,'account_and_gmail_derived_data',$2, now()) returning id`,
          [account.id, account.userId],
        );
        const requestId = (r.rows[0] as { id: string }).id;
        await q(
          `update public.mail_accounts
              set connection_state = 'deletion_pending', current_deletion_request_id = $2,
                  last_state_change_at = now()
            where id = $1`,
          [account.id, requestId],
        );
        await q(
          `update public.mail_account_deletion_requests
              set status = 'completed', completed_at = now(),
                  network_contributions_invalidated_at = now()
            where id = $1`,
          [requestId],
        );
        await q(
          `update public.mail_accounts set connection_state = 'deleted', last_state_change_at = now()
            where id = $1`,
          [account.id],
        );
      });
      expect(ok).toBeNull();
      expect((await accountRow(account.id)).connection_state).toBe("deleted");
    });

    it("a deleted mailbox cannot be treated as connected", async () => {
      // `deleted` and `connected` are values of one column, so the two cannot be
      // held at once; and returning to `connected` needs consent all over again.
      const account = await connectedAccount();
      await disconnectAccount(account);
      await retireAccount(account);
      const row = await accountRow(account.id);
      expect(row.connection_state).toBe("deleted");
      expect(row.connection_state).not.toBe("connected");
      expect(row.granted_scopes).toEqual([]);
    });

    it("a completed request must say when, and a failed one why", async () => {
      const account = await connectedAccount();
      await expect(
        adminQuery(
          `insert into public.mail_account_deletion_requests
             (mail_account_id, user_id, scope, requested_by_user_id, requested_at, status)
           values ($1,$2,'gmail_derived_data',$2, now(), 'completed')`,
          [account.id, account.userId],
        ),
      ).rejects.toThrow(/terminal_shape|violates check constraint/i);
      await expect(
        adminQuery(
          `insert into public.mail_account_deletion_requests
             (mail_account_id, user_id, scope, requested_by_user_id, requested_at, status)
           values ($1,$2,'gmail_derived_data',$2, now(), 'failed')`,
          [account.id, account.userId],
        ),
      ).rejects.toThrow(/terminal_shape|violates check constraint/i);
    });

    it("two concurrent deletions of the same mailbox is a race, not a second decision", async () => {
      const account = await connectedAccount();
      await adminQuery(
        `insert into public.mail_account_deletion_requests
           (mail_account_id, user_id, scope, requested_by_user_id, requested_at)
         values ($1,$2,'gmail_derived_data',$2, now())`,
        [account.id, account.userId],
      );
      await expect(
        adminQuery(
          `insert into public.mail_account_deletion_requests
             (mail_account_id, user_id, scope, requested_by_user_id, requested_at)
           values ($1,$2,'gmail_derived_data',$2, now())`,
          [account.id, account.userId],
        ),
      ).rejects.toThrow(/deletion_requests_open_uidx|duplicate key/i);
    });
  });

  // =====================================================================
  describe("the boundary itself", () => {
    it("15. no OAuth credential column exists anywhere in this plane", async () => {
      const suspicious = await adminQuery<{ table_name: string; column_name: string }>(
        `select table_name, column_name from information_schema.columns
          where table_schema = 'public' and table_name like 'mail_account%'
            and (column_name ~* 'token|secret|credential|password|refresh|bearer'
                 or column_name = 'code')`,
      );
      expect(suspicious).toEqual([]);
    });

    it("22. no Gmail message, thread or attachment table exists as a side effect", async () => {
      const leaked = await adminQuery<{ tablename: string }>(
        `select tablename from pg_tables
          where schemaname = 'public'
            and (tablename ~* 'message|thread|attachment|gmail_history|mail_sync|sync_job')
          order by tablename`,
      );
      expect(leaked).toEqual([]);
    });

    it("every future Gmail-derived table has a provenance target to hang from", async () => {
      // §10: deletion must stay addressable. The additive unique below is what
      // future tables composite-FK `(mail_account_id, owner_user_id)` against,
      // so no Gmail-derived row can lose the account and owner it must be
      // deleted with.
      const [target] = await adminQuery<{ n: string }>(
        `select count(*)::text n from pg_constraint
          where conname = 'mail_accounts_id_user_uk' and contype = 'u'`,
      );
      expect(Number(target!.n)).toBe(1);
    });

    it("deleting the owner removes the entire private plane", async () => {
      const [victim] = await adminQuery<{ id: string }>(
        `insert into public.users (id, email, role) values (gen_random_uuid(), $1, 'creator')
         returning id`,
        [`${uniq()}@example.invalid`],
      );
      const account = await connectedAccount(victim!.id);
      await decideConsent(account, "network_intelligence_contribution", "granted");
      await adminQuery(
        `insert into public.mail_account_deletion_requests
           (mail_account_id, user_id, scope, requested_by_user_id, requested_at)
         values ($1,$2,'gmail_derived_data',$2, now())`,
        [account.id, victim!.id],
      );

      await adminQuery("delete from public.users where id = $1", [victim!.id]);

      for (const table of [
        "mail_accounts",
        "mail_account_consent_receipts",
        "mail_account_consents",
        "mail_account_deletion_requests",
      ]) {
        const rows = await adminQuery(`select 1 from public.${table} where user_id = $1`, [
          victim!.id,
        ]);
        expect(rows, table).toHaveLength(0);
      }
    });

    it("20/21. no canonical hotel or source-publication row is touched by any of this", async () => {
      const before = await adminQuery<{ hotels: string; links: string; pubs: string }>(
        `select (select count(*) from public.hotels)::text hotels,
                (select count(*) from public.hotel_source_identities)::text links,
                (select count(*) from public.source_property_publication_receipts)::text pubs`,
      );
      const account = await connectedAccount();
      await decideConsent(account, "network_intelligence_contribution", "granted");
      const after = await adminQuery<{ hotels: string; links: string; pubs: string }>(
        `select (select count(*) from public.hotels)::text hotels,
                (select count(*) from public.hotel_source_identities)::text links,
                (select count(*) from public.source_property_publication_receipts)::text pubs`,
      );
      expect(after).toEqual(before);
    });

    it("consent history is append-only for the trusted role too", async () => {
      const grants = await adminQuery<{ privilege_type: string }>(
        `select privilege_type from information_schema.role_table_grants
          where table_schema = 'public'
            and table_name = 'mail_account_consent_receipts'
            and grantee = 'service_role' order by privilege_type`,
      );
      expect(grants.map((g) => g.privilege_type).sort()).toEqual(["INSERT", "SELECT"]);

      const client = await adminQuery<{ grantee: string; privilege_type: string }>(
        `select grantee, privilege_type from information_schema.role_table_grants
          where table_schema = 'public' and table_name like 'mail_account%'
            and grantee in ('anon', 'authenticated') order by grantee, privilege_type`,
      );
      // `authenticated` reads its own rows and writes nothing; `anon` holds
      // nothing at all.
      expect([...new Set(client.map((c) => c.grantee))]).toEqual(["authenticated"]);
      expect([...new Set(client.map((c) => c.privilege_type))]).toEqual(["SELECT"]);
    });
  });

  // =====================================================================
  // AMENDMENT #1 — the four blockers an external audit found in the head at
  // 47a198d3, each reproduced on real PostgreSQL before it was fixed.
  //
  // What connects them is that all four let the DATABASE hold a state the
  // DOCUMENTATION said was impossible: consent that had been withdrawn still
  // reading as granted, a deletion that never happened reading as done, a
  // retired record coming back to life, and a consent receipt describing a
  // mailbox that never existed. None of them needed a bug in an application
  // writer — there is no writer for this plane yet. Direct SQL was enough.
  // =====================================================================
  describe("amendment: the current consent is the LATEST consent", () => {
    it("A1. a withdrawal the projection never reaches cannot commit", async () => {
      const account = await connectedAccount();
      const error = await inTransaction(async (q) => {
        await q(
          RECEIPT_INSERT,
          receiptParams(account, "private_gmail_processing", "withdrawn", [GMAIL_READONLY]),
        );
      });
      // Before the amendment this committed, and mail_account_has_consent kept
      // answering `true` about a permission the human had taken back.
      expect(error).toMatch(/the latest recorded decision is event/);
      expect(await hasConsent(account, "private_gmail_processing")).toBe(true);
    });

    it("A2. the projection cannot be re-pointed at a historical grant", async () => {
      const account = await connectedAccount();
      const grantA = await decideConsent(account, "network_intelligence_contribution", "granted");
      await decideConsent(account, "network_intelligence_contribution", "withdrawn");
      expect(await hasConsent(account, "network_intelligence_contribution")).toBe(false);

      const error = await inTransaction(async (q) => {
        await q(
          `update public.mail_account_consents
              set state = 'granted', current_receipt_id = $2,
                  current_event_seq = (select event_seq
                                         from public.mail_account_consent_receipts where id = $2)
            where mail_account_id = $1 and consent_kind = 'network_intelligence_contribution'`,
          [account.id, grantA],
        );
      });
      expect(error).toMatch(/cannot move back from event/);
      expect(await hasConsent(account, "network_intelligence_contribution")).toBe(false);
    });

    it("A3. re-granting after a withdrawal works — through a NEW decision", async () => {
      const account = await connectedAccount();
      await decideConsent(account, "network_intelligence_contribution", "granted");
      await decideConsent(account, "network_intelligence_contribution", "withdrawn");
      expect(await hasConsent(account, "network_intelligence_contribution")).toBe(false);

      await decideConsent(account, "network_intelligence_contribution", "granted");
      expect(await hasConsent(account, "network_intelligence_contribution")).toBe(true);

      // Three receipts, in order, none of them edited.
      const history = await adminQuery<{ decision: string }>(
        `select decision from public.mail_account_consent_receipts
          where mail_account_id = $1 and consent_kind = 'network_intelligence_contribution'
          order by event_seq`,
        [account.id],
      );
      expect(history.map((h) => h.decision)).toEqual(["granted", "withdrawn", "granted"]);
    });

    it("A4. the withdrawal takes effect the moment it commits", async () => {
      const account = await connectedAccount();
      await decideConsent(account, "network_intelligence_contribution", "granted");
      expect(await hasConsent(account, "network_intelligence_contribution")).toBe(true);
      await decideConsent(account, "network_intelligence_contribution", "withdrawn");
      expect(await hasConsent(account, "network_intelligence_contribution")).toBe(false);
    });

    it("A5. deleting the projection cannot un-record a decision", async () => {
      const account = await connectedAccount();
      await decideConsent(account, "network_intelligence_contribution", "granted");
      const error = await inTransaction(async (q) => {
        await q(
          `delete from public.mail_account_consents
            where mail_account_id = $1 and consent_kind = 'network_intelligence_contribution'`,
          [account.id],
        );
      });
      expect(error).toMatch(/no current consent row/);
    });

    it("A6. the FIRST decision must be projected too", async () => {
      const account = await connectedAccount();
      const error = await inTransaction(async (q) => {
        await q(
          RECEIPT_INSERT,
          receiptParams(account, "network_intelligence_contribution", "granted", [GMAIL_READONLY]),
        );
      });
      expect(error).toMatch(/no current consent row/);
      expect(await hasConsent(account, "network_intelligence_contribution")).toBe(false);
    });

    it("A7/A8. the same broken state is refused from EITHER write origin", async () => {
      // The A04.6 amendment #3 lesson: an invariant hung off one side is not an
      // invariant, it is a habit of whoever writes that side. Both origins have
      // to refuse the same end state.
      const account = await connectedAccount();
      await decideConsent(account, "network_intelligence_contribution", "granted");
      const grant = await currentReceipt(account, "network_intelligence_contribution");

      // Origin 1 — the RECEIPT side: append a withdrawal and stop.
      const fromReceiptSide = await inTransaction(async (q) => {
        await q(
          RECEIPT_INSERT,
          receiptParams(account, "network_intelligence_contribution", "withdrawn", [
            GMAIL_READONLY,
          ]),
        );
      });
      expect(fromReceiptSide).toMatch(/the latest recorded decision is event/);

      // Origin 2 — the PROJECTION side. Withdraw properly first, then rebuild
      // the projection onto the old grant by DELETE + INSERT, which the
      // forward-only UPDATE trigger never sees. Only the dominance invariant,
      // registered on this side too, is left to refuse it.
      await decideConsent(account, "network_intelligence_contribution", "withdrawn");
      const fromProjectionSide = await inTransaction(async (q) => {
        await q(
          `delete from public.mail_account_consents
            where mail_account_id = $1 and consent_kind = 'network_intelligence_contribution'`,
          [account.id],
        );
        await q(PROJECTION_UPSERT, [
          account.id,
          account.userId,
          "network_intelligence_contribution",
          "granted",
          grant.id,
          grant.event_seq,
        ]);
      });
      expect(fromProjectionSide).toMatch(/the latest recorded decision is event/);
      expect(await hasConsent(account, "network_intelligence_contribution")).toBe(false);
    });

    it("A9. the event ordinal is the database's, not the caller's", async () => {
      const account = await connectedAccount();
      await expect(
        adminQuery(
          `insert into public.mail_account_consent_receipts
             (event_seq, mail_account_id, user_id, consent_kind, decision, policy_version,
              consent_text_digest, granted_scopes_at_decision, decided_by_user_id,
              decided_at, receipt_digest)
           values (1,$1,$2,'network_intelligence_contribution','granted',$3,$4,
                   array[$6]::text[],$2, now(),$5)`,
          [account.id, account.userId, POLICY_VERSION, digest("x"), digest(uniq()), GMAIL_READONLY],
        ),
      ).rejects.toThrow(/cannot insert a non-DEFAULT value|GENERATED ALWAYS/i);
    });

    it("A10. ordering is the ordinal, NOT the caller-supplied decided_at", async () => {
      // The decisive case: a withdrawal back-dated to before the grant. If
      // `decided_at` ordered events, this would read as an old withdrawal that
      // the grant superseded — and the mailbox would stay authorized.
      const account = await connectedAccount();
      await decideConsent(account, "network_intelligence_contribution", "granted");
      await txOk(async (q) => {
        const r = await q(
          `insert into public.mail_account_consent_receipts
             (mail_account_id, user_id, consent_kind, decision, policy_version,
              consent_text_digest, granted_scopes_at_decision, decided_by_user_id,
              decided_at, receipt_digest)
           values ($1,$2,'network_intelligence_contribution','withdrawn',$3,$4,
                   array[$6]::text[],$2, now() - interval '10 years', $5)
           returning id, event_seq`,
          [account.id, account.userId, POLICY_VERSION, digest("x"), digest(uniq()), GMAIL_READONLY],
        );
        const row = r.rows[0] as { id: string; event_seq: string };
        await q(PROJECTION_UPSERT, [
          account.id,
          account.userId,
          "network_intelligence_contribution",
          "withdrawn",
          row.id,
          row.event_seq,
        ]);
      });
      expect(await hasConsent(account, "network_intelligence_contribution")).toBe(false);

      const [ordering] = await adminQuery<{ oldest_is_latest: boolean }>(
        `select (select decision from public.mail_account_consent_receipts
                  where mail_account_id = $1 and consent_kind = 'network_intelligence_contribution'
                  order by decided_at desc limit 1) = 'granted' oldest_is_latest
         from public.mail_accounts where id = $1`,
        [account.id],
      );
      // Sorting by decided_at genuinely gives the WRONG answer here, which is
      // why nothing in this schema does.
      expect(ordering!.oldest_is_latest).toBe(true);
    });

    it("A11. dominance is per (mailbox, permission), not global", async () => {
      const a = await connectedAccount(USERS.pro);
      const b = await connectedAccount(USERS.free);
      // b's grant carries a HIGHER global ordinal than a's; then a withdraws,
      // taking a higher one still. b must be unaffected.
      await decideConsent(a, "network_intelligence_contribution", "granted");
      await decideConsent(b, "network_intelligence_contribution", "granted");
      await decideConsent(a, "network_intelligence_contribution", "withdrawn");
      expect(await hasConsent(a, "network_intelligence_contribution")).toBe(false);
      expect(await hasConsent(b, "network_intelligence_contribution")).toBe(true);
    });

    it("A12. the projection's ordinal cannot lie about its receipt", async () => {
      const account = await connectedAccount();
      const grant = await currentReceipt(account, "private_gmail_processing");
      await expect(
        adminQuery(
          `update public.mail_account_consents set current_event_seq = $2
            where mail_account_id = $1 and consent_kind = 'private_gmail_processing'`,
          [account.id, Number(grant.event_seq) + 1000],
        ),
      ).rejects.toThrow(/consents_receipt_fk|foreign key/i);
    });
  });

  // =====================================================================
  describe("amendment: a deletion state names the deletion it rests on", () => {
    it("B1. a completed `gmail_derived_data` request cannot retire the record", async () => {
      const account = await connectedAccount();
      await disconnectAccount(account);
      const error = await inTransaction(async (q) => {
        const r = await q(
          `insert into public.mail_account_deletion_requests
             (mail_account_id, user_id, scope, requested_by_user_id, requested_at)
           values ($1,$2,'gmail_derived_data',$2, now()) returning id`,
          [account.id, account.userId],
        );
        const id = (r.rows[0] as { id: string }).id;
        await q(
          `update public.mail_accounts
              set connection_state = 'deletion_pending', current_deletion_request_id = $2
            where id = $1`,
          [account.id, id],
        );
        await q(
          "update public.mail_account_deletion_requests set status='completed', completed_at=now() where id=$1",
          [id],
        );
        await q("update public.mail_accounts set connection_state='deleted' where id=$1", [
          account.id,
        ]);
      });
      // That request asked for derived data to go while the RECORD is kept.
      expect(error).toMatch(/on the strength of a `gmail_derived_data` request/);
      expect((await accountRow(account.id)).connection_state).toBe("disconnected");
    });

    it("B2. `deleted` cannot be reached without waiting on the deletion", async () => {
      const account = await connectedAccount();
      await disconnectAccount(account);
      const error = await inTransaction(async (q) => {
        const r = await q(
          `insert into public.mail_account_deletion_requests
             (mail_account_id, user_id, scope, requested_by_user_id, requested_at, status,
              completed_at)
           values ($1,$2,'account_and_gmail_derived_data',$2, now(),'completed', now())
           returning id`,
          [account.id, account.userId],
        );
        await q(
          `update public.mail_accounts
              set connection_state = 'deleted', current_deletion_request_id = $2
            where id = $1`,
          [account.id, (r.rows[0] as { id: string }).id],
        );
      });
      expect(error).toMatch(/straight to `deleted`/);
    });

    it("B3. an unrelated completed request cannot be adopted as evidence later", async () => {
      // The audit's clause in full: a present-tense claim must not be satisfied
      // by an old event. Pointing at a finished request is impossible because
      // the pointer can only be set while the request is still open.
      const account = await connectedAccount();
      await disconnectAccount(account);
      const stale = await openDeletionRequest(account, "account_and_gmail_derived_data");
      await adminQuery(
        "update public.mail_account_deletion_requests set status='completed', completed_at=now() where id=$1",
        [stale],
      );

      const error = await inTransaction(async (q) => {
        await q(
          `update public.mail_accounts
              set connection_state = 'deletion_pending', current_deletion_request_id = $2
            where id = $1`,
          [account.id, stale],
        );
        await q("update public.mail_accounts set connection_state='deleted' where id=$1", [
          account.id,
        ]);
      });
      expect(error).toMatch(
        /cannot start waiting on a deletion request that is already `completed`/,
      );
      expect((await accountRow(account.id)).connection_state).toBe("disconnected");
    });

    it("B4. `deletion_pending` must name a request that is actually running", async () => {
      const account = await connectedAccount();
      await disconnectAccount(account);
      const done = await openDeletionRequest(account, "gmail_derived_data");
      await adminQuery(
        "update public.mail_account_deletion_requests set status='failed', failure_reason='provider timeout' where id=$1",
        [done],
      );
      const error = await inTransaction(async (q) => {
        await q(
          `update public.mail_accounts
              set connection_state = 'deletion_pending', current_deletion_request_id = $2
            where id = $1`,
          [account.id, done],
        );
      });
      expect(error).toMatch(/cannot start waiting on a deletion request that is already `failed`/);
    });

    it("B5. the pointer must name THIS mailbox's request", async () => {
      const mine = await connectedAccount(USERS.pro);
      const theirs = await connectedAccount(USERS.free);
      await disconnectAccount(mine);
      const theirRequest = await openDeletionRequest(theirs, "account_and_gmail_derived_data");
      const error = await inTransaction(async (q) => {
        await q(
          `update public.mail_accounts
              set connection_state = 'deletion_pending', current_deletion_request_id = $2
            where id = $1`,
          [mine.id, theirRequest],
        );
      });
      expect(error).toMatch(/current_deletion_request_fk|foreign key/i);
    });

    it("B6. a mailbox that is not being deleted carries no deletion pointer", async () => {
      const account = await connectedAccount();
      const request = await openDeletionRequest(account, "gmail_derived_data");
      await expect(
        adminQuery(
          "update public.mail_accounts set current_deletion_request_id = $2 where id = $1",
          [account.id, request],
        ),
      ).rejects.toThrow(/non_deletion_state_has_no_request/);
    });

    it("B7. the legitimate retirement is still possible, and only that one", async () => {
      const account = await connectedAccount();
      await disconnectAccount(account);
      const request = await retireAccount(account);
      const row = await accountRow(account.id);
      expect(row.connection_state).toBe("deleted");
      const [pointer] = await adminQuery<{ current_deletion_request_id: string }>(
        "select current_deletion_request_id from public.mail_accounts where id = $1",
        [account.id],
      );
      expect(pointer!.current_deletion_request_id).toBe(request);
    });

    it("B8. the request a retired record rests on cannot be removed", async () => {
      const account = await connectedAccount();
      await disconnectAccount(account);
      const request = await retireAccount(account);
      const error = await inTransaction(async (q) => {
        await q("delete from public.mail_account_deletion_requests where id = $1", [request]);
      });
      expect(error).toMatch(/current_deletion_request_fk|foreign key|still referenced/i);
    });
  });

  // =====================================================================
  describe("amendment: `deleted` is terminal", () => {
    it("C1. a retired mailbox cannot be reconnected", async () => {
      const account = await connectedAccount();
      await disconnectAccount(account);
      await retireAccount(account);
      const error = await inTransaction(async (q) => {
        await q(
          `update public.mail_accounts
              set connection_state = 'connected', connected_at = now(),
                  granted_scopes = array[$2]::text[]
            where id = $1`,
          [account.id, GMAIL_READONLY],
        );
      });
      expect(error).toMatch(/is `deleted` and cannot become `connected`/);
    });

    it("C2. no state at all is reachable out of `deleted`", async () => {
      const account = await connectedAccount();
      await disconnectAccount(account);
      await retireAccount(account);
      for (const state of [
        "pending_authorization",
        "connected",
        "reauth_required",
        "disconnected",
        "deletion_pending",
      ]) {
        const error = await inTransaction(async (q) => {
          await q("update public.mail_accounts set connection_state = $2 where id = $1", [
            account.id,
            state,
          ]);
        });
        expect(error, state).toMatch(/is `deleted` and cannot become/);
      }
      expect((await accountRow(account.id)).connection_state).toBe("deleted");
    });

    it("C3. the evidence a retired record names cannot be swapped", async () => {
      const account = await connectedAccount();
      await disconnectAccount(account);
      await retireAccount(account);
      const other = await openDeletionRequest(account, "account_and_gmail_derived_data");
      const error = await inTransaction(async (q) => {
        await q("update public.mail_accounts set current_deletion_request_id = $2 where id = $1", [
          account.id,
          other,
        ]);
      });
      expect(error).toMatch(/cannot be replaced/);
    });

    it("C4. a returning creator reconnects as a NEW mailbox record", async () => {
      // Terminality would be a bug rather than a guarantee if it meant "you may
      // never use this address again". The old row keeps its deletion evidence;
      // the new one is a separate authorization and a separate consent.
      const account = await connectedAccount();
      await disconnectAccount(account);
      await retireAccount(account);

      const [again] = await adminQuery<{ id: string }>(
        `insert into public.mail_accounts (user_id, provider, provider_account_subject)
         values ($1,'gmail',$2) returning id`,
        [account.userId, account.subject],
      );
      expect(again!.id).not.toBe(account.id);

      // ...but two LIVE records for one Google account remain impossible.
      await expect(
        adminQuery(
          `insert into public.mail_accounts (user_id, provider, provider_account_subject)
           values ($1,'gmail',$2)`,
          [account.userId, account.subject],
        ),
      ).rejects.toThrow(/provider_account_uidx|duplicate key/i);
    });
  });

  // =====================================================================
  describe("amendment: consent scopes are evidence about the mailbox", () => {
    it("D1. a receipt cannot claim scopes the mailbox does not hold", async () => {
      const account = await connectedAccount(USERS.pro, [GMAIL_READONLY]);
      const error = await inTransaction(async (q) => {
        const r = await q(
          RECEIPT_INSERT,
          receiptParams(account, "network_intelligence_contribution", "granted", []),
        );
        const row = r.rows[0] as { id: string; event_seq: string };
        await q(PROJECTION_UPSERT, [
          account.id,
          account.userId,
          "network_intelligence_contribution",
          "granted",
          row.id,
          row.event_seq,
        ]);
      });
      expect(error).toMatch(/records scopes .* but mail account .* actually holds/s);
    });

    it("D2. a forbidden scope cannot enter through the consent side either", async () => {
      const account = await connectedAccount();
      for (const scope of [
        "https://mail.google.com/",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.metadata",
      ]) {
        await expect(
          adminQuery(
            RECEIPT_INSERT,
            receiptParams(account, "private_gmail_processing", "granted", [scope]),
          ),
          scope,
        ).rejects.toThrow(/consent_receipts_scope_allowlist/);
      }
    });

    it("D3. scopes are compared as SETS, not as arrays", async () => {
      const account = await connectedAccount(USERS.pro, [
        GMAIL_SEND,
        GMAIL_READONLY,
        GMAIL_READONLY,
      ]);
      expect((await accountRow(account.id)).granted_scopes).toEqual([GMAIL_READONLY, GMAIL_SEND]);
      const snapshot = await currentReceipt(account, "private_gmail_processing");
      expect(snapshot.granted_scopes_at_decision).toEqual([GMAIL_READONLY, GMAIL_SEND]);
    });

    it("D4. widening to gmail.send without renewing consent is refused", async () => {
      const account = await connectedAccount(USERS.pro, [GMAIL_READONLY]);
      const error = await inTransaction(async (q) => {
        await q(
          "update public.mail_accounts set granted_scopes = array[$2,$3]::text[] where id = $1",
          [account.id, GMAIL_READONLY, GMAIL_SEND],
        );
      });
      // The documented contract and the database now say the same thing.
      expect(error).toMatch(/record a NEW consent receipt for the current scope set/);
      expect((await accountRow(account.id)).granted_scopes).toEqual([GMAIL_READONLY]);
    });

    it("D5. widening WITH a renewed consent is accepted", async () => {
      const account = await connectedAccount(USERS.pro, [GMAIL_READONLY]);
      await txOk(async (q) => {
        await q(
          "update public.mail_accounts set granted_scopes = array[$2,$3]::text[] where id = $1",
          [account.id, GMAIL_READONLY, GMAIL_SEND],
        );
        const r = await q(
          RECEIPT_INSERT,
          receiptParams(account, "private_gmail_processing", "granted", [
            GMAIL_READONLY,
            GMAIL_SEND,
          ]),
        );
        const row = r.rows[0] as { id: string; event_seq: string };
        await q(PROJECTION_UPSERT, [
          account.id,
          account.userId,
          "private_gmail_processing",
          "granted",
          row.id,
          row.event_seq,
        ]);
      });
      expect((await accountRow(account.id)).granted_scopes).toEqual([GMAIL_READONLY, GMAIL_SEND]);
    });

    it("D6. narrowing without renewing consent is refused for the same reason", async () => {
      const account = await connectedAccount(USERS.pro, [GMAIL_READONLY, GMAIL_SEND]);
      const error = await inTransaction(async (q) => {
        await q(
          "update public.mail_accounts set granted_scopes = array[$2]::text[] where id = $1",
          [account.id, GMAIL_READONLY],
        );
      });
      expect(error).toMatch(/record a NEW consent receipt for the current scope set/);
    });

    it("D7. a historical receipt is NOT rewritten when scopes later change", async () => {
      const account = await connectedAccount(USERS.pro, [GMAIL_READONLY]);
      const first = await currentReceipt(account, "private_gmail_processing");
      await txOk(async (q) => {
        await q(
          "update public.mail_accounts set granted_scopes = array[$2,$3]::text[] where id = $1",
          [account.id, GMAIL_READONLY, GMAIL_SEND],
        );
        const r = await q(
          RECEIPT_INSERT,
          receiptParams(account, "private_gmail_processing", "granted", [
            GMAIL_READONLY,
            GMAIL_SEND,
          ]),
        );
        const row = r.rows[0] as { id: string; event_seq: string };
        await q(PROJECTION_UPSERT, [
          account.id,
          account.userId,
          "private_gmail_processing",
          "granted",
          row.id,
          row.event_seq,
        ]);
      });
      const [unchanged] = await adminQuery<{ granted_scopes_at_decision: string[] }>(
        "select granted_scopes_at_decision from public.mail_account_consent_receipts where id = $1",
        [first.id],
      );
      expect(unchanged!.granted_scopes_at_decision).toEqual([GMAIL_READONLY]);
    });
  });

  // =====================================================================
  describe("amendment: `connected` means we can actually read", () => {
    it("E1. `connected` without gmail.readonly is refused", async () => {
      const account = await pendingAccount();
      const error = await inTransaction(async (q) => {
        await q(
          `update public.mail_accounts
              set connection_state='connected', connected_at=now(),
                  granted_scopes=array['openid',$2]::text[]
            where id = $1`,
          [account.id, GMAIL_SEND],
        );
      });
      expect(error).toMatch(/mail_accounts_connected_requires_read/);
    });

    it("E2. gmail.readonly is what makes the state assertable", async () => {
      const account = await connectedAccount(USERS.pro, [GMAIL_READONLY, GMAIL_SEND]);
      expect((await accountRow(account.id)).connection_state).toBe("connected");
    });
  });

  // =====================================================================
  describe("amendment: what the delete guard actually proves", () => {
    it("F1. one receipt cannot be deleted while its mailbox exists", async () => {
      const account = await connectedAccount();
      const receipt = await currentReceipt(account, "private_gmail_processing");
      const error = await inTransaction(async (q) => {
        await q("delete from public.mail_account_consent_receipts where id = $1", [receipt.id]);
      });
      expect(error).toMatch(/consent history is removed only by deleting the mailbox or the user/);
    });

    it("F2. deleting the mailbox removes its consent history", async () => {
      const account = await connectedAccount();
      await decideConsent(account, "network_intelligence_contribution", "granted");
      await adminQuery("delete from public.mail_accounts where id = $1", [account.id]);
      const left = await adminQuery<{ n: string }>(
        `select (select count(*) from public.mail_account_consent_receipts
                  where mail_account_id = $1)::text n`,
        [account.id],
      );
      expect(left[0]!.n).toBe("0");
    });

    it("F3. deleting the user removes it through the OTHER cascade too", async () => {
      // `decided_by_user_id` cascades from users directly to receipts, and
      // PostgreSQL does not promise it fires after the mail_accounts cascade.
      // A guard that only asked about the mailbox would block user deletion
      // intermittently; this is the test that would have caught it.
      const [user] = await adminQuery<{ id: string }>(
        `insert into public.users (id, email, role) values (gen_random_uuid(), $1, 'creator')
         returning id`,
        [`amend-${uniq()}@example.invalid`],
      );
      const account = await connectedAccount(user!.id);
      await decideConsent(account, "network_intelligence_contribution", "granted");
      await expect(
        adminQuery("delete from public.users where id = $1", [user!.id]),
      ).resolves.toBeDefined();
      const left = await adminQuery<{ accounts: string; receipts: string }>(
        `select (select count(*) from public.mail_accounts where user_id = $1)::text accounts,
                (select count(*) from public.mail_account_consent_receipts
                  where user_id = $1)::text receipts`,
        [user!.id],
      );
      expect(left[0]).toEqual({ accounts: "0", receipts: "0" });
    });
  });
});
