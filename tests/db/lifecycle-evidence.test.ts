/**
 * Pre-publication lifecycle / closure evidence (migration 0031 + the evaluator).
 *
 * This layer answers ONE question — "does the latest complete provider evidence
 * contain a current property-level closure window, as of an explicit date?" —
 * and the suite is organised around the four ways that question gets corrupted:
 *
 *   1. `issueType = CLOSED` read as "the hotel is closed". The provider's own
 *      examples are facility-scoped, and eleven of the thirteen CLOSED rows in
 *      the real data are a water park, a restaurant, a spa or a car park. A
 *      generic type-only rule would have closed eleven operating hotels, so
 *      several tests exist purely to make such a rule fail.
 *   2. "no rows" read as "no issues". Absence of extraction is ignorance, and
 *      must never present as a clean bill of health.
 *   3. a long date range read as permanent closure. `2020-04-24 → 2039-12-31`
 *      is a range; it ends.
 *   4. the answer stored as a durable boolean. The outcome changes when the
 *      calendar moves and nobody said anything new, so it belongs to an
 *      evaluator holding an explicit date.
 *
 * All fixtures synthetic. No real provider data appears here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "./harness";
import { seed, USERS, DEST } from "../rls/seed";
import { extractIssuesFromRecord } from "../../scripts/lifecycle/extract";
import {
  coversDate,
  evaluateLifecycle,
  isValidIsoDate,
  LifecyclePolicyNotApprovedError,
  type IssueSnapshot,
  type LifecyclePolicy,
} from "../../scripts/lifecycle/policy";
import {
  loadEvaluableProperties,
  loadLifecyclePolicy,
  persistIssueEvidence,
} from "../../scripts/lifecycle/store";

const d = describe.skipIf(!hasTestDb);
const SOURCE = "hotelbeds";
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const POLICY_VERSION = "hotelbeds-lifecycle-issue/1";

let counter = 0;
const uniq = () => `L${Date.now().toString(36)}${(counter += 1)}`;

/** The approved policy, as the evaluator receives it. */
const APPROVED: LifecyclePolicy = {
  provider: SOURCE,
  version: POLICY_VERSION,
  approved: true,
  dateSemantics: "inclusive_day_interval",
  mappings: [{ issueCode: "HOTEL", issueType: "CLOSED", outcome: "property_closed_window" }],
};

interface IssueInput {
  issueCode: string;
  issueType: string;
  dateFrom?: string | null;
  dateTo?: string | null;
  providerOrder?: number | null;
  alternative?: boolean | null;
}

/** A complete snapshot carrying these issues. */
function snapshotOf(issues: IssueInput[]): IssueSnapshot {
  return {
    snapshotId: `snap-${uniq()}`,
    observationId: `obs-${uniq()}`,
    providerIssueCount: issues.length,
    issues: issues.map((i) => ({
      issueCode: i.issueCode,
      issueType: i.issueType,
      dateFrom: i.dateFrom ?? null,
      dateTo: i.dateTo ?? null,
      providerOrder: i.providerOrder ?? null,
      alternative: i.alternative ?? null,
    })),
  };
}

const outcomeOn = (issues: IssueInput[], asOf: string) =>
  evaluateLifecycle({ snapshot: snapshotOf(issues), policy: APPROVED, asOf }).outcome;

interface Fixture {
  identityId: string;
  observationId: string;
  sourcePropertyId: string;
}

async function newRun(destinationId: string | null = DEST.bali): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    `insert into public.source_runs (source, source_environment, destination_id, run_mode, started_at)
     values ($1, 'evaluation', $2, 'evaluation', now()) returning id`,
    [SOURCE, destinationId],
  );
  return rows[0]!.id;
}

/** One identity with one observation. */
async function property(name = `Lifecycle ${uniq()}`): Promise<Fixture> {
  const runId = await newRun();
  const sourcePropertyId = uniq();
  const identity = await adminQuery<{ id: string }>(
    `insert into public.source_property_identities
       (source, source_environment, source_property_id, first_seen_run_id, last_seen_run_id)
     values ($1,'evaluation',$2,$3,$3) returning id`,
    [SOURCE, sourcePropertyId, runId],
  );
  const identityId = identity[0]!.id;
  const observation = await adminQuery<{ id: string }>(
    `insert into public.source_property_observations
       (source_run_id, source_property_identity_id, source, source_environment, observed_at, source_name)
     values ($1,$2,$3,'evaluation', now(), $4) returning id`,
    [runId, identityId, SOURCE, name],
  );
  return { identityId, observationId: observation[0]!.id, sourcePropertyId };
}

