import { Client } from "pg";

/**
 * A stand-in for the Supabase service-role client that speaks to REAL
 * PostgreSQL.
 *
 * B02's atomicity, ownership and consent guarantees live inside the 0036
 * SECURITY DEFINER functions, so testing them against a mocked database would
 * test nothing that matters. This shim exposes the one method the server code
 * uses — `.rpc(name, args)` — and translates it into a call on the actual
 * function, using named-parameter notation so the argument mapping is the same
 * one PostgREST performs.
 */
export interface RpcResult<T = unknown> {
  data: T | null;
  error: { message: string } | null;
}

export interface FakeAdminClient {
  rpc<T = unknown>(name: string, args: Record<string, unknown>): Promise<RpcResult<T>>;
}

export function createRpcClient(client: Client): FakeAdminClient {
  return {
    async rpc<T>(name: string, args: Record<string, unknown>): Promise<RpcResult<T>> {
      const keys = Object.keys(args);
      const named = keys.map((key, i) => `${key} := $${i + 1}`).join(", ");
      // PostgREST sends the whole argument object as JSON, so a jsonb parameter
      // arrives as JSON there. `pg` would instead bind a JS array as a POSTGRES
      // ARRAY, which is the right thing for `text[]` and the wrong thing for
      // `jsonb`. Serializing structured values keeps this shim faithful to the
      // client the server code actually runs against.
      const values = keys.map((key) => {
        const value = args[key];
        if (Array.isArray(value)) {
          return value.every((item) => typeof item === "string") ? value : JSON.stringify(value);
        }
        if (value !== null && typeof value === "object" && !(value instanceof Date)) {
          return JSON.stringify(value);
        }
        return value;
      });
      try {
        const res = await client.query(`select public.${name}(${named}) as value`, values);
        return { data: (res.rows[0]?.value ?? null) as T, error: null };
      } catch (error) {
        return { data: null, error: { message: (error as Error).message } };
      }
    },
  };
}

/** A creator, created directly because B02 does not own user provisioning. */
export async function createTestUser(client: Client, label: string): Promise<string> {
  const res = await client.query(
    `insert into public.users (id, email, role)
     values (gen_random_uuid(), $1, 'creator') returning id`,
    [`${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`],
  );
  return res.rows[0].id as string;
}

/** Read a mailbox row directly, for assertions the RPCs deliberately do not expose. */
export async function readMailAccount(client: Client, id: string) {
  const res = await client.query(
    `select id, user_id, provider, provider_account_subject, email_address,
            connection_state, granted_scopes, connected_at, disconnected_at
       from public.mail_accounts where id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

/** Count stored credentials for a mailbox, via the owner connection. */
export async function countCredentials(client: Client, mailAccountId: string): Promise<number> {
  const res = await client.query(
    "select count(*)::int as n from private.gmail_oauth_credentials where mail_account_id = $1",
    [mailAccountId],
  );
  return res.rows[0].n as number;
}
