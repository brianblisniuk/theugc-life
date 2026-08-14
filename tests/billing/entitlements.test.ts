/**
 * Billing & access: a failed entitlement read is not a Free plan (audit F-16).
 *
 * The page previously did `(entitlements ?? []).filter(...)` and rendered
 * "You're on the Free plan" whenever the result was empty — so a permission,
 * transport or database failure told a paying creator they had no access.
 *
 * The read half runs against real Postgres as the real `authenticated` role, so
 * `access_entitlements_select` decides which rows are visible; the decision half
 * is a pure function asserted directly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  adminQuery,
  hasTestDb,
  queryAs,
  setupDatabase,
  teardownDatabase,
  type Role,
} from "../db/harness";
import {
  loadBillingAccess,
  type BillingAccessResult,
  type BillingQueryClient,
  type Entitlement,
} from "@/lib/billing/queries";
import { BILLING_COPY, billingAccessState, shouldOfferUpgrade } from "@/lib/billing/view";

const d = describe.skipIf(!hasTestDb);

const NOW = new Date("2026-08-14T12:00:00.000Z");

function entitlement(overrides: Partial<Entitlement> = {}): Entitlement {
  return {
    accessType: "pro",
    status: "active",
    startsAt: "2026-08-01T00:00:00.000Z",
    expiresAt: null,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Decision                                                            */
/* ------------------------------------------------------------------ */