/** A LATER observation for an existing identity. */
async function laterObservation(f: Fixture, name = `Later ${uniq()}`): Promise<string> {
  const runId = await newRun();
  const rows = await adminQuery<{ id: string }>(
    `insert into public.source_property_observations
       (source_run_id, source_property_identity_id, source, source_environment, observed_at, source_name)
     values ($1,$2,$3,'evaluation', now() + interval '1 second', $4) returning id`,
    [runId, f.identityId, SOURCE, name],
  );
  return rows[0]!.id;
}

/** A complete snapshot in the database, with its issue rows. */
async function persistSnapshot(
  f: Fixture,
  observationId: string,
  issues: IssueInput[],
): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    `insert into public.source_property_issue_snapshots
       (source_property_identity_id, source, source_environment, evidence_observation_id,
        extraction_status, provider_issue_count, extraction_method)
     values ($1,$2,'evaluation',$3,'complete',$4,'test') returning id`,
    [f.identityId, SOURCE, observationId, issues.length],
  );
  const snapshotId = rows[0]!.id;
  for (const issue of issues) {
    await adminQuery(
      `insert into public.source_property_issue_evidence
         (snapshot_id, source_property_identity_id, issue_code, issue_type, date_from, date_to,
          provider_order, alternative)
       values ($1,$2,$3,$4,$5::date,$6::date,$7,$8)`,
      [
        snapshotId,
        f.identityId,
        issue.issueCode,
        issue.issueType,
        issue.dateFrom ?? null,
        issue.dateTo ?? null,
        issue.providerOrder ?? null,
        issue.alternative ?? null,
      ],
    );
  }
  return snapshotId;
}

async function evaluateFromDb(f: Fixture, asOf: string) {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    const policy = (await loadLifecyclePolicy(client, { provider: SOURCE }))!;
    const properties = await loadEvaluableProperties(client, {
      source: SOURCE,
      environment: "evaluation",
    });
    const mine = properties.find((p) => p.identityId === f.identityId)!;
    return evaluateLifecycle({
      snapshot: mine.snapshot,
      policy,
      asOf,
      latestObservationId: mine.latestObservationId,
    });
  } finally {
    await client.end();
  }
}

