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

/**
 * The declared argument types of one `public.` function, from the catalog.
 *
 * PostgREST knows the signature it is calling, and that knowledge is not a
 * detail — it is what tells it whether `[]` is an empty `text[]` or an empty
 * `jsonb` array. Guessing from the JavaScript value cannot distinguish them, and
 * guessing wrong made an empty sanitized message set arrive as a Postgres array
 * that would not cast to `jsonb`, which silently turned a legitimate
 * "this thread had nothing to store" into an RPC error. So this shim reads the
 * signature too.
 */
const signatures = new Map<string, Promise<{ names: string[]; types: string[] }>>();

function loadSignature(client: Client, name: string) {
  const cached = signatures.get(name);
  if (cached) return cached;
  const pending = client
    .query(
      `select coalesce(p.proargnames, '{}') as names,
              array(select format_type(t, null) from unnest(p.proargtypes) as t) as types
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1
        limit 1`,
      [name],
    )
    .then((res) => ({
      names: (res.rows[0]?.names ?? []) as string[],
      types: (res.rows[0]?.types ?? []) as string[],
    }));
  signatures.set(name, pending);
  return pending;
}

export function createRpcClient(client: Client): FakeAdminClient {
  return {
    async rpc<T>(name: string, args: Record<string, unknown>): Promise<RpcResult<T>> {
      const keys = Object.keys(args);
      let signature: { names: string[]; types: string[] };
      try {
        signature = await loadSignature(client, name);
      } catch (error) {
        return { data: null, error: { message: (error as Error).message } };
      }

      const declaredType = (key: string): string | null => {
        const index = signature.names.indexOf(key);
        return index >= 0 ? (signature.types[index] ?? null) : null;
      };

      // PostgREST sends the whole argument object as JSON, so a jsonb parameter
      // arrives as JSON there. `pg` would instead bind a JS array as a POSTGRES
      // ARRAY, which is right for `text[]` and wrong for `jsonb`. The declared
      // type decides, so an EMPTY array is not ambiguous either.
      const values = keys.map((key) => {
        const value = args[key];
        const type = declaredType(key);
        if (type === "jsonb" || type === "json") {
          return value === null || value === undefined ? null : JSON.stringify(value);
        }
        if (Array.isArray(value)) return value;
        if (value !== null && typeof value === "object" && !(value instanceof Date)) {
          return JSON.stringify(value);
        }
        return value;
      });

      // The cast is explicit for the same reason: a bare `$n` for a NULL or an
      // empty array leaves Postgres guessing at a type it should not have to.
      const named = keys
        .map((key, i) => {
          const type = declaredType(key);
          return `${key} := $${i + 1}${type ? `::${type}` : ""}`;
        })
        .join(", ");

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
