/**
 * Function EXECUTE grant hardening (migration 0018).
 *
 * Hosted Supabase projects can grant EXECUTE directly to anon/authenticated via
 * default privileges, so 0010's `revoke ... from public` is not sufficient on
 * its own. 0018 additionally revokes from anon/authenticated and keeps
 * service_role. These tests assert the resulting privilege surface:
 *
 *  - private `_`-prefixed helpers: NOT executable by anon/authenticated;
 *  - those helpers ARE still executable by service_role;
 *  - `handle_new_user()` (trigger-only) is not exposed to anon/authenticated/PUBLIC;
 *  - the self-scoped public wrappers from 0010 remain callable as designed.
 *
 * Privileges are asserted via `has_function_privilege`, which is exactly what
 * PostgREST/RPC exposure depends on.
 */
import { describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);

/** Private core helpers (0010) — server/admin only. */
const PRIVATE_HELPERS = [
  "public._is_admin_or_editor(uuid)",
  "public._has_active_pro(uuid)",
  "public._destination_is_descendant(uuid, uuid)",
  "public._has_active_destination_access(uuid, uuid)",
  "public._has_premium_hotel_access(uuid, uuid)",
] as const;

/** Self-scoped wrappers (0010) — intentionally exposed to clients. */
const PUBLIC_WRAPPERS = [
  "public.current_user_role()",
  "public.current_creator_id()",
  "public.is_admin_or_editor()",
  "public.has_active_pro()",
  "public.has_active_destination_access(uuid)",
  "public.has_premium_hotel_access(uuid)",
] as const;

async function canExecute(role: string, signature: string): Promise<boolean> {
  const rows = await adminQuery<{ ok: boolean }>(
    "select has_function_privilege($1, $2, 'EXECUTE') as ok",
    [role, signature],
  );
  return rows[0]!.ok;
}

d("0018 — private helper functions are not client-executable", () => {
  it("anon has no EXECUTE on any private helper", async () => {
    await setupDatabase();
    for (const fn of PRIVATE_HELPERS) {
      expect(await canExecute("anon", fn), `anon should NOT execute ${fn}`).toBe(false);
    }
  });

  it("authenticated has no EXECUTE on any private helper", async () => {
    await setupDatabase();
    for (const fn of PRIVATE_HELPERS) {
      expect(await canExecute("authenticated", fn), `authenticated should NOT execute ${fn}`).toBe(
        false,
      );
    }
  });

  it("service_role retains EXECUTE on every private helper", async () => {
    await setupDatabase();
    for (const fn of PRIVATE_HELPERS) {
      expect(await canExecute("service_role", fn), `service_role SHOULD execute ${fn}`).toBe(true);
    }
  });

  it("a direct anon call to a private helper is rejected at runtime", async () => {
    await setupDatabase();
    const res = await queryAs(
      { role: "anon" },
      "select public._is_admin_or_editor('00000000-0000-0000-0000-000000000001'::uuid)",
    );
    expect(res.error).not.toBeNull();
    expect(res.error!.message).toMatch(/permission denied/i);
  });
});

d("0018 — handle_new_user() is trigger-only, never an RPC", () => {
  it("is not executable by anon, authenticated, or PUBLIC", async () => {
    await setupDatabase();
    expect(await canExecute("anon", "public.handle_new_user()")).toBe(false);
    expect(await canExecute("authenticated", "public.handle_new_user()")).toBe(false);

    // PUBLIC (pseudo-role 0) must not carry EXECUTE in the function's ACL.
    const rows = await adminQuery<{ public_exec: boolean }>(
      `select aclcontains(
                coalesce(p.proacl, acldefault('f', p.proowner)),
                makeaclitem(0::oid, p.proowner, 'EXECUTE', false)
              ) as public_exec
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'handle_new_user'`,
    );
    expect(rows[0]!.public_exec).toBe(false);
  });
});

d("0018 — 0010's intended client surface is preserved", () => {
  it("self-scoped wrappers remain executable by anon and authenticated", async () => {
    await setupDatabase();
    for (const fn of PUBLIC_WRAPPERS) {
      expect(await canExecute("anon", fn), `anon SHOULD execute ${fn}`).toBe(true);
      expect(await canExecute("authenticated", fn), `authenticated SHOULD execute ${fn}`).toBe(
        true,
      );
    }
  });

  it("an anon call to a self-scoped wrapper still succeeds", async () => {
    await setupDatabase();
    // No JWT → auth.uid() is null → wrapper returns false, but must not error.
    const res = await queryAs<{ ok: boolean }>(
      { role: "anon" },
      "select public.is_admin_or_editor() as ok",
    );
    expect(res.error).toBeNull();
    expect(res.rows[0]!.ok).toBe(false);
  });
});

d("0018 — mutable trigger helpers have a pinned search_path", () => {
  it("set_updated_at and prevent_user_privilege_change pin search_path", async () => {
    await setupDatabase();
    const rows = await adminQuery<{ proname: string; cfg: string | null }>(
      `select p.proname, array_to_string(p.proconfig, ',') as cfg
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('set_updated_at', 'prevent_user_privilege_change')
        order by p.proname`,
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.cfg, `${r.proname} should pin search_path`).toContain("search_path=public, pg_temp");
    }
  });
});
