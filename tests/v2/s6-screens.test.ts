/**
 * V2-S6. Plans, billing activity, onboarding goals, and the collaboration
 * board. Failed reads are not zeros. Another creator's row is not shown.
 * Agreement does not approve a deliverable. Prices stay the config.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  commerceActivity,
  ledgerActivity,
  planAllowance,
  REFUND_RULES,
} from "@/lib/billing/activity";
import {
  AGREED_IS_NOT_APPROVED,
  assembleCollaborationBoard,
  compensationFamily,
  countApproved,
} from "@/lib/collaboration/board";
import { CREDITS_CONFIG, PLAN_PRICES } from "@/lib/credits/config";
import { onboardingGoalsAreInternal, ONBOARDING_GOALS } from "@/lib/onboarding/goals";
import { planCards } from "@/lib/plans/catalog";

const ROOT = process.cwd();
const CREATOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "11111111-1111-4111-8111-111111111111";
const HOTEL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const COLLAB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PIPE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DELIVERABLE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const USER = "ffffffff-ffff-4fff-8fff-ffffffffffff";

function source(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8");
}

function collaboration(overrides: Record<string, unknown> = {}) {
  return {
    id: COLLAB,
    creator_id: CREATOR,
    hotel_id: HOTEL,
    pipeline_item_id: PIPE,
    status: "agreed",
    collaboration_type: "stay",
    start_date: "2026-11-01",
    end_date: "2026-11-04",
    hotel: { id: HOTEL, name: "Recorded hotel" },
    ...overrides,
  };
}

function deliverable(overrides: Record<string, unknown> = {}) {
  return {
    id: DELIVERABLE,
    creator_id: CREATOR,
    collaboration_id: COLLAB,
    pipeline_item_id: PIPE,
    deliverable_type: "reel",
    quantity: 1,
    platform: "Instagram",
    due_on: "2026-11-17",
    status: "pending",
    proof_url: null,
    notes: null,
    ...overrides,
  };
}

describe("plan catalog", () => {
  it("prints config prices and does not start checkout", () => {
    const cards = planCards();
    expect(cards.map((card) => card.credits)).toEqual([
      CREDITS_CONFIG.freeWeeklyCredits,
      CREDITS_CONFIG.planMonthlyCredits.pro,
      CREDITS_CONFIG.planMonthlyCredits.max,
    ]);
    expect(cards[1]?.priceNote).toContain(String(PLAN_PRICES.pro.monthlyUsd));
    expect(cards[2]?.priceNote).toContain(String(PLAN_PRICES.max.monthlyUsd));
    expect(cards.every((card) => card.checkoutHref.startsWith("/app/billing"))).toBe(true);
    const page = source("src/app/(app)/app/plans/page.tsx");
    expect(page).toContain("PLAN_PRICES");
    expect(page).not.toContain("startRebillCheckoutAction");
    expect(page).not.toMatch(/147|price pending|Riverline|Lumphini/);
  });
});

describe("billing activity", () => {
  it("refuses another account and does not treat a refund as a spend", () => {
    const own = ledgerActivity(
      [
        {
          id: "1",
          user_id: USER,
          delta: -1,
          reason: "unlock",
          idempotency_key: "unlock:hotel",
          created_at: "2026-10-16T12:00:00.000Z",
        },
        {
          id: "2",
          user_id: USER,
          delta: -4,
          reason: "reversal",
          idempotency_key: "rebill_revoke:pay_1",
          created_at: "2026-10-16T13:00:00.000Z",
        },
      ],
      USER,
      2,
      50,
    );
    expect(own.kind).toBe("ok");
    if (own.kind !== "ok") return;
    expect(own.used).toBe(1);
    expect(own.movements[1]?.label).toBe("Credit reversal");
    expect(own.movements[1]?.label).not.toBe("Unused pack credits reversed");
    expect(
      ledgerActivity(
        [
          {
            id: "1",
            user_id: OTHER,
            delta: -1,
            reason: "unlock",
            idempotency_key: "unlock:hotel",
            created_at: "2026-10-16T12:00:00.000Z",
          },
        ],
        USER,
        1,
        50,
      ).kind,
    ).toBe("error");
    expect(ledgerActivity([], USER, null, 50).kind).toBe("error");
  });

  it("names a reversal from the payment and the pack grant, not the key prefix", () => {
    const at = "2026-10-16T13:00:00.000Z";
    function reversal(
      id: string,
      key: string,
      delta: number,
      purchase: {
        product_type: string;
        product_reference: string;
        status: string;
      } | null,
      packGrant: number | null,
    ) {
      const paymentId = key.slice(key.indexOf(":") + 1);
      const rows = [
        ...(packGrant === null
          ? []
          : [
              {
                id: `${id}-grant`,
                user_id: USER,
                delta: packGrant,
                reason: "pack_purchase",
                idempotency_key: `pack:${paymentId}`,
                created_at: "2026-10-01T00:00:00.000Z",
              },
            ]),
        {
          id,
          user_id: USER,
          delta,
          reason: "reversal",
          idempotency_key: key,
          created_at: at,
        },
      ];
      const purchases = purchase
        ? [
            {
              id: `purchase-${id}`,
              user_id: USER,
              provider_transaction_id: paymentId,
              product_type: purchase.product_type,
              product_reference: purchase.product_reference,
              status: purchase.status,
            },
          ]
        : [];
      const activity = ledgerActivity(rows, USER, rows.length, 50, purchases);
      expect(activity.kind).toBe("ok");
      if (activity.kind !== "ok") return "";
      return activity.movements.find((movement) => movement.id === id)?.label ?? "";
    }

    expect(
      reversal(
        "monthly",
        "rebill_revoke:pay_month",
        -20,
        {
          product_type: "plan",
          product_reference: "pro_monthly",
          status: "refunded",
        },
        null,
      ),
    ).toBe("Unused plan credits reversed for that payment");
    expect(
      reversal(
        "pack-cb",
        "rebill_revoke:pay_pack",
        -50,
        {
          product_type: "credit_pack",
          product_reference: "pack_50",
          status: "chargeback",
        },
        50,
      ),
    ).toBe("Pack credits reversed for a chargeback");
    expect(
      reversal(
        "pack-refund",
        "rebill_revoke:pay_pack_refund",
        -12,
        {
          product_type: "credit_pack",
          product_reference: "pack_50",
          status: "refunded",
        },
        50,
      ),
    ).toBe("Unused pack credits reversed");
    expect(
      reversal(
        "plan-cb",
        "rebill_revoke_plan:pay_cb",
        -150,
        {
          product_type: "plan",
          product_reference: "max_monthly",
          status: "chargeback",
        },
        null,
      ),
    ).toBe("Plan credits reversed for a chargeback");
    expect(
      reversal(
        "annual",
        "rebill_revoke_plan:pay_year",
        -400,
        {
          product_type: "plan",
          product_reference: "pro_annual",
          status: "refunded",
        },
        null,
      ),
    ).toBe("Unused plan credits reversed for a refunded annual payment");
    expect(reversal("bare-plan", "rebill_revoke_plan:pay_bare", -10, null, null)).toBe(
      "Credit reversal",
    );
    expect(
      ledgerActivity(
        [
          {
            id: "1",
            user_id: USER,
            delta: -50,
            reason: "reversal",
            idempotency_key: "rebill_revoke:pay_x",
            created_at: at,
          },
        ],
        USER,
        1,
        50,
        [
          {
            id: "p",
            user_id: OTHER,
            provider_transaction_id: "pay_x",
            product_type: "credit_pack",
            product_reference: "pack_50",
            status: "chargeback",
          },
        ],
      ).kind,
    ).toBe("error");
  });

  it("keeps a purchase from being access and states the D140 rules", () => {
    const commerce = commerceActivity(
      [],
      [
        {
          id: "p1",
          user_id: USER,
          product_type: "pack",
          product_reference: "pack_50",
          amount: 10,
          currency: "USD",
          status: "refunded",
          purchased_at: "2026-10-01T00:00:00.000Z",
          refunded_at: "2026-10-02T00:00:00.000Z",
          created_at: "2026-10-01T00:00:00.000Z",
        },
      ],
      USER,
    );
    expect(commerce.kind).toBe("ok");
    if (commerce.kind !== "ok") return;
    expect(commerce.records[0]?.status).toBe("refunded");
    expect(commerce.records[0]?.title).not.toMatch(/access|Pro|Max/);
    expect(REFUND_RULES.join(" ")).toMatch(/monthly Pro or Max/);
    expect(REFUND_RULES.join(" ")).toMatch(/does not go below zero/);
    expect(planAllowance(null)).toBeNull();
    expect(planAllowance("Free")?.credits).toBe(CREDITS_CONFIG.freeWeeklyCredits);
    expect(planAllowance("Pro")?.credits).toBe(CREDITS_CONFIG.planMonthlyCredits.pro);
    const page = source("src/app/(app)/app/billing/page.tsx");
    expect(page).toContain("startRebillCheckoutAction");
    expect(page).toContain("refreshOwnGrants");
    expect(page).toContain("PLAN_PRICES");
    expect(page).not.toMatch(/147|Example ledger|Preview/);
  });
});

describe("collaboration board", () => {
  it("keeps revision requested off the approved count and off the deadline", () => {
    const board = assembleCollaborationBoard({
      viewerId: CREATOR,
      failed: false,
      total: 1,
      collaborations: [collaboration()],
      deliverables: [
        deliverable({ status: "pending", due_on: "2026-11-17" }),
        deliverable({
          id: "abababab-abab-4aba-8aba-abababababab",
          status: "revision_requested",
          due_on: "2026-11-01",
        }),
      ],
      compensations: [
        {
          creator_id: CREATOR,
          collaboration_id: COLLAB,
          structure: "hybrid",
          cash_amount_minor: 15000,
          cash_currency: "USD",
          in_kind_description: "Three recorded nights",
          in_kind_estimate_minor: null,
          in_kind_estimate_currency: null,
          payment_status: "pending",
        },
      ],
      pipelineItems: [{ id: PIPE, creator_id: CREATOR, display_ref: "OP-1001" }],
      childFailed: false,
    });
    expect(board.kind).toBe("items");
    if (board.kind !== "items") return;
    expect(board.cards[0]?.approved).toBe(0);
    expect(board.cards[0]?.revisionRequested).toBe(1);
    expect(board.cards[0]?.nextDue).toBe("2026-11-17");
    expect(board.cards[0]?.displayRef).toBe("OP-1001");
    expect(board.cards[0]?.compensation?.family).toBe("both");
    expect(board.cards[0]?.compensation?.summary).not.toMatch(/^0/);
    expect(countApproved([{ status: "agreed" }, { status: "revision_requested" }])).toBe(0);
    expect(AGREED_IS_NOT_APPROVED).toMatch(/does not mean approved/i);
  });

  it("names barter and payment, and refuses another creator or a fake zero", () => {
    expect(compensationFamily("in_kind")).toBe("barter");
    expect(compensationFamily("paid")).toBe("payment");
    expect(compensationFamily("hybrid")).toBe("both");
    expect(compensationFamily("unknown")).toBeNull();
    const unknown = assembleCollaborationBoard({
      viewerId: CREATOR,
      failed: false,
      total: 1,
      collaborations: [collaboration()],
      deliverables: [],
      compensations: [
        {
          creator_id: CREATOR,
          collaboration_id: COLLAB,
          structure: "unknown",
          cash_amount_minor: null,
          cash_currency: null,
          in_kind_description: null,
          in_kind_estimate_minor: null,
          in_kind_estimate_currency: null,
          payment_status: "not_applicable",
        },
      ],
      pipelineItems: [{ id: PIPE, creator_id: CREATOR, display_ref: "OP-1001" }],
      childFailed: false,
    });
    expect(unknown.kind).toBe("items");
    if (unknown.kind === "items") {
      expect(unknown.cards[0]?.compensation?.summary).toBe("Unknown");
      expect(unknown.cards[0]?.compensation?.summary).not.toBe("0");
    }
    expect(
      assembleCollaborationBoard({
        viewerId: CREATOR,
        failed: false,
        total: 1,
        collaborations: [collaboration({ creator_id: OTHER })],
        deliverables: [],
        compensations: [],
        pipelineItems: [],
        childFailed: false,
      }).kind,
    ).toBe("error");
    const missing = assembleCollaborationBoard({
      viewerId: CREATOR,
      failed: false,
      total: 1,
      collaborations: [collaboration()],
      deliverables: [],
      compensations: [],
      pipelineItems: [],
      childFailed: false,
    });
    expect(missing.kind).toBe("items");
    if (missing.kind === "items") {
      expect(missing.cards[0]?.displayRef).toBeNull();
      expect(missing.cards[0]?.displayMissing).toBe(true);
    }
    const page = source("src/app/(app)/app/collaborations/page.tsx");
    expect(page).not.toMatch(/Contract Review|Lumphini|OP-1038/);
  });
});

describe("profile and getting started", () => {
  it("keeps goals on real routes and wires Gmail plus the 30-day deletion", () => {
    expect(onboardingGoalsAreInternal()).toBe(true);
    expect(ONBOARDING_GOALS.map((goal) => goal.href)).not.toContain("/app/contracts");
    const profile = source("src/app/(app)/app/profile/page.tsx");
    expect(profile).toContain("GmailConnectionPanel");
    expect(profile).toContain("30 days");
    expect(profile).toContain("DeleteAccountPanel");
    expect(profile).toContain("deletionReadable");
    expect(profile).not.toMatch(/12\.4k|follower count of/);
    const chips = source("src/components/onboarding/destination-question.tsx");
    expect(chips).toContain("aria-pressed");
    const board = source("src/lib/collaboration/board-queries.ts");
    expect(board).toContain('.order("created_at", { ascending: false })');
    expect(board).not.toContain("ascending: true");
    const onboarding = source("src/app/(app)/app/onboarding/page.tsx");
    expect(onboarding).toContain("Skip to Discover");
    expect(onboarding).toContain("ONBOARDING_GOALS");
    expect(onboarding).not.toMatch(/Lumphini|sample hotel/i);
  });
});
