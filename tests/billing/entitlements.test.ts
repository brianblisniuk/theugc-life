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

function shimClient(role: Role, sub: string | null): BillingQueryClient {
  const from = (table: string) => {
    const builder = {
      select: () => builder,
      order: () => builder,
      then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
        return queryAs(
          { role, sub },
          `select access_type, status, starts_at, expires_at
             from public.${table} order by starts_at desc`,
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
  }, 60_000);

  afterAll(async () => {
    await teardownDatabase();
  });

  const load = (userId: string | null, role: Role = "authenticated") =>
    loadBillingAccess(shimClient(role, userId));

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

  it("a permission failure is an error, NOT the Free plan", async () => {
    // `anon` holds no privilege on access_entitlements.
    const result = await load(null, "anon");
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
          order: () => builder,
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({ data: null, error: raw }).then(resolve),
        };
        return builder;
      },
    } as unknown as BillingQueryClient;

    const result: BillingAccessResult = await loadBillingAccess(client);
    expect(result).toEqual({ status: "error" });

    const rendered = JSON.stringify(billingAccessState(result));
    expect(rendered).not.toMatch(/42501|permission denied|raw driver detail|access_entitlements/);
  });
});
