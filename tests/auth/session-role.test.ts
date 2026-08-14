/**
 * Session role resolution against real database roles (audit F-01).
 *
 * The role a session carries decides whether the admin surface opens, so it is
 * asserted here end to end: the `public.users` read runs as the real
 * `authenticated` Postgres role with a real JWT `sub`, under the real
 * `users_select_own` policy. Nothing about the role is simulated.
 *
 * The defect this replaces: the read's error was discarded and `?? "creator"`
 * applied, so a permission failure, a transport failure or a corrupt row all
 * became the domain claim "this account is a creator".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const U = {
  creator: "a1000000-0000-0000-0000-000000000001",
  editor: "a1000000-0000-0000-0000-000000000002",
  admin: "a1000000-0000-0000-0000-000000000003",
  /** Authenticated in Supabase but has no public.users row. */
  rowless: "a1000000-0000-0000-0000-000000000004",
} as const;

/** Shared state the module mocks read. Hoisted so the factories can see it. */
const state = vi.hoisted(() => ({
  user: null as { id: string; email: string | null; user_metadata?: unknown } | null,
  authError: null as { message: string } | null,
  /** Executes the `public.users` read. Defaults to the real database read. */
  read: null as null | ((userId: string) => Promise<{ data: unknown; error: unknown }>),
  redirects: [] as string[],
}));

