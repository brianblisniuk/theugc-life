/**
 * The inventory is the only tier map. These checks do not need Postgres.
 * They fail if a route, a server action, or a written question drifts.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as authActions from "@/lib/auth/actions";
import * as collaborationActions from "@/lib/collaboration/actions";
import * as gmailActions from "@/lib/gmail/actions";
import * as inboxActions from "@/lib/inbox-pipeline/actions";
import * as pipelineActions from "@/lib/pipeline/actions";
import * as profileActions from "@/lib/profile/actions";
import * as tripActions from "@/lib/trips/actions";
import { FREE_LIMITS } from "@/lib/config";
import {
  coverageFromEntitlementRows,
  decideAccess,
  featureById,
  INVENTORY,
  isActiveEntitlementFact,
  questionsForBrian,
  serverActionIndex,
  workspaceLimit,
  type AccessContext,
  type EntitlementFact,
} from "@/lib/entitlements/inventory";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NOW = new Date("2026-10-12T12:00:00.000Z");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}

function exportedFunctions(mod: object): string[] {
  return Object.entries(mod)
    .filter(([, value]) => typeof value === "function")
    .map(([name]) => name);
}

function ctx(overrides: Partial<AccessContext> = {}): AccessContext {
  return {
    pro: false,
    destinationCovers: false,
    withinFreeLimit: true,
    owner: true,
    staff: false,
    ...overrides,
  };
}

function fact(overrides: Partial<EntitlementFact> = {}): EntitlementFact {
  return {
    accessType: "pro",
    status: "active",
    startsAt: "2026-10-01T00:00:00.000Z",
    expiresAt: null,
    destinationId: null,
    ...overrides,
  };
}

describe("entitlement inventory", () => {
  it("names every page and route, and every listed file exists", () => {
    const listed = new Set(INVENTORY.flatMap((entry) => entry.sourceFiles));
    for (const file of listed) {
      expect(statSync(path.join(ROOT, file)).isFile(), file).toBe(true);
    }

    const pages = walk(path.join(ROOT, "src/app"))
      .filter((abs) => abs.endsWith(`${path.sep}page.tsx`) || abs.endsWith(`${path.sep}route.ts`))
      .map((abs) => path.relative(ROOT, abs).split(path.sep).join("/"));

    const missing = pages.filter((file) => !listed.has(file));
    expect(missing).toEqual([]);
  });

  it("names every server action once", () => {
    const exported = [
      ...exportedFunctions(authActions),
      ...exportedFunctions(collaborationActions),
      ...exportedFunctions(gmailActions),
      ...exportedFunctions(inboxActions),
      ...exportedFunctions(pipelineActions),
      ...exportedFunctions(profileActions),
      ...exportedFunctions(tripActions),
    ].sort();
    const listed = [...serverActionIndex().keys()].sort();
    expect(listed).toEqual(exported);
  });

  it("keeps the doc in step with the module, including every UNDECIDED question", () => {
    const doc = readFileSync(path.join(ROOT, "docs/ENTITLEMENTS_INVENTORY.md"), "utf8");
    expect(doc).toContain("UNDECIDED");
    expect(doc).toContain("Contradictory gates fixed");
    expect(doc).toContain("0051_outside_free_allowance.sql");
    expect(doc).toContain("outside-coverage rows");
    for (const entry of INVENTORY) expect(doc).toContain(entry.id);
    const questions = questionsForBrian();
    expect(questions.length).toBeGreaterThan(0);
    for (const question of questions) {
      expect(question.question.length).toBeGreaterThan(20);
      expect(doc).toContain(question.question);
    }
  });

  it("reads workspace limits from FREE_LIMITS and nowhere else", () => {
    expect(workspaceLimit("pipeline.save")).toBe(FREE_LIMITS.savedHotels);
    expect(workspaceLimit("pipeline.engage")).toBe(FREE_LIMITS.activePipelineItems);
    expect(workspaceLimit("trips.active")).toBe(FREE_LIMITS.activeTrips);
    expect(featureById("pipeline.save").rule).toEqual({
      kind: "workspace_limited",
      limitKey: "savedHotels",
    });
  });

  it("treats missing, expired, revoked, pending, and future rows as Free, never Pro", () => {
    const cases: { name: string; rows: EntitlementFact[] }[] = [
      { name: "missing", rows: [] },
      { name: "expired", rows: [fact({ expiresAt: "2026-10-01T00:00:00.000Z" })] },
      { name: "revoked", rows: [fact({ status: "revoked" })] },
      { name: "pending", rows: [fact({ status: "pending" })] },
      { name: "not started", rows: [fact({ startsAt: "2026-12-01T00:00:00.000Z" })] },
      { name: "free type", rows: [fact({ accessType: "free" })] },
      { name: "unknown type", rows: [fact({ accessType: "purchase" })] },
    ];
    for (const item of cases) {
      const coverage = coverageFromEntitlementRows(item.rows, NOW, () => true);
      expect(coverage, item.name).toEqual({ pro: false, destinationCovers: false });
    }

    const active = fact();
    expect(isActiveEntitlementFact(active, NOW)).toBe(true);
    expect(coverageFromEntitlementRows([active], NOW, () => false)).toEqual({
      pro: true,
      destinationCovers: false,
    });
    expect(
      coverageFromEntitlementRows(
        [fact({ accessType: "destination", destinationId: "bali" })],
        NOW,
        (id) => id === "bali",
      ),
    ).toEqual({ pro: false, destinationCovers: true });
    expect(
      coverageFromEntitlementRows(
        [fact({ accessType: "destination", destinationId: "bali" })],
        NOW,
        () => false,
      ),
    ).toEqual({ pro: false, destinationCovers: false });
  });

  it("decides every written rule, and leaves UNDECIDED undecided even for Pro", () => {
    const table: { id: string; ctx: AccessContext; decision: "allow" | "deny" | "undecided" }[] =
      [];
    for (const entry of INVENTORY) {
      if (entry.rule.kind === "undecided") {
        table.push({
          id: entry.id,
          ctx: ctx({ pro: true, destinationCovers: true, owner: true, staff: true }),
          decision: "undecided",
        });
        continue;
      }
      if (entry.rule.kind === "all_tiers" || entry.rule.kind === "public_page") {
        table.push({ id: entry.id, ctx: ctx(), decision: "allow" });
        continue;
      }
      if (entry.rule.kind === "system_grant") {
        table.push({
          id: entry.id,
          ctx: ctx({ pro: true, staff: true, owner: true }),
          decision: "deny",
        });
        continue;
      }
      if (entry.rule.kind === "premium_scoped") {
        table.push({ id: entry.id, ctx: ctx(), decision: "deny" });
        table.push({ id: entry.id, ctx: ctx({ destinationCovers: true }), decision: "allow" });
        table.push({
          id: entry.id,
          ctx: ctx({ pro: true, destinationCovers: false }),
          decision: "allow",
        });
        continue;
      }
      if (entry.rule.kind === "workspace_limited") {
        table.push({ id: entry.id, ctx: ctx({ withinFreeLimit: true }), decision: "allow" });
        table.push({ id: entry.id, ctx: ctx({ withinFreeLimit: false }), decision: "deny" });
        table.push({
          id: entry.id,
          ctx: ctx({ withinFreeLimit: false, destinationCovers: true }),
          decision: "allow",
        });
        table.push({
          id: entry.id,
          ctx: ctx({ withinFreeLimit: false, pro: true }),
          decision: "allow",
        });
        continue;
      }
      if (entry.rule.kind === "owner_private") {
        table.push({ id: entry.id, ctx: ctx({ owner: true, pro: false }), decision: "allow" });
        table.push({ id: entry.id, ctx: ctx({ owner: false, pro: true }), decision: "deny" });
        continue;
      }
      if (entry.rule.kind === "staff_role") {
        table.push({ id: entry.id, ctx: ctx({ pro: true, staff: false }), decision: "deny" });
        table.push({ id: entry.id, ctx: ctx({ staff: true, pro: false }), decision: "allow" });
      }
    }

    const seen = new Set<string>();
    for (const row of table) {
      seen.add(row.id);
      expect(decideAccess(featureById(row.id), row.ctx), `${row.id}`).toBe(row.decision);
    }
    expect([...seen].sort()).toEqual(INVENTORY.map((entry) => entry.id).sort());
  });

  it("does not let a Pro context allow an UNDECIDED feature", () => {
    const undecided = INVENTORY.filter((entry) => entry.rule.kind === "undecided");
    expect(undecided.map((entry) => entry.id).sort()).toEqual([
      "account.settings",
      "auth.session",
      "gmail.connect",
      "gmail.sync",
      "home.dashboard",
      "onboarding.activation",
      "profile.basic_vs_full",
      "profile.field_opt_ins",
      "profile.past_collaborations",
      "profile.personal_analytics",
    ]);
    for (const entry of undecided) {
      expect(decideAccess(entry, ctx({ pro: true }))).toBe("undecided");
    }
  });
});