describe("billing access state", () => {
  it("a successful, empty read is the Free plan", () => {
    const state = billingAccessState({ status: "ok", entitlements: [] }, NOW);
    expect(state).toEqual({
      kind: "free",
      title: BILLING_COPY.freeTitle,
      body: BILLING_COPY.freeBody,
    });
    expect(shouldOfferUpgrade(state)).toBe(true);
  });

  it("an active Pro entitlement is premium access", () => {
    const state = billingAccessState(
      { status: "ok", entitlements: [entitlement({ accessType: "pro" })] },
      NOW,
    );
    expect(state.kind).toBe("premium");
    if (state.kind !== "premium") throw new Error("unreachable");
    expect(state.entitlements.map((e) => e.accessType)).toEqual(["pro"]);
  });

  it("an active Destination entitlement is premium access", () => {
    const state = billingAccessState(
      {
        status: "ok",
        entitlements: [
          entitlement({ accessType: "destination", expiresAt: "2026-12-01T00:00:00.000Z" }),
        ],
      },
      NOW,
    );
    expect(state.kind).toBe("premium");
  });

  it("a failed read is a neutral technical error, NEVER the Free plan", () => {
    const state = billingAccessState({ status: "error" }, NOW);
    expect(state).toEqual({
      kind: "error",
      title: BILLING_COPY.errorTitle,
      body: BILLING_COPY.errorBody,
    });

    const rendered = JSON.stringify(state);
    expect(rendered).not.toContain("Free plan");
    expect(rendered).not.toContain(BILLING_COPY.freeTitle);
    expect(state.kind).not.toBe("free");
    expect(state.kind).not.toBe("premium");
  });

  it("a failed read never offers an upgrade", () => {
    expect(shouldOfferUpgrade(billingAccessState({ status: "error" }, NOW))).toBe(false);
  });

  it("a failed read is not reported as expired or revoked", () => {
    const rendered = JSON.stringify(billingAccessState({ status: "error" }, NOW));
    expect(rendered).not.toMatch(/expired|revoked|cancell?ed|ended/i);
  });

  it("matches the database's definition of active access", () => {
    // status = 'active' and starts_at <= now() and (expires_at is null or
    // expires_at > now()) — migration 0010.
    const inactive: Entitlement[] = [
      entitlement({ status: "revoked" }),
      entitlement({ status: "cancelled" }),
      entitlement({ expiresAt: "2026-08-01T00:00:00.000Z" }), // expired
      entitlement({ startsAt: "2026-12-01T00:00:00.000Z" }), // not started
      entitlement({ startsAt: "not-a-date" }),
      entitlement({ expiresAt: "not-a-date" }),
    ];
    for (const e of inactive) {
      expect(billingAccessState({ status: "ok", entitlements: [e] }, NOW).kind).toBe("free");
    }
    // A cancelled Pro keeps access until expiry only while the row still says
    // active; a revoked row does not.
    expect(
      billingAccessState(
        { status: "ok", entitlements: [entitlement({ expiresAt: "2026-09-01T00:00:00.000Z" })] },
        NOW,
      ).kind,
    ).toBe("premium");
  });

  it("one active entitlement is enough, even beside inactive ones", () => {
    const state = billingAccessState(
      {
        status: "ok",
        entitlements: [entitlement({ status: "revoked" }), entitlement({ accessType: "pro" })],
      },
      NOW,
    );
    expect(state.kind).toBe("premium");
    if (state.kind !== "premium") throw new Error("unreachable");
    expect(state.entitlements).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

/**
 * A PostgREST-shaped client whose queries run as a real Postgres role with a
 * real JWT `sub`, so `access_entitlements_select` is genuinely evaluated. The
 * `.eq()` filters the production code applies are translated to SQL rather than
 * ignored — that is the whole point of these tests.
 */
function shimClient(role: Role, sub: string | null): BillingQueryClient {
  const from = (table: string) => {
    const eqs: [string, unknown][] = [];
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        eqs.push([column, value]);
        return builder;
      },
      order: () => builder,
      then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
        const where = eqs.map(([column], i) => `${column} = $${i + 1}`);
        const clause = where.length ? ` where ${where.join(" and ")}` : "";
        return queryAs(
          { role, sub },
          `select access_type, status, starts_at, expires_at
             from public.${table}${clause} order by starts_at desc`,
          eqs.map(([, value]) => value),
        )
          .then((res) =>
            res.error ? { data: null, error: res.error } : { data: res.rows, error: null },
          )
          .then(resolve, reject);
      },
    };
    return builder;
  };
  return { from } as unknown as BillingQueryClient;
}

d("billing access read", () => {
  const U = {
    pro: "c1000000-0000-0000-0000-000000000001",
    destination: "c1000000-0000-0000-0000-000000000002",
    free: "c1000000-0000-0000-0000-000000000003",
    expired: "c1000000-0000-0000-0000-000000000004",
    /** Staff with NO entitlement of their own. */
    admin: "c1000000-0000-0000-0000-000000000005",
    editor: "c1000000-0000-0000-0000-000000000006",
    /** Staff who DO hold their own Pro. */
    adminWithPro: "c1000000-0000-0000-0000-000000000007",
  } as const;
  const DEST = "c2000000-0000-0000-0000-000000000001";

  beforeAll(async () => {
    await setupDatabase();
    for (const id of Object.values(U)) {
      await adminQuery("insert into auth.users (id, email) values ($1, $2)", [
        id,
        `${id}@test.local`,
      ]);
    }
    await adminQuery(
      "insert into public.destinations (id, name, slug, type) values ($1,'Billville','billville','city')",
      [DEST],
    );
    await adminQuery(
      `insert into public.access_entitlements (user_id, access_type, status, starts_at)
         values ($1,'pro','active', now() - interval '1 day')`,
      [U.pro],
    );
    await adminQuery(
      `insert into public.access_entitlements (user_id, access_type, destination_id, status, starts_at, expires_at)
         values ($1,'destination',$2,'active', now() - interval '1 day', now() + interval '30 days')`,
      [U.destination, DEST],
    );
    await adminQuery(
      `insert into public.access_entitlements (user_id, access_type, status, starts_at, expires_at)
         values ($1,'pro','active', now() - interval '100 days', now() - interval '10 days')`,
      [U.expired],
    );

    await adminQuery("update public.users set role = 'admin' where id = any($1)", [
      [U.admin, U.adminWithPro],
    ]);
    await adminQuery("update public.users set role = 'editor' where id = $1", [U.editor]);
    await adminQuery(
      `insert into public.access_entitlements (user_id, access_type, status, starts_at)
         values ($1,'pro','active', now() - interval '2 days')`,
      [U.adminWithPro],
    );
  }, 60_000);

  afterAll(async () => {
    await teardownDatabase();
  });

  /**
   * Exactly what BillingPage does: the id scoping the question and the id
   * authenticating the request are the same server-session id.
   */
  const load = (userId: string, role: Role = "authenticated") =>
    loadBillingAccess(userId, shimClient(role, userId));

  it("reads the caller's own active Pro entitlement", async () => {
    const result = await load(U.pro);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.entitlements.map((e) => e.accessType)).toEqual(["pro"]);
    expect(billingAccessState(result).kind).toBe("premium");
  });

  it("reads the caller's own active Destination entitlement", async () => {
    const result = await load(U.destination);
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.entitlements.map((e) => e.accessType)).toEqual(["destination"]);
    expect(billingAccessState(result).kind).toBe("premium");
  });

  it("a creator with no entitlement row is genuinely Free", async () => {
    const result = await load(U.free);
    expect(result).toEqual({ status: "ok", entitlements: [] });
    expect(billingAccessState(result).kind).toBe("free");
  });

  it("an expired entitlement is Free, not premium and not an error", async () => {
    const result = await load(U.expired);
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.entitlements).toHaveLength(1);
    expect(billingAccessState(result).kind).toBe("free");
  });

  it("never exposes another user's entitlements", async () => {
    for (const [viewer, expected] of [
      [U.pro, ["pro"]],
      [U.destination, ["destination"]],
      [U.free, []],
    ] as const) {
      const result = await load(viewer);
      if (result.status !== "ok") throw new Error("unreachable");
      expect(result.entitlements.map((e) => e.accessType)).toEqual([...expected]);
    }
  });

  /* ---------------------------------------------------------------- */
  /* F-17 — self-service scope                                          */
  /* ---------------------------------------------------------------- */

  it("a creator cannot see another creator's entitlement", async () => {
    // Even asking for someone else's row explicitly returns nothing: RLS is the
    // second, independent layer.
    const asOtherCreator = await loadBillingAccess(
      U.pro,
      shimClient("authenticated", U.destination),
    );
    if (asOtherCreator.status !== "ok") throw new Error("unreachable");
    expect(asOtherCreator.entitlements).toEqual([]);
  });

  it("an admin with no entitlement of their own is Free, not premium", async () => {
    // The whole point of F-17: access_entitlements_select lets this admin READ
    // every row in the table, including U.pro's active Pro. The self-service
    // page must still say Free, because the admin has nothing.
    const result = await load(U.admin);
    expect(result).toEqual({ status: "ok", entitlements: [] });

    const state = billingAccessState(result);
    expect(state.kind).toBe("free");
    expect(state.kind).not.toBe("premium");
  });

  it("an editor with no entitlement of their own is Free, not premium", async () => {
    const result = await load(U.editor);
    expect(result).toEqual({ status: "ok", entitlements: [] });
    expect(billingAccessState(result).kind).toBe("free");
  });

  it("an admin who does hold Pro sees ONLY their own Pro", async () => {
    const result = await load(U.adminWithPro);
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.entitlements).toHaveLength(1);
    expect(result.entitlements.map((e) => e.accessType)).toEqual(["pro"]);
    expect(billingAccessState(result).kind).toBe("premium");

    // Not the other users' rows, which this admin is permitted to read.
    const everything = await queryAs<{ n: string }>(
      { role: "authenticated", sub: U.adminWithPro },
      "select count(*)::text as n from public.access_entitlements",
    );
    expect(Number(everything.rows[0]!.n)).toBeGreaterThan(result.entitlements.length);
  });

  it("still lets admin and editor read every entitlement in an explicit admin query", async () => {
    // The self-service predicate scopes ONE page. It must not have narrowed the
    // underlying authorization contract that reconciliation depends on.
    const total = await adminQuery<{ n: string }>(
      "select count(*)::text as n from public.access_entitlements",
    );

    for (const staff of [U.admin, U.editor, U.adminWithPro]) {
      const all = await queryAs<{ n: string }>(
        { role: "authenticated", sub: staff },
        "select count(*)::text as n from public.access_entitlements",
      );
      expect(all.error).toBeNull();
      expect(all.rows[0]!.n, staff).toBe(total[0]!.n);
    }

    // ...and a regular creator still cannot.
    const creator = await queryAs<{ n: string }>(
      { role: "authenticated", sub: U.free },
      "select count(*)::text as n from public.access_entitlements",
    );
    expect(creator.rows[0]!.n).toBe("0");
  });

  it("a permission failure is an error, NOT the Free plan", async () => {
    // `anon` holds no privilege on access_entitlements.
    const result = await loadBillingAccess(U.pro, shimClient("anon", null));
    expect(result).toEqual({ status: "error" });
    expect(billingAccessState(result).kind).toBe("error");
    expect(billingAccessState(result).kind).not.toBe("free");
  });

  it("never surfaces the raw database error", async () => {
    const raw = {
      code: "42501",
      message: "permission denied for table access_entitlements",
      details: "raw driver detail",
    };
    const client = {
      from: () => {
        const builder = {
          select: () => builder,
          eq: () => builder,
          order: () => builder,
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({ data: null, error: raw }).then(resolve),
        };
        return builder;
      },
    } as unknown as BillingQueryClient;

    const result: BillingAccessResult = await loadBillingAccess(U.pro, client);
    expect(result).toEqual({ status: "error" });

    const rendered = JSON.stringify(billingAccessState(result));
    expect(rendered).not.toMatch(/42501|permission denied|raw driver detail|access_entitlements/);
  });
});