class Redirected extends Error {
  constructor(public target: string) {
    super(`redirect:${target}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (target: string) => {
    state.redirects.push(target);
    throw new Redirected(target);
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: state.user },
        error: state.authError,
      }),
    },
    from: () => {
      let userId = "";
      const builder = {
        select: () => builder,
        eq: (_column: string, value: string) => {
          userId = value;
          return builder;
        },
        maybeSingle: async () => {
          if (!state.read) throw new Error("no read configured");
          return state.read(userId);
        },
      };
      return builder;
    },
  }),
}));

const { resolveSession, requireRole, requireUser, SessionUnavailableError } =
  await import("@/lib/auth/guards");

/** The production read, executed by the real `authenticated` role. */
function realRead(role: "authenticated" | "anon" = "authenticated") {
  return async (userId: string) => {
    const res = await queryAs<{ role: string; email: string | null }>(
      { role, sub: role === "anon" ? null : userId },
      "select role, email from public.users where id = $1",
      [userId],
    );
    if (res.error) return { data: null, error: res.error };
    return { data: res.rows[0] ?? null, error: null };
  };
}

function signIn(id: string, email = `${id}@test.local`, metadata?: unknown) {
  state.user = { id, email, ...(metadata === undefined ? {} : { user_metadata: metadata }) };
  state.authError = null;
}

d("session role resolution", () => {
  beforeAll(async () => {
    await setupDatabase();
    for (const id of Object.values(U)) {
      await adminQuery("insert into auth.users (id, email) values ($1, $2)", [
        id,
        `${id}@test.local`,
      ]);
    }
    await adminQuery("update public.users set role = 'editor' where id = $1", [U.editor]);
    await adminQuery("update public.users set role = 'admin' where id = $1", [U.admin]);
    // The rowless user is authenticated but has no application row.
    await adminQuery("delete from public.users where id = $1", [U.rowless]);
  }, 60_000);

  afterAll(async () => {
    await teardownDatabase();
  });

  beforeEach(() => {
    state.user = null;
    state.authError = null;
    state.read = realRead();
    state.redirects = [];
  });

  /* -------------------------------------------------------------- */
  /* Table ACL and RLS on public.users                                */
  /* -------------------------------------------------------------- */

  it("grants authenticated exactly SELECT and UPDATE on public.users", async () => {
    const [row] = await adminQuery<Record<string, boolean>>(
      `select
         has_table_privilege('authenticated','public.users','SELECT')   as sel,
         has_table_privilege('authenticated','public.users','UPDATE')   as upd,
         has_table_privilege('authenticated','public.users','INSERT')   as ins,
         has_table_privilege('authenticated','public.users','DELETE')   as del,
         has_table_privilege('authenticated','public.users','TRUNCATE') as trunc`,
    );
    expect(row).toEqual({ sel: true, upd: true, ins: false, del: false, trunc: false });
  });

  it("grants anon nothing at all on public.users", async () => {
    const [row] = await adminQuery<Record<string, boolean>>(
      `select
         has_table_privilege('anon','public.users','SELECT')   as sel,
         has_table_privilege('anon','public.users','UPDATE')   as upd,
         has_table_privilege('anon','public.users','INSERT')   as ins,
         has_table_privilege('anon','public.users','DELETE')   as del,
         has_table_privilege('anon','public.users','TRUNCATE') as trunc`,
    );
    expect(Object.values(row!).every((v) => v === false)).toBe(true);

    const denied = await queryAs({ role: "anon" }, "select id from public.users");
    expect(denied.error).not.toBeNull();
  });

  it("lets an authenticated user read only their own row", async () => {
    const own = await queryAs<{ id: string }>(
      { role: "authenticated", sub: U.admin },
      "select id from public.users",
    );
    expect(own.error).toBeNull();
    expect(own.rows.map((r) => r.id)).toEqual([U.admin]);

    const cross = await queryAs(
      { role: "authenticated", sub: U.creator },
      "select id, role from public.users where id = $1",
      [U.admin],
    );
    expect(cross.error).toBeNull();
    expect(cross.rows).toEqual([]);
  });

  it("rejects role and status escalation from the authenticated role", async () => {
    for (const sql of [
      "update public.users set role = 'admin' where id = $1",
      "update public.users set status = 'suspended' where id = $1",
    ]) {
      const res = await queryAs({ role: "authenticated", sub: U.creator }, sql, [U.creator]);
      expect(res.error).not.toBeNull();
      expect(res.error?.message).toMatch(/not authorized to change role\/status/);
    }

    const [row] = await adminQuery<{ role: string; status: string }>(
      "select role, status from public.users where id = $1",
      [U.creator],
    );
    expect(row).toEqual({ role: "creator", status: "active" });
  });

  /* -------------------------------------------------------------- */
  /* Resolution                                                       */
  /* -------------------------------------------------------------- */

  it("resolves each database role correctly", async () => {
    for (const [id, expected] of [
      [U.creator, "creator"],
      [U.editor, "editor"],
      [U.admin, "admin"],
    ] as const) {
      signIn(id);
      const resolution = await resolveSession();
      expect(resolution).toEqual({
        status: "authenticated",
        session: { userId: id, email: `${id}@test.local`, role: expected },
      });
    }
  });

  it("takes the role from the database, never from user_metadata", async () => {
    signIn(U.creator, `${U.creator}@test.local`, { role: "admin", app_role: "admin" });
    const resolution = await resolveSession();
    if (resolution.status !== "authenticated") throw new Error("unreachable");
    expect(resolution.session.role).toBe("creator");
  });

  it("reports no session when there is no Supabase user", async () => {
    state.user = null;
    expect(await resolveSession()).toEqual({ status: "anonymous" });
  });

  it("falls back to creator ONLY when the lookup succeeded and found no row", async () => {
    signIn(U.rowless);
    const resolution = await resolveSession();
    expect(resolution).toEqual({
      status: "authenticated",
      session: { userId: U.rowless, email: `${U.rowless}@test.local`, role: "creator" },
    });
  });

  /* -------------------------------------------------------------- */
  /* Technical failure is not a role                                  */
  /* -------------------------------------------------------------- */

  it("a permission failure is an error, NOT the creator role", async () => {
    signIn(U.admin);
    // Run the same read as `anon`, which holds no privilege on public.users.
    state.read = realRead("anon");
    const resolution = await resolveSession();
    expect(resolution).toEqual({ status: "error" });
    expect(resolution).not.toMatchObject({ status: "authenticated" });
  });

  it("a transport failure is an error, NOT the creator role", async () => {
    signIn(U.admin);
    state.read = async () => ({ data: null, error: { message: "fetch failed" } });
    expect(await resolveSession()).toEqual({ status: "error" });
  });

  it("an auth lookup failure is an error, NOT anonymous", async () => {
    state.user = null;
    state.authError = { message: "auth service unavailable" };
    expect(await resolveSession()).toEqual({ status: "error" });
  });

  it("a role the application does not model is an error, not a creator", async () => {
    signIn(U.creator);
    for (const role of ["moderator", "brand", "superuser", "", 7, {}]) {
      state.read = async () => ({ data: { role, email: "x@test.local" }, error: null });
      expect(await resolveSession()).toEqual({ status: "error" });
    }
  });

  it("never leaks the underlying database error", async () => {
    signIn(U.admin);
    state.read = async () => ({
      data: null,
      error: { code: "42501", message: "permission denied for table users", details: "raw" },
    });
    const resolution = await resolveSession();
    expect(resolution).toEqual({ status: "error" });
    expect(JSON.stringify(resolution)).not.toMatch(/permission denied|42501|raw/);
  });

  /* -------------------------------------------------------------- */
  /* Guards                                                           */
  /* -------------------------------------------------------------- */

  it("requireUser redirects an anonymous visitor to /login with intent", async () => {
    state.user = null;
    await expect(requireUser("/app/pipeline")).rejects.toBeInstanceOf(Redirected);
    expect(state.redirects).toEqual(["/login?redirect=%2Fapp%2Fpipeline"]);
  });

  it("requireUser raises a sanitized error on an unresolvable session", async () => {
    signIn(U.admin);
    state.read = realRead("anon");
    await expect(requireUser("/admin")).rejects.toBeInstanceOf(SessionUnavailableError);
    // Critically: it does NOT claim the user is signed out.
    expect(state.redirects).toEqual([]);
  });

  it("requireRole admits admin and editor", async () => {
    for (const id of [U.admin, U.editor]) {
      signIn(id);
      const ctx = await requireRole(["admin", "editor"], "/admin");
      expect(["admin", "editor"]).toContain(ctx.role);
      expect(state.redirects).toEqual([]);
    }
  });

  it("requireRole refuses a creator", async () => {
    signIn(U.creator);
    await expect(requireRole(["admin", "editor"], "/admin")).rejects.toBeInstanceOf(Redirected);
    expect(state.redirects).toEqual(["/app"]);
  });

  it("requireRole does not turn a lookup failure into 'you are not an admin'", async () => {
    signIn(U.admin);
    state.read = realRead("anon");
    await expect(requireRole(["admin", "editor"], "/admin")).rejects.toBeInstanceOf(
      SessionUnavailableError,
    );
    expect(state.redirects).toEqual([]);
  });
});