d("pre-publication lifecycle evidence (0031)", () => {
  beforeAll(async () => {
    await setupDatabase();
    await seed();
  });
  afterAll(teardownDatabase);

  // -----------------------------------------------------------------------
  describe("completeness is a fact of its own", () => {
    it("1. a COMPLETE zero-issue snapshot is not the same as no extraction", async () => {
      const extracted = await property("Provider said nothing");
      await persistSnapshot(extracted, extracted.observationId, []);
      const missing = await property("Nobody looked");

      const withSnapshot = await evaluateFromDb(extracted, "2026-08-17");
      expect(withSnapshot.outcome).toBe("no_known_closure");
      expect(withSnapshot.snapshotId).not.toBeNull();

      const withoutSnapshot = await evaluateFromDb(missing, "2026-08-17");
      expect(withoutSnapshot.outcome).toBe("unresolved");
      expect(withoutSnapshot.unresolvedReasons).toContain("no_complete_issue_snapshot");

      // The distinction is visible in the data, not only in the outcome.
      const rows = await adminQuery<{ n: string }>(
        `select count(*)::text n from public.source_property_issue_snapshots
          where source_property_identity_id = $1`,
        [missing.identityId],
      );
      expect(rows[0]!.n).toBe("0");
    });

    it("2. issue rows cite the identity and observation they belong to", async () => {
      const f = await property();
      const snapshotId = await persistSnapshot(f, f.observationId, [
        { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: "2026-12-31" },
      ]);
      const rows = await adminQuery<{
        evidence_observation_id: string;
        source_property_identity_id: string;
      }>(
        `select s.evidence_observation_id, e.source_property_identity_id
           from public.source_property_issue_evidence e
           join public.source_property_issue_snapshots s on s.id = e.snapshot_id
          where e.snapshot_id = $1`,
        [snapshotId],
      );
      expect(rows[0]!.evidence_observation_id).toBe(f.observationId);
      expect(rows[0]!.source_property_identity_id).toBe(f.identityId);
    });

    it("a snapshot cannot cite another property's observation", async () => {
      const a = await property();
      const b = await property();
      await expect(
        adminQuery(
          `insert into public.source_property_issue_snapshots
             (source_property_identity_id, source, source_environment, evidence_observation_id,
              provider_issue_count, extraction_method)
           values ($1,$2,'evaluation',$3,0,'test')`,
          [a.identityId, SOURCE, b.observationId],
        ),
      ).rejects.toThrow(/foreign key|violates/i);
    });

    it("an issue row cannot attach to another identity's snapshot", async () => {
      const a = await property();
      const b = await property();
      const snapshotId = await persistSnapshot(a, a.observationId, []);
      await expect(
        adminQuery(
          `insert into public.source_property_issue_evidence
             (snapshot_id, source_property_identity_id, issue_code, issue_type)
           values ($1,$2,'HOTEL','CLOSED')`,
          [snapshotId, b.identityId],
        ),
      ).rejects.toThrow(/foreign key|violates/i);
    });

    it("one observation cannot acquire a second complete extraction", async () => {
      const f = await property();
      await persistSnapshot(f, f.observationId, []);
      await expect(persistSnapshot(f, f.observationId, [])).rejects.toThrow(/unique|duplicate/i);
    });
  });

  // -----------------------------------------------------------------------
  describe("3. evidence is append-only", () => {
    it("a snapshot cannot be updated or deleted", async () => {
      const f = await property();
      const snapshotId = await persistSnapshot(f, f.observationId, []);
      await expect(
        adminQuery(
          "update public.source_property_issue_snapshots set provider_issue_count = 9 where id = $1",
          [snapshotId],
        ),
      ).rejects.toThrow(/APPEND-ONLY/i);
      await expect(
        adminQuery("delete from public.source_property_issue_snapshots where id = $1", [
          snapshotId,
        ]),
      ).rejects.toThrow(/APPEND-ONLY/i);
    });

    it("an issue row cannot be updated or deleted", async () => {
      const f = await property();
      await persistSnapshot(f, f.observationId, [
        { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: "2026-02-01" },
      ]);
      const rows = await adminQuery<{ id: string }>(
        `select e.id from public.source_property_issue_evidence e
          where e.source_property_identity_id = $1`,
        [f.identityId],
      );
      const id = rows[0]!.id;
      await expect(
        adminQuery(
          "update public.source_property_issue_evidence set issue_code = 'SPA' where id = $1",
          [id],
        ),
      ).rejects.toThrow(/APPEND-ONLY/i);
      await expect(
        adminQuery("delete from public.source_property_issue_evidence where id = $1", [id]),
      ).rejects.toThrow(/APPEND-ONLY/i);
    });
  });

  // -----------------------------------------------------------------------
  describe("the provider policy is reviewed data, and freezes", () => {
    it("4. a DRAFT policy may not decide anything", () => {
      const draft: LifecyclePolicy = { ...APPROVED, version: "draft/0", approved: false };
      expect(() =>
        evaluateLifecycle({ snapshot: snapshotOf([]), policy: draft, asOf: "2026-08-17" }),
      ).toThrow(LifecyclePolicyNotApprovedError);
    });

    it("5. an APPROVED policy and its mappings are immutable", async () => {
      await expect(
        adminQuery(
          `update public.provider_lifecycle_issue_policies set notes = 'edited'
            where provider = $1 and version = $2`,
          [SOURCE, POLICY_VERSION],
        ),
      ).rejects.toThrow(/IMMUTABLE/i);

      await expect(
        adminQuery(
          `update public.provider_lifecycle_issue_policy_mappings set outcome = 'property_closed_window'
            where provider = $1 and version = $2 and issue_code = 'HOTEL'`,
          [SOURCE, POLICY_VERSION],
        ),
      ).rejects.toThrow(/IMMUTABLE/i);

      await expect(
        adminQuery(
          `delete from public.provider_lifecycle_issue_policy_mappings
            where provider = $1 and version = $2 and issue_code = 'HOTEL'`,
          [SOURCE, POLICY_VERSION],
        ),
      ).rejects.toThrow(/IMMUTABLE/i);

      // And it cannot GAIN a mapping after the fact, which would extend a frozen
      // policy by a different route.
      await expect(
        adminQuery(
          `insert into public.provider_lifecycle_issue_policy_mappings
             (provider, version, issue_code_field, issue_type_field, issue_code, issue_type, outcome)
           values ($1,$2,'issueCode','issueType','SPA','CLOSED','property_closed_window')`,
          [SOURCE, POLICY_VERSION],
        ),
      ).rejects.toThrow(/IMMUTABLE|cannot gain/i);
    });

    it("6. HOTEL + CLOSED is the approved property-level mapping", async () => {
      const rows = await adminQuery<{ issue_code: string; issue_type: string; outcome: string }>(
        `select issue_code, issue_type, outcome
           from public.provider_lifecycle_issue_policy_mappings
          where provider = $1 and version = $2`,
        [SOURCE, POLICY_VERSION],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        issue_code: "HOTEL",
        issue_type: "CLOSED",
        outcome: "property_closed_window",
      });
    });

    it("nothing may ever map to an 'open' or 'active' outcome", async () => {
      // There is no such outcome in the domain, by design: no provider issue is
      // evidence that a hotel is OPERATING.
      for (const outcome of ["open", "active", "operating", "facility_closed"]) {
        await expect(
          adminQuery(
            `insert into public.provider_lifecycle_issue_policy_mappings
               (provider, version, issue_code_field, issue_type_field, issue_code, issue_type, outcome)
             values ($1,'draft-x','issueCode','issueType','HOTEL','OPEN',$2)`,
            [SOURCE, outcome],
          ),
        ).rejects.toThrow();
      }
    });
  });

  // -----------------------------------------------------------------------
  // The rule the whole layer exists to protect. Each of these would be
  // KNOWN_CLOSED under a generic `issueType = CLOSED` rule, and each is a real
  // code from the cached Bali/Dubai evidence.
  describe("a FACILITY closure is not a property closure", () => {
    const inRange = { dateFrom: "2026-01-01", dateTo: "2026-12-31" };

    for (const [n, code] of [
      [7, "OUTDOORPOOL"],
      [8, "SPA"],
      [9, "RESTAURANT"],
      [10, "WATERPARK"],
      [11, "PARKING"],
    ] as const) {
      it(`${n}. ${code} + CLOSED does NOT close the property`, () => {
        expect(
          outcomeOn([{ issueCode: code, issueType: "CLOSED", ...inRange }], "2026-08-17"),
        ).toBe("no_known_closure");
      });
    }

    it("all five together still do not close the property", () => {
      const issues = ["OUTDOORPOOL", "SPA", "RESTAURANT", "WATERPARK", "PARKING"].map((c) => ({
        issueCode: c,
        issueType: "CLOSED",
        ...inRange,
      }));
      expect(outcomeOn(issues, "2026-08-17")).toBe("no_known_closure");
    });

    it("a facility closure with MALFORMED dates does not make the property unresolved", () => {
      // It carries no lifecycle meaning, so it has nothing to be defective about.
      const evaluation = evaluateLifecycle({
        snapshot: snapshotOf([
          { issueCode: "WATERPARK", issueType: "CLOSED", dateFrom: null, dateTo: null },
          { issueCode: "SPA", issueType: "CLOSED", dateFrom: "2026-12-31", dateTo: "2026-01-01" },
        ]),
        policy: APPROVED,
        asOf: "2026-08-17",
      });
      expect(evaluation.outcome).toBe("no_known_closure");
      expect(evaluation.unresolvedReasons).toHaveLength(0);
    });

    it("no source file contains a type-only closure rule", () => {
      // A structural check. If someone later writes `issueType === 'CLOSED'`
      // without pairing it to a code, this fails — which is the point.
      for (const file of ["policy.ts", "extract.ts", "store.ts", "lifecycle.ts"]) {
        const code = readFileSync(
          path.join(REPO_ROOT, "scripts", "lifecycle", file),
          "utf8",
        ).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
        expect(code, `${file} tests issueType against CLOSED directly`).not.toMatch(
          /issueType\s*(===?|==)\s*["'`]CLOSED["'`]/,
        );
        expect(code, `${file} filters on a bare CLOSED literal`).not.toMatch(
          /["'`]CLOSED["'`]\s*(===?|==)\s*\w*[Ii]ssueType/,
        );
      }
    });
  });

  // -----------------------------------------------------------------------
  describe("the date decides, and the date is explicit", () => {
    const dubai = [
      { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-05-31", dateTo: "2026-08-31" },
    ];

    it("12. a valid ACTIVE closure is KNOWN_CLOSED", () => {
      expect(outcomeOn(dubai, "2026-07-01")).toBe("known_closed");
    });

    it("13. a valid EXPIRED closure is NO_KNOWN_CLOSURE", () => {
      expect(outcomeOn(dubai, "2026-12-01")).toBe("no_known_closure");
    });

    it("14. a valid FUTURE closure is NO_KNOWN_CLOSURE before it starts", () => {
      expect(outcomeOn(dubai, "2026-01-15")).toBe("no_known_closure");
    });

    it("15. dateFrom is INSIDE the window", () => {
      expect(outcomeOn(dubai, "2026-05-30")).toBe("no_known_closure");
      expect(outcomeOn(dubai, "2026-05-31")).toBe("known_closed");
    });

    it("16. dateTo is INSIDE the window", () => {
      expect(outcomeOn(dubai, "2026-08-31")).toBe("known_closed");
    });

    it("17. the day after dateTo is OUTSIDE", () => {
      expect(outcomeOn(dubai, "2026-09-01")).toBe("no_known_closure");
    });

    it("27. the as-of date alone changes the answer, with identical evidence", () => {
      const snapshot = snapshotOf(dubai);
      const on = evaluateLifecycle({ snapshot, policy: APPROVED, asOf: "2026-08-17" });
      const off = evaluateLifecycle({ snapshot, policy: APPROVED, asOf: "2026-09-01" });
      expect(on.outcome).toBe("known_closed");
      expect(off.outcome).toBe("no_known_closure");
      // Same snapshot object, same policy — only the date moved. This is why
      // the outcome is not a stored column.
      expect(on.snapshotId).toBe(off.snapshotId);
    });

    it("refuses an as-of date that is not a real day", () => {
      for (const bad of ["2026-02-31", "2026-13-01", "17-08-2026", "2026-8-1", "", "today"]) {
        expect(() =>
          evaluateLifecycle({ snapshot: snapshotOf([]), policy: APPROVED, asOf: bad }),
        ).toThrow(/real YYYY-MM-DD/);
      }
      expect(isValidIsoDate("2026-02-28")).toBe(true);
      expect(isValidIsoDate("2024-02-29")).toBe(true);
      expect(isValidIsoDate("2026-02-29")).toBe(false);
    });

    it("28. no lifecycle decision code reads a clock", () => {
      for (const file of ["policy.ts", "store.ts"]) {
        const code = readFileSync(
          path.join(REPO_ROOT, "scripts", "lifecycle", file),
          "utf8",
        ).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
        expect(code, `${file} reads the system clock`).not.toMatch(/Date\.now\(\)|new Date\(\)/);
        expect(code, `${file} uses a database clock in a decision`).not.toMatch(
          /current_date|current_timestamp/i,
        );
      }
      // `now()` is permitted ONLY as a row-insertion timestamp default, never in
      // a comparison — the evaluator file must not contain it at all.
      const policySource = readFileSync(
        path.join(REPO_ROOT, "scripts", "lifecycle", "policy.ts"),
        "utf8",
      ).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(policySource).not.toMatch(/\bnow\(\)/);
    });

    it("coversDate is inclusive at both ends", () => {
      const w = { from: "2026-05-31", to: "2026-08-31" };
      expect(coversDate(w, "2026-05-31")).toBe(true);
      expect(coversDate(w, "2026-08-31")).toBe(true);
      expect(coversDate(w, "2026-05-30")).toBe(false);
      expect(coversDate(w, "2026-09-01")).toBe(false);
      // A single-day closure is a real window.
      expect(coversDate({ from: "2026-06-01", to: "2026-06-01" }, "2026-06-01")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  describe("18. malformed MAPPED closure evidence is UNRESOLVED, never clean", () => {
    const cases: [string, IssueInput, string][] = [
      [
        "missing dateFrom",
        { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: null, dateTo: "2026-12-31" },
        "mapped_closure_missing_date_from",
      ],
      [
        "missing dateTo",
        { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: null },
        "mapped_closure_missing_date_to",
      ],
      [
        "impossible date",
        { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-02-31", dateTo: "2026-12-31" },
        "mapped_closure_missing_date_from",
      ],
      [
        "inverted range",
        { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-12-31", dateTo: "2026-01-01" },
        "mapped_closure_inverted_range",
      ],
    ];

    for (const [label, issue, reason] of cases) {
      it(`${label} -> unresolved, with the reason surfaced`, () => {
        const evaluation = evaluateLifecycle({
          snapshot: snapshotOf([issue]),
          policy: APPROVED,
          asOf: "2026-08-17",
        });
        expect(evaluation.outcome).toBe("unresolved");
        expect(evaluation.unresolvedReasons).toContain(reason);
        // The defective evidence is preserved for a reviewer, not discarded.
        expect(evaluation.mappedWindows).toHaveLength(1);
      });
    }

    it("a malformed closure alongside a valid ACTIVE one is still unresolved", () => {
      // Deliberate: we cannot claim to know the closure picture while part of it
      // is unreadable, even though one window would already have answered.
      expect(
        outcomeOn(
          [
            {
              issueCode: "HOTEL",
              issueType: "CLOSED",
              dateFrom: "2026-01-01",
              dateTo: "2026-12-31",
            },
            { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: null, dateTo: null },
          ],
          "2026-08-17",
        ),
      ).toBe("unresolved");
    });

    it("a malformed range is still STORED — the defect must survive", async () => {
      const f = await property();
      await persistSnapshot(f, f.observationId, [
        { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: null, dateTo: null },
      ]);
      const rows = await adminQuery<{ date_from: string | null; date_to: string | null }>(
        `select date_from, date_to from public.source_property_issue_evidence
          where source_property_identity_id = $1`,
        [f.identityId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.date_from).toBeNull();
      const evaluation = await evaluateFromDb(f, "2026-08-17");
      expect(evaluation.outcome).toBe("unresolved");
    });
  });

  // -----------------------------------------------------------------------
  describe("currentness belongs to the LATEST observation", () => {
    it("19. a lifted closure does NOT survive in a historical snapshot", async () => {
      const f = await property("Reopened");
      await persistSnapshot(f, f.observationId, [
        { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: "2026-12-31" },
      ]);
      expect((await evaluateFromDb(f, "2026-08-17")).outcome).toBe("known_closed");

      // A newer observation with a COMPLETE snapshot and no closure.
      const newer = await laterObservation(f, "Reopened v2");
      await persistSnapshot(f, newer, []);

      const evaluation = await evaluateFromDb(f, "2026-08-17");
      expect(evaluation.outcome).toBe("no_known_closure");
      expect(evaluation.observationId).toBe(newer);
      // The old evidence is not deleted — it is simply not current.
      const historical = await adminQuery<{ n: string }>(
        `select count(*)::text n from public.source_property_issue_evidence
          where source_property_identity_id = $1 and issue_code = 'HOTEL'`,
        [f.identityId],
      );
      expect(historical[0]!.n).toBe("1");
    });

    it("20. a latest observation with NO snapshot does not fall back to an older one", async () => {
      const f = await property("Stale evidence");
      await persistSnapshot(f, f.observationId, []);
      expect((await evaluateFromDb(f, "2026-08-17")).outcome).toBe("no_known_closure");

      // Newer observation, nobody extracted it.
      const newer = await laterObservation(f, "Unextracted");
      const evaluation = await evaluateFromDb(f, "2026-08-17");
      expect(evaluation.outcome).toBe("unresolved");
      expect(evaluation.unresolvedReasons).toContain("no_complete_issue_snapshot");
      expect(evaluation.observationId).toBe(newer);
    });

    it("a stale CLOSURE likewise does not carry forward into an unextracted present", async () => {
      const f = await property("Was closed, now unknown");
      await persistSnapshot(f, f.observationId, [
        { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: "2026-12-31" },
      ]);
      await laterObservation(f, "Unextracted");
      expect((await evaluateFromDb(f, "2026-08-17")).outcome).toBe("unresolved");
    });
  });

  // -----------------------------------------------------------------------
  describe("21/22. multiple windows, and what a long range is not", () => {
    const two = [
      { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: "2026-03-31" },
      { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-07-01", dateTo: "2026-09-30" },
    ];

    it("21. ANY covering interval closes the property", () => {
      expect(outcomeOn(two, "2026-02-15")).toBe("known_closed");
      expect(outcomeOn(two, "2026-08-17")).toBe("known_closed");
    });

    it("a gap between two valid intervals is NO_KNOWN_CLOSURE", () => {
      expect(outcomeOn(two, "2026-05-01")).toBe("no_known_closure");
    });

    it("only the covering windows are reported, not all of them", () => {
      const evaluation = evaluateLifecycle({
        snapshot: snapshotOf(two),
        policy: APPROVED,
        asOf: "2026-08-17",
      });
      expect(evaluation.activeClosureWindows).toHaveLength(1);
      expect(evaluation.activeClosureWindows[0]!.dateFrom).toBe("2026-07-01");
      expect(evaluation.mappedWindows).toHaveLength(2);
    });

    it("22. a nineteen-year range is a RANGE, and it ends", () => {
      // The real Bali row. Inside it the outcome is `known_closed` — the same
      // word a three-month window earns, with no separate ontology — and after
      // dateTo it is not closed at all, which permanence would forbid.
      const long = [
        { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2020-04-24", dateTo: "2039-12-31" },
      ];
      expect(outcomeOn(long, "2026-08-17")).toBe("known_closed");
      expect(outcomeOn(long, "2039-12-31")).toBe("known_closed");
      expect(outcomeOn(long, "2040-01-01")).toBe("no_known_closure");
      expect(outcomeOn(long, "2020-04-23")).toBe("no_known_closure");
    });

    it("no code anywhere infers permanence from a distant end date", () => {
      for (const file of ["policy.ts", "extract.ts", "store.ts", "lifecycle.ts"]) {
        const code = readFileSync(path.join(REPO_ROOT, "scripts", "lifecycle", file), "utf8");
        expect(code.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")).not.toMatch(
          /permanently_closed|permanent_closure|inactive_forever|final_exclusion/,
        );
      }
    });
  });

  // -----------------------------------------------------------------------
  describe("23/24. nothing canonical is touched", () => {
    it("no lifecycle source file writes hotels or active_status", () => {
      for (const file of ["policy.ts", "extract.ts", "store.ts", "lifecycle.ts"]) {
        const code = readFileSync(
          path.join(REPO_ROOT, "scripts", "lifecycle", file),
          "utf8",
        ).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
        expect(code, `${file} writes active_status`).not.toMatch(/active_status/);
        expect(code, `${file} writes hotels`).not.toMatch(
          /\b(insert\s+into|update|delete\s+from)\s+public\.hotels/i,
        );
        expect(code, `${file} touches canonical links`).not.toMatch(/hotel_source_identities/);
        expect(code, `${file} touches resolution_state`).not.toMatch(/resolution_state/);
        expect(code, `${file} touches promoted_hotel_id`).not.toMatch(/promoted_hotel_id/);
      }
    });

    it("24. running extraction and evaluation creates no canonical rows", async () => {
      const before = await adminQuery<{ hotels: string; links: string; reviews: string }>(
        `select (select count(*)::text from public.hotels) as hotels,
                (select count(*)::text from public.hotel_source_identities) as links,
                (select count(*)::text from public.source_property_reviews) as reviews`,
      );
      const f = await property();
      await persistSnapshot(f, f.observationId, [
        { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: "2026-12-31" },
      ]);
      await evaluateFromDb(f, "2026-08-17");
      const after = await adminQuery<{ hotels: string; links: string; reviews: string }>(
        `select (select count(*)::text from public.hotels) as hotels,
                (select count(*)::text from public.hotel_source_identities) as links,
                (select count(*)::text from public.source_property_reviews) as reviews`,
      );
      expect(after[0]).toEqual(before[0]);

      // And the identity is still exactly where it was.
      const identity = await adminQuery<{ state: string; promoted: string | null }>(
        `select resolution_state as state, promoted_hotel_id::text as promoted
           from public.source_property_identities where id = $1`,
        [f.identityId],
      );
      expect(identity[0]!.state).toBe("unresolved");
      expect(identity[0]!.promoted).toBeNull();
    });

    it("source_lifecycle_status is neither read nor written by this layer", async () => {
      for (const file of ["policy.ts", "extract.ts", "store.ts", "lifecycle.ts"]) {
        const code = readFileSync(path.join(REPO_ROOT, "scripts", "lifecycle", file), "utf8");
        expect(code.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")).not.toMatch(
          /source_lifecycle_status/,
        );
      }
      const f = await property();
      await persistSnapshot(f, f.observationId, []);
      const rows = await adminQuery<{ v: string | null }>(
        `select source_lifecycle_status as v from public.source_property_observations where id = $1`,
        [f.observationId],
      );
      // Absence of issues must never be laundered into "lifecycle = active".
      expect(rows[0]!.v).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  describe("25. lifecycle evidence is staff-only", () => {
    for (const table of [
      "provider_lifecycle_issue_policies",
      "provider_lifecycle_issue_policy_mappings",
      "source_property_issue_snapshots",
      "source_property_issue_evidence",
    ]) {
      it(`an ordinary creator reads zero rows from ${table}`, async () => {
        const f = await property();
        await persistSnapshot(f, f.observationId, [
          { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: "2026-12-31" },
        ]);
        const result = await queryAs(
          { role: "authenticated", sub: USERS.free },
          `select * from public.${table}`,
        );
        // Either RLS returns nothing, or the grant refuses outright. Both are
        // "an ordinary creator sees none of this"; neither may return a row.
        expect(result.rows).toHaveLength(0);
      });

      it(`anon has no privilege on ${table}`, async () => {
        const grants = await adminQuery<{ n: string }>(
          `select count(*)::text n from information_schema.role_table_grants
            where table_schema = 'public' and table_name = $1 and grantee = 'anon'`,
          [table],
        );
        expect(grants[0]!.n).toBe("0");
      });

      it(`${table} has RLS enabled`, async () => {
        const rows = await adminQuery<{ relrowsecurity: boolean }>(
          `select relrowsecurity from pg_class where relname = $1 and relnamespace = 'public'::regnamespace`,
          [table],
        );
        expect(rows[0]!.relrowsecurity).toBe(true);
      });
    }

    it("an editor CAN read the evidence", async () => {
      const f = await property();
      await persistSnapshot(f, f.observationId, []);
      const result = await queryAs(
        { role: "authenticated", sub: USERS.editor },
        "select * from public.source_property_issue_snapshots",
      );
      expect(result.error).toBeNull();
      expect(result.rows.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  describe("26. extraction is idempotent, and reads only cached bytes", () => {
    it("a replay creates no duplicate snapshot and no duplicate issue", async () => {
      const f = await property();
      const extracted = [
        {
          sourcePropertyId: f.sourcePropertyId,
          providerIssueCount: 2,
          payloadDigest: "digest-1",
          issues: [
            {
              issueCode: "HOTEL",
              issueType: "CLOSED",
              dateFrom: "2026-01-01",
              dateTo: "2026-12-31",
              providerOrder: 1,
              alternative: false,
              description: null,
            },
            {
              issueCode: "SPA",
              issueType: "CLOSED",
              dateFrom: "2026-02-01",
              dateTo: "2026-03-01",
              providerOrder: 2,
              alternative: true,
              description: null,
            },
          ],
        },
      ];
      const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
      await client.connect();
      try {
        const first = await persistIssueEvidence(client, extracted, {
          source: SOURCE,
          environment: "evaluation",
          apply: true,
        });
        expect(first.snapshotsCreated).toBe(1);
        expect(first.issuesCreated).toBe(2);

        const replay = await persistIssueEvidence(client, extracted, {
          source: SOURCE,
          environment: "evaluation",
          apply: true,
        });
        expect(replay.snapshotsCreated).toBe(0);
        expect(replay.issuesCreated).toBe(0);
        expect(replay.snapshotsAlreadyPresent).toBe(1);
      } finally {
        await client.end();
      }

      const rows = await adminQuery<{ n: string }>(
        `select count(*)::text n from public.source_property_issue_evidence
          where source_property_identity_id = $1`,
        [f.identityId],
      );
      expect(rows[0]!.n).toBe("2");
    });

    it("a provider id with no ingested property is reported, not invented", async () => {
      const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
      await client.connect();
      try {
        const counts = await persistIssueEvidence(
          client,
          [
            {
              sourcePropertyId: `ghost-${uniq()}`,
              providerIssueCount: 0,
              payloadDigest: "d",
              issues: [],
            },
          ],
          { source: SOURCE, environment: "evaluation", apply: true },
        );
        expect(counts.snapshotsCreated).toBe(0);
        expect(counts.unmatchedSourcePropertyIds).toHaveLength(1);
      } finally {
        await client.end();
      }
    });

    it("the extractor never reaches the network", () => {
      for (const file of ["extract.ts", "policy.ts", "store.ts", "lifecycle.ts"]) {
        const code = readFileSync(path.join(REPO_ROOT, "scripts", "lifecycle", file), "utf8");
        expect(code).not.toMatch(/\bfetch\(|axios|node-fetch|https?:\/\/api\./);
      }
    });
  });

  // -----------------------------------------------------------------------
  describe("the extractor reads the provider's shape honestly", () => {
    it("a MISSING issues key is a complete answer of zero", () => {
      const snapshot = extractIssuesFromRecord({ code: "1", name: "x" });
      expect(snapshot).not.toBeNull();
      expect(snapshot!.providerIssueCount).toBe(0);
      expect(snapshot!.issues).toHaveLength(0);
    });

    it("an UNREADABLE issues value produces NO snapshot at all", () => {
      // Better to be unresolved than confidently zero.
      expect(extractIssuesFromRecord({ code: "1", issues: "oops" })).toBeNull();
      expect(extractIssuesFromRecord({ code: "1", issues: 42 })).toBeNull();
    });

    it("structured fields survive, and malformed dates become null", () => {
      const snapshot = extractIssuesFromRecord({
        code: "639426",
        issues: [
          {
            issueCode: "HOTEL",
            issueType: "CLOSED",
            dateFrom: "2026-05-31",
            dateTo: "2026-08-31",
            order: 2,
            alternative: false,
          },
          { issueCode: "SPA", issueType: "CLOSED", dateFrom: "not-a-date", dateTo: null },
        ],
      });
      expect(snapshot!.providerIssueCount).toBe(2);
      expect(snapshot!.issues[0]).toMatchObject({
        issueCode: "HOTEL",
        issueType: "CLOSED",
        dateFrom: "2026-05-31",
        dateTo: "2026-08-31",
        providerOrder: 2,
        alternative: false,
      });
      expect(snapshot!.issues[1]!.dateFrom).toBeNull();
    });

    it("the count reports what the PROVIDER sent, not what we parsed", () => {
      // Two entries, one unusable. The difference must stay visible rather than
      // silently becoming a count of one.
      const snapshot = extractIssuesFromRecord({
        code: "1",
        issues: [{ issueCode: "HOTEL", issueType: "CLOSED" }, { nonsense: true }],
      });
      expect(snapshot!.providerIssueCount).toBe(2);
      expect(snapshot!.issues).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  describe("the loaded policy matches the migration", () => {
    it("loads approved, with inclusive-day semantics and one mapping", async () => {
      const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
      await client.connect();
      try {
        const policy = await loadLifecyclePolicy(client, { provider: SOURCE });
        expect(policy).not.toBeNull();
        expect(policy!.approved).toBe(true);
        expect(policy!.dateSemantics).toBe("inclusive_day_interval");
        expect(policy!.mappings).toEqual([
          { issueCode: "HOTEL", issueType: "CLOSED", outcome: "property_closed_window" },
        ]);
      } finally {
        await client.end();
      }
    });
  });
});
