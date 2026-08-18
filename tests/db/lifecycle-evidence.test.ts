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
/** A stand-in run id for pure extractor tests, which never touch the DB. */
const RUN = "00000000-0000-4000-8000-00000000c0de";

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
      dateFromRaw: i.dateFrom ?? null,
      dateToRaw: i.dateTo ?? null,
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
  runId: string;
}

async function newRun(destinationId: string | null = DEST.bali): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    `insert into public.source_runs (source, source_environment, destination_id, run_mode, started_at)
     values ($1, 'evaluation', $2, 'evaluation', now()) returning id`,
    [SOURCE, destinationId],
  );
  return rows[0]!.id;
}

/** A run whose `started_at` is strictly newer than another run's. */
async function newRunAfter(
  previousRunId: string,
  destinationId: string | null = DEST.bali,
): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    `insert into public.source_runs (source, source_environment, destination_id, run_mode, started_at)
     select $1, 'evaluation', $2, 'evaluation', p.started_at + interval '1 hour'
       from public.source_runs p where p.id = $3
     returning id`,
    [SOURCE, destinationId, previousRunId],
  );
  return rows[0]!.id;
}

/**
 * Move `last_seen_run_id` under EXACTLY the rule ingestion uses: only when the
 * new run's `started_at` is STRICTLY newer. A tie is never promoted.
 */
async function advanceLastSeen(identityId: string, runId: string): Promise<number> {
  const rows = await adminQuery<{ id: string }>(
    `update public.source_property_identities spi
        set last_seen_run_id = $1
      where spi.id = $2
        and spi.last_seen_run_id <> $1
        and (select r.started_at from public.source_runs r where r.id = $1)
            > (select p.started_at from public.source_runs p where p.id = spi.last_seen_run_id)
      returning spi.id`,
    [runId, identityId],
  );
  return rows.length;
}

/** One identity with one observation. */
async function property(name = `Lifecycle ${uniq()}`, payloadDigest?: string): Promise<Fixture> {
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
       (source_run_id, source_property_identity_id, source, source_environment, observed_at,
        source_name, source_payload_digest)
     values ($1,$2,$3,'evaluation', now(), $4, $5) returning id`,
    [runId, identityId, SOURCE, name, payloadDigest ?? `digest-${uniq()}`],
  );
  return { identityId, observationId: observation[0]!.id, sourcePropertyId, runId };
}

/** A LATER observation for an existing identity. */
/**
 * A LATER observation, advancing `last_seen_run_id` the way ingestion does.
 *
 * `newRunAfter` gives the run a strictly newer `started_at`, because that — not
 * the UUID and not `observed_at` — is what ingestion requires before it will
 * move the pointer.
 */
async function laterObservation(
  f: Fixture,
  name = `Later ${uniq()}`,
  payloadDigest?: string,
): Promise<{ observationId: string; runId: string }> {
  const runId = await newRunAfter(f.runId);
  const rows = await adminQuery<{ id: string }>(
    `insert into public.source_property_observations
       (source_run_id, source_property_identity_id, source, source_environment, observed_at,
        source_name, source_payload_digest)
     values ($1,$2,$3,'evaluation', now() + interval '1 second', $4, $5) returning id`,
    [runId, f.identityId, SOURCE, name, payloadDigest ?? `digest-${uniq()}`],
  );
  await advanceLastSeen(f.identityId, runId);
  return { observationId: rows[0]!.id, runId };
}

/** A complete snapshot in the database, with its issue rows. */
async function persistSnapshot(
  f: Fixture,
  observationId: string,
  issues: IssueInput[],
  providerIssueCount = issues.length,
): Promise<string> {
  const obs = (
    await adminQuery<{ source_payload_digest: string | null; source_run_id: string }>(
      `select source_payload_digest, source_run_id
         from public.source_property_observations where id = $1`,
      [observationId],
    )
  )[0]!;
  const rows = await adminQuery<{ id: string }>(
    `insert into public.source_property_issue_snapshots
       (source_property_identity_id, source, source_environment, evidence_observation_id,
        evidence_source_run_id, extraction_status, provider_issue_count, source_payload_digest,
        extraction_method)
     values ($1,$2,'evaluation',$3,$4,'complete',$5,$6,'test') returning id`,
    [
      f.identityId,
      SOURCE,
      observationId,
      obs.source_run_id,
      providerIssueCount,
      obs.source_payload_digest,
    ],
  );
  const snapshotId = rows[0]!.id;
  for (const issue of issues) {
    await adminQuery(
      `insert into public.source_property_issue_evidence
         (snapshot_id, source_property_identity_id, issue_code, issue_type,
          date_from_raw, date_to_raw, provider_order, alternative)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
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
      latestObservationId: mine.currentObservationId,
      hasCurrentObservation: mine.currentObservationId !== null,
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
        // Present and unreadable, which is NOT the same fact as absent.
        "impossible date",
        { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-02-31", dateTo: "2026-12-31" },
        "mapped_closure_invalid_date_from",
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
      const rows = await adminQuery<{ date_from_raw: string | null; date_to_raw: string | null }>(
        `select date_from_raw, date_to_raw from public.source_property_issue_evidence
          where source_property_identity_id = $1`,
        [f.identityId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.date_from_raw).toBeNull();
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
      await persistSnapshot(f, newer.observationId, []);

      const evaluation = await evaluateFromDb(f, "2026-08-17");
      expect(evaluation.outcome).toBe("no_known_closure");
      expect(evaluation.observationId).toBe(newer.observationId);
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
      expect(evaluation.observationId).toBe(newer.observationId);
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
      const digest = (
        await adminQuery<{ source_payload_digest: string }>(
          "select source_payload_digest from public.source_property_observations where id = $1",
          [f.observationId],
        )
      )[0]!.source_payload_digest;
      const extracted = [
        {
          sourcePropertyId: f.sourcePropertyId,
          sourceRunId: f.runId,
          providerIssueCount: 2,
          wholeRecordPayloadDigest: digest,
          issues: [
            {
              issueCode: "HOTEL",
              issueType: "CLOSED",
              dateFromRaw: "2026-01-01",
              dateToRaw: "2026-12-31",
              providerOrder: 1,
              alternative: false,
              description: null,
            },
            {
              issueCode: "SPA",
              issueType: "CLOSED",
              dateFromRaw: "2026-02-01",
              dateToRaw: "2026-03-01",
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
              sourceRunId: RUN,
              providerIssueCount: 0,
              wholeRecordPayloadDigest: "d",
              issues: [],
            },
          ],
          { source: SOURCE, environment: "evaluation", apply: true },
        );
        expect(counts.snapshotsCreated).toBe(0);
        expect(counts.provenanceMismatches).toHaveLength(1);
        expect(counts.provenanceMismatches[0]!.reason).toBe("no_ingested_property");
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
      const { snapshot, failure } = extractIssuesFromRecord({ code: "1", name: "x" }, RUN);
      expect(failure).toBeNull();
      expect(snapshot!.providerIssueCount).toBe(0);
      expect(snapshot!.issues).toHaveLength(0);
    });

    it("an UNREADABLE issues value produces NO snapshot at all", () => {
      // Better to be unresolved than confidently zero.
      for (const issues of ["oops", 42, { a: 1 }]) {
        const { snapshot, failure } = extractIssuesFromRecord({ code: "1", issues }, RUN);
        expect(snapshot).toBeNull();
        expect(failure!.reason).toBe("issues_not_an_array");
      }
    });

    it("structured fields survive, and provider date bytes are kept VERBATIM", () => {
      const { snapshot } = extractIssuesFromRecord(
        {
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
        },
        RUN,
      );
      expect(snapshot!.providerIssueCount).toBe(2);
      expect(snapshot!.issues[0]).toMatchObject({
        issueCode: "HOTEL",
        issueType: "CLOSED",
        dateFromRaw: "2026-05-31",
        dateToRaw: "2026-08-31",
        providerOrder: 2,
        alternative: false,
      });
      // NOT normalised to null: the provider said something, and what it said
      // survives so the evaluator can call it invalid rather than absent.
      expect(snapshot!.issues[1]!.dateFromRaw).toBe("not-a-date");
      expect(snapshot!.issues[1]!.dateToRaw).toBeNull();
    });

    it("a NON-STRING date makes the entry unreadable — no snapshot, explicit failure", () => {
      // Three states, and only three: absent, a string kept whole, or
      // unreadable. A number is none of the first two — `20260231` is not a date
      // the provider omitted, and `"20260231"` is a statement it never made.
      const cases: [string, unknown, "unreadable_issue_date_from"][] = [
        ["number", 20260231, "unreadable_issue_date_from"],
        ["object", { unexpected: true }, "unreadable_issue_date_from"],
        ["boolean", true, "unreadable_issue_date_from"],
        ["array", ["2026-01-01"], "unreadable_issue_date_from"],
      ];
      for (const [label, dateFrom, reason] of cases) {
        const { snapshot, failure } = extractIssuesFromRecord(
          {
            code: "639426",
            issues: [{ issueCode: "HOTEL", issueType: "CLOSED", dateFrom, order: 3 }],
          },
          RUN,
        );
        expect(snapshot, label).toBeNull();
        expect(failure!.reason, label).toBe(reason);
        expect(failure!.sourcePropertyId, label).toBe("639426");
        expect(failure!.issueIndex, label).toBe(0);
        expect(failure!.providerOrder, label).toBe(3);
      }
    });

    it("a NON-STRING dateTo is reported as its own reason", () => {
      for (const dateTo of [20261231, { a: 1 }, false]) {
        const { snapshot, failure } = extractIssuesFromRecord(
          {
            code: "1",
            issues: [{ issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo }],
          },
          RUN,
        );
        expect(snapshot).toBeNull();
        expect(failure!.reason).toBe("unreadable_issue_date_to");
      }
    });

    it("a non-string date is NEVER coerced to a string or to missing", () => {
      // The two wrong outcomes this replaces, stated as assertions.
      const { snapshot } = extractIssuesFromRecord(
        { code: "1", issues: [{ issueCode: "HOTEL", issueType: "CLOSED", dateFrom: 20260231 }] },
        RUN,
      );
      expect(snapshot).toBeNull();
      // Had it been coerced there would be a snapshot carrying "20260231"; had
      // it been nulled there would be one claiming the provider omitted a field
      // it actually sent. Neither exists.
    });

    it("string dates the provider chose to send survive VERBATIM", () => {
      for (const dateFrom of ["2026-02-31", "2026-08-31garbage", " 2026-08-31 ", "", "n"]) {
        const { snapshot, failure } = extractIssuesFromRecord(
          { code: "1", issues: [{ issueCode: "HOTEL", issueType: "CLOSED", dateFrom }] },
          RUN,
        );
        expect(failure, JSON.stringify(dateFrom)).toBeNull();
        expect(snapshot!.issues[0]!.dateFromRaw, JSON.stringify(dateFrom)).toBe(dateFrom);
      }
    });

    it("an empty-string date is a provider statement, not a missing field", () => {
      const { snapshot } = extractIssuesFromRecord(
        { code: "1", issues: [{ issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "" }] },
        RUN,
      );
      expect(snapshot!.issues[0]!.dateFromRaw).toBe("");
      expect(snapshot!.issues[0]!.dateFromRaw).not.toBeNull();
      // And the evaluator calls it INVALID, not missing.
      const evaluation = evaluateLifecycle({
        snapshot: snapshotOf([
          { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "", dateTo: "2026-12-31" },
        ]),
        policy: APPROVED,
        asOf: "2026-08-17",
      });
      expect(evaluation.unresolvedReasons).toEqual(["mapped_closure_invalid_date_from"]);
    });

    it("an ABSENT date field is still null, and still complete", () => {
      const { snapshot, failure } = extractIssuesFromRecord(
        { code: "1", issues: [{ issueCode: "HOTEL", issueType: "CLOSED" }] },
        RUN,
      );
      expect(failure).toBeNull();
      expect(snapshot!.issues[0]!.dateFromRaw).toBeNull();
      expect(snapshot!.issues[0]!.dateToRaw).toBeNull();
      expect(snapshot!.providerIssueCount).toBe(1);
    });

    it("a date longer than ten characters is NOT sliced into a clean one", () => {
      const { snapshot } = extractIssuesFromRecord(
        {
          code: "1",
          issues: [{ issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-08-31garbage" }],
        },
        RUN,
      );
      expect(snapshot!.issues[0]!.dateFromRaw).toBe("2026-08-31garbage");
    });
  });

  // -----------------------------------------------------------------------
  // A snapshot is COMPLETE only if every provider entry was represented. The
  // failure mode this closes: provider count 1, child rows 0, snapshot
  // "complete" — and an evaluator answering `no_known_closure` about a property
  // whose only issue nobody could read.
  describe("a complete snapshot cannot contain an incomplete parse", () => {
    it("1. one valid + one unreadable entry produces NO complete snapshot", () => {
      const unreadable = [
        { label: "non-object entry", entry: 42, reason: "unreadable_issue_entry" },
        { label: "null entry", entry: null, reason: "unreadable_issue_entry" },
        { label: "no issueCode", entry: { issueType: "CLOSED" }, reason: "unreadable_issue_code" },
        {
          label: "empty issueCode",
          entry: { issueCode: "", issueType: "CLOSED" },
          reason: "unreadable_issue_code",
        },
        { label: "no issueType", entry: { issueCode: "HOTEL" }, reason: "unreadable_issue_type" },
      ];
      for (const { label, entry, reason } of unreadable) {
        const { snapshot, failure } = extractIssuesFromRecord(
          {
            code: "639426",
            issues: [{ issueCode: "SPA", issueType: "CLOSED", order: 1 }, entry],
          },
          RUN,
        );
        expect(snapshot, label).toBeNull();
        expect(failure!.reason, label).toBe(reason);
        expect(failure!.sourcePropertyId, label).toBe("639426");
        // The provider's own position in the array, so a reviewer can find it.
        expect(failure!.issueIndex, label).toBe(1);
      }
    });

    it("the failure reports the provider's own order when it supplied one", () => {
      const { failure } = extractIssuesFromRecord(
        {
          code: "1",
          issues: [{ issueType: "CLOSED", order: 7 }],
        },
        RUN,
      );
      expect(failure!.providerOrder).toBe(7);
      expect(failure!.issueIndex).toBe(0);
    });

    it("a readable record always satisfies count == represented", () => {
      const { snapshot } = extractIssuesFromRecord(
        {
          code: "1",
          issues: [
            { issueCode: "HOTEL", issueType: "CLOSED" },
            { issueCode: "SPA", issueType: "CLOSED" },
            { issueCode: "WATERPARK", issueType: "REFURBISHMENT" },
          ],
        },
        RUN,
      );
      expect(snapshot!.providerIssueCount).toBe(3);
      expect(snapshot!.issues).toHaveLength(snapshot!.providerIssueCount);
    });

    it("2. provider count > loaded rows evaluates UNRESOLVED", async () => {
      // Defence in depth: the extractor cannot produce this, so it is written
      // directly — exactly as a future writer or a hand-edit might.
      const f = await property("Count mismatch");
      await persistSnapshot(
        f,
        f.observationId,
        [{ issueCode: "SPA", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: "2026-12-31" }],
        2,
      );
      const evaluation = await evaluateFromDb(f, "2026-08-17");
      expect(evaluation.outcome).toBe("unresolved");
      expect(evaluation.unresolvedReasons).toContain("issue_count_mismatch");
    });

    it("a mismatch wins even when the present rows look clean", () => {
      // The unaccounted issue may BE the closure, so the readable ones cannot
      // settle the question.
      const snapshot = snapshotOf([{ issueCode: "SPA", issueType: "CLOSED" }]);
      snapshot.providerIssueCount = 2;
      const evaluation = evaluateLifecycle({ snapshot, policy: APPROVED, asOf: "2026-08-17" });
      expect(evaluation.outcome).toBe("unresolved");
      expect(evaluation.unresolvedReasons).toEqual(["issue_count_mismatch"]);
    });

    it("3. provider count 0 with zero rows is still a valid NO_KNOWN_CLOSURE", async () => {
      const f = await property("Genuinely no issues");
      await persistSnapshot(f, f.observationId, []);
      expect((await evaluateFromDb(f, "2026-08-17")).outcome).toBe("no_known_closure");
    });

    it("4. provider count N with N rows evaluates normally", async () => {
      const f = await property("Complete and closed");
      await persistSnapshot(f, f.observationId, [
        { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: "2026-12-31" },
        { issueCode: "SPA", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: "2026-02-01" },
      ]);
      expect((await evaluateFromDb(f, "2026-08-17")).outcome).toBe("known_closed");
    });
  });

  // -----------------------------------------------------------------------
  // The contract promises malformed evidence is PRESERVED. A `date` column
  // cannot keep that promise: `2026-02-31` rolls the transaction back, and
  // anything longer than ten characters would have to be trimmed to fit.
  describe("malformed provider dates survive persistence VERBATIM", () => {
    it("6. an impossible date round-trips through the real DB and is UNRESOLVED", async () => {
      const f = await property("Impossible date");
      await persistSnapshot(f, f.observationId, [
        { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-02-31", dateTo: "2026-12-31" },
      ]);

      const rows = await adminQuery<{ date_from_raw: string | null }>(
        `select date_from_raw from public.source_property_issue_evidence
          where source_property_identity_id = $1`,
        [f.identityId],
      );
      // The transaction succeeded AND the bad value is still queryable.
      expect(rows[0]!.date_from_raw).toBe("2026-02-31");

      const evaluation = await evaluateFromDb(f, "2026-08-17");
      expect(evaluation.outcome).toBe("unresolved");
      expect(evaluation.unresolvedReasons).toContain("mapped_closure_invalid_date_from");
      // NOT called "missing": the provider said something.
      expect(evaluation.unresolvedReasons).not.toContain("mapped_closure_missing_date_from");
    });

    it("7. trailing garbage round-trips, and is never read as a clean date", async () => {
      const f = await property("Trailing garbage");
      await persistSnapshot(f, f.observationId, [
        {
          issueCode: "HOTEL",
          issueType: "CLOSED",
          dateFrom: "2026-08-31garbage",
          dateTo: "2026-12-31",
        },
      ]);

      const rows = await adminQuery<{ date_from_raw: string | null }>(
        `select date_from_raw from public.source_property_issue_evidence
          where source_property_identity_id = $1`,
        [f.identityId],
      );
      expect(rows[0]!.date_from_raw).toBe("2026-08-31garbage");
      expect(rows[0]!.date_from_raw).not.toBe("2026-08-31");

      const evaluation = await evaluateFromDb(f, "2026-08-17");
      expect(evaluation.outcome).toBe("unresolved");
      expect(evaluation.unresolvedReasons).toContain("mapped_closure_invalid_date_from");
      expect(evaluation.activeClosureWindows).toHaveLength(0);
    });

    it("an absent endpoint and an unreadable one are DIFFERENT reasons", () => {
      const absent = evaluateLifecycle({
        snapshot: snapshotOf([
          { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: null, dateTo: "2026-12-31" },
        ]),
        policy: APPROVED,
        asOf: "2026-08-17",
      });
      expect(absent.unresolvedReasons).toEqual(["mapped_closure_missing_date_from"]);

      const unreadable = evaluateLifecycle({
        snapshot: snapshotOf([
          { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "not-a-date", dateTo: "2026-12-31" },
        ]),
        policy: APPROVED,
        asOf: "2026-08-17",
      });
      expect(unreadable.unresolvedReasons).toEqual(["mapped_closure_invalid_date_from"]);
    });

    it("an unreadable dateTo is reported as invalid, not missing", () => {
      const evaluation = evaluateLifecycle({
        snapshot: snapshotOf([
          { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: "2026-13-01" },
        ]),
        policy: APPROVED,
        asOf: "2026-08-17",
      });
      expect(evaluation.unresolvedReasons).toEqual(["mapped_closure_invalid_date_to"]);
    });

    it("the raw columns are text, so no cast can reject the evidence", async () => {
      const rows = await adminQuery<{ column_name: string; data_type: string }>(
        `select column_name, data_type from information_schema.columns
          where table_name = 'source_property_issue_evidence' and column_name like 'date%'`,
      );
      expect(rows).toHaveLength(2);
      for (const r of rows) expect(r.data_type).toBe("text");
    });
  });

  // -----------------------------------------------------------------------
  // "Which observation does this artifact record describe?" is not the same
  // question as "which observation is newest?".
  describe("issue evidence binds to the EXACT provider record", () => {
    async function persistExtracted(
      sourcePropertyId: string,
      digest: string,
      issues: IssueInput[],
      sourceRunId: string,
    ) {
      const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
      await client.connect();
      try {
        return await persistIssueEvidence(
          client,
          [
            {
              sourcePropertyId,
              sourceRunId,
              providerIssueCount: issues.length,
              wholeRecordPayloadDigest: digest,
              issues: issues.map((i) => ({
                issueCode: i.issueCode,
                issueType: i.issueType,
                dateFromRaw: i.dateFrom ?? null,
                dateToRaw: i.dateTo ?? null,
                providerOrder: i.providerOrder ?? null,
                alternative: i.alternative ?? null,
                description: null,
              })),
            },
          ],
          { source: SOURCE, environment: "evaluation", apply: true },
        );
      } finally {
        await client.end();
      }
    }

    it("10. an OLD artifact extracted after a NEWER observation binds to the old one", async () => {
      const digestA = `AAA-${uniq()}`;
      const digestB = `BBB-${uniq()}`;
      const f = await property("Run A", digestA);
      const b = await laterObservation(f, "Run B", digestB);
      const observationB = b.observationId;

      // Extract artifact A, which is now the OLDER record.
      const counts = await persistExtracted(
        f.sourcePropertyId,
        digestA,
        [{ issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: "2026-12-31" }],
        f.runId,
      );
      expect(counts.snapshotsCreated).toBe(1);

      const bound = await adminQuery<{ evidence_observation_id: string }>(
        `select evidence_observation_id from public.source_property_issue_snapshots
          where source_property_identity_id = $1`,
        [f.identityId],
      );
      // Bound to A, NOT to whichever observation happened to be newest.
      expect(bound[0]!.evidence_observation_id).toBe(f.observationId);
      expect(bound[0]!.evidence_observation_id).not.toBe(observationB);

      // And because B has no snapshot, the CURRENT answer is unresolved — the
      // old closure does not leak forward.
      const evaluation = await evaluateFromDb(f, "2026-08-17");
      expect(evaluation.outcome).toBe("unresolved");
      expect(evaluation.unresolvedReasons).toContain("no_complete_issue_snapshot");
      expect(evaluation.observationId).toBe(observationB);
    });

    it("extracting the NEWER artifact then binds to it, and it becomes current", async () => {
      const digestA = `AAA-${uniq()}`;
      const digestB = `BBB-${uniq()}`;
      const f = await property("Run A", digestA);
      const b = await laterObservation(f, "Run B", digestB);
      const observationB = b.observationId;
      await persistExtracted(
        f.sourcePropertyId,
        digestA,
        [{ issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: "2026-12-31" }],
        f.runId,
      );
      await persistExtracted(f.sourcePropertyId, digestB, [], b.runId);

      const bound = await adminQuery<{ evidence_observation_id: string }>(
        `select evidence_observation_id from public.source_property_issue_snapshots
          where source_property_identity_id = $1 order by created_at desc limit 1`,
        [f.identityId],
      );
      expect(bound[0]!.evidence_observation_id).toBe(observationB);

      const evaluation = await evaluateFromDb(f, "2026-08-17");
      expect(evaluation.outcome).toBe("no_known_closure");
      expect(evaluation.observationId).toBe(observationB);
    });

    it("11. a digest matching NO observation is refused, not best-effort attached", async () => {
      const f = await property("Known property", `REAL-${uniq()}`);
      const counts = await persistExtracted(
        f.sourcePropertyId,
        `UNKNOWN-${uniq()}`,
        [{ issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: "2026-12-31" }],
        f.runId,
      );

      expect(counts.snapshotsCreated).toBe(0);
      expect(counts.provenanceMismatches).toHaveLength(1);
      // The property IS ingested — this is the "no exact (run, property,
      // payload) match" case, kept distinct from "never ingested".
      expect(counts.provenanceMismatches[0]!.reason).toBe("no_exact_observation_match");

      const rows = await adminQuery<{ n: string }>(
        `select count(*)::text n from public.source_property_issue_snapshots
          where source_property_identity_id = $1`,
        [f.identityId],
      );
      expect(rows[0]!.n).toBe("0");
      expect((await evaluateFromDb(f, "2026-08-17")).outcome).toBe("unresolved");
    });

    it("SAME property + SAME digest + TWO runs: each artifact binds to its OWN run", async () => {
      // The case a digest alone cannot decide. Observations are unique per
      // (run, identity), NOT per digest, so two runs that both saw an UNCHANGED
      // property are two valid rows carrying identical digests. A lookup keyed
      // on (property, digest) selects both and keeps whichever the map or the
      // row order happened to write last.
      const shared = `SAME-DIGEST-${uniq()}`;
      const f = await property("Run A", shared);
      const b = await laterObservation(f, "Run B", shared);

      expect(b.runId).not.toBe(f.runId);
      const digests = await adminQuery<{ n: string }>(
        `select count(distinct source_payload_digest)::text n
           from public.source_property_observations where source_property_identity_id = $1`,
        [f.identityId],
      );
      // Precondition: the two observations really are indistinguishable by digest.
      expect(digests[0]!.n).toBe("1");

      // Extract artifact A (the OLDER run).
      const a = await persistExtracted(
        f.sourcePropertyId,
        shared,
        [{ issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: "2026-12-31" }],
        f.runId,
      );
      expect(a.snapshotsCreated).toBe(1);

      const boundA = await adminQuery<{ obs: string; run: string }>(
        `select evidence_observation_id as obs, evidence_source_run_id as run
           from public.source_property_issue_snapshots where source_property_identity_id = $1`,
        [f.identityId],
      );
      expect(boundA).toHaveLength(1);
      expect(boundA[0]!.obs).toBe(f.observationId);
      expect(boundA[0]!.run).toBe(f.runId);
      // Not the later observation, even though its digest is identical.
      expect(boundA[0]!.obs).not.toBe(b.observationId);

      // B still has no snapshot, so the CURRENT answer is unresolved. The old
      // closure must not leak forward onto a run it did not describe.
      const mid = await evaluateFromDb(f, "2026-08-17");
      expect(mid.outcome).toBe("unresolved");
      expect(mid.observationId).toBe(b.observationId);

      // Extract artifact B: same property, same digest, different run.
      const second = await persistExtracted(f.sourcePropertyId, shared, [], b.runId);
      expect(second.snapshotsCreated).toBe(1);

      const boundB = await adminQuery<{ obs: string; run: string }>(
        `select evidence_observation_id as obs, evidence_source_run_id as run
           from public.source_property_issue_snapshots
          where source_property_identity_id = $1 and evidence_source_run_id = $2`,
        [f.identityId, b.runId],
      );
      expect(boundB).toHaveLength(1);
      expect(boundB[0]!.obs).toBe(b.observationId);

      // Two snapshots, one per run, each on its own observation.
      const all = await adminQuery<{ n: string }>(
        `select count(*)::text n from public.source_property_issue_snapshots
          where source_property_identity_id = $1`,
        [f.identityId],
      );
      expect(all[0]!.n).toBe("2");

      const after = await evaluateFromDb(f, "2026-08-17");
      expect(after.outcome).toBe("no_known_closure");
      expect(after.observationId).toBe(b.observationId);
    });

    it("the database refuses a snapshot bound to a run that is not the observation's", async () => {
      // Application logic is the first layer; this composite FK is the second.
      const f = await property("Run guard");
      const b = await laterObservation(f, "Other run");
      await expect(
        adminQuery(
          `insert into public.source_property_issue_snapshots
             (source_property_identity_id, source, source_environment, evidence_observation_id,
              evidence_source_run_id, provider_issue_count, source_payload_digest, extraction_method)
           select $1,$2,'evaluation',$3,$4,0,o.source_payload_digest,'test'
             from public.source_property_observations o where o.id = $3`,
          [f.identityId, SOURCE, f.observationId, b.runId],
        ),
      ).rejects.toThrow(/foreign key|violates/i);
    });

    it("the run id comes from the ingestion pipeline's own deterministic identity", () => {
      // Not a parallel scheme: the same fingerprint the ingest used.
      const code = readFileSync(path.join(REPO_ROOT, "scripts", "lifecycle", "extract.ts"), "utf8");
      expect(code).toContain("deterministicUuid(runFingerprint(manifest))");
      expect(code).toContain('from "../provider-ingestion/manifest"');
    });

    it("the database refuses a snapshot whose digest is not that observation's", async () => {
      // Application logic is the first layer; the composite FK is the second.
      const f = await property("FK guard", `REAL-${uniq()}`);
      await expect(
        adminQuery(
          `insert into public.source_property_issue_snapshots
             (source_property_identity_id, source, source_environment, evidence_observation_id,
              evidence_source_run_id, provider_issue_count, source_payload_digest, extraction_method)
           values ($1,$2,'evaluation',$3,$4,0,'SOME-OTHER-DIGEST','test')`,
          [f.identityId, SOURCE, f.observationId, f.runId],
        ),
      ).rejects.toThrow(/foreign key|violates/i);
    });
  });

  // -----------------------------------------------------------------------
  // A provider code is an IDENTIFIER, not user text. Repairing one invents a
  // provider statement — and the statement it would invent here is the single
  // mapping that closes a property.
  describe("8. provider codes are never silently repaired", () => {
    const window = { dateFrom: "2026-01-01", dateTo: "2026-12-31" };

    for (const [label, issueCode, issueType] of [
      ["trailing space on the code", "HOTEL ", "CLOSED"],
      ["leading space on the code", " HOTEL", "CLOSED"],
      ["trailing space on the type", "HOTEL", "CLOSED "],
      ["leading space on the type", "HOTEL", " CLOSED"],
      ["both padded", "HOTEL ", " CLOSED"],
      ["lower case", "hotel", "closed"],
      ["inner padding", "HO TEL", "CLOSED"],
    ] as const) {
      it(`${label} does NOT acquire the approved mapping`, () => {
        expect(outcomeOn([{ issueCode, issueType, ...window }], "2026-08-17")).toBe(
          "no_known_closure",
        );
      });
    }

    it("the exact approved pair still matches", () => {
      expect(
        outcomeOn([{ issueCode: "HOTEL", issueType: "CLOSED", ...window }], "2026-08-17"),
      ).toBe("known_closed");
    });

    it("the padded code survives in the evidence exactly as sent", () => {
      const { snapshot } = extractIssuesFromRecord(
        {
          code: "1",
          issues: [{ issueCode: "HOTEL ", issueType: " CLOSED" }],
        },
        RUN,
      );
      expect(snapshot!.issues[0]!.issueCode).toBe("HOTEL ");
      expect(snapshot!.issues[0]!.issueType).toBe(" CLOSED");
    });

    it("a padded code round-trips through the DB without being repaired", async () => {
      const f = await property("Padded code");
      await persistSnapshot(f, f.observationId, [
        { issueCode: "HOTEL ", issueType: "CLOSED", ...window },
      ]);
      const rows = await adminQuery<{ issue_code: string }>(
        `select issue_code from public.source_property_issue_evidence
          where source_property_identity_id = $1`,
        [f.identityId],
      );
      expect(rows[0]!.issue_code).toBe("HOTEL ");
      expect((await evaluateFromDb(f, "2026-08-17")).outcome).toBe("no_known_closure");
    });

    it("no lifecycle source file trims a provider code", () => {
      const code = readFileSync(
        path.join(REPO_ROOT, "scripts", "lifecycle", "extract.ts"),
        "utf8",
      ).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      // `providerCode` must contain no trim; the helper is the only place a
      // code is read.
      const helper = code.slice(code.indexOf("function providerCode"));
      const body = helper.slice(0, helper.indexOf("\n}"));
      expect(body).not.toMatch(/\.trim\(\)/);
    });

    it("padding cannot collide two distinct pairs into one key", () => {
      // With a space separator, `"HOTEL " + "CLOSED"` and `"HOTEL" + " CLOSED"`
      // would key identically and one of them would inherit the mapping.
      expect(
        outcomeOn([{ issueCode: "HOTEL ", issueType: "CLOSED", ...window }], "2026-08-17"),
      ).toBe("no_known_closure");
      expect(
        outcomeOn([{ issueCode: "HOTEL", issueType: " CLOSED", ...window }], "2026-08-17"),
      ).toBe("no_known_closure");
    });
  });

  // -----------------------------------------------------------------------
  // A dry-run is the apply, minus the writing. Anything else is a false preview.
  describe("DRY-RUN mirrors APPLY exactly", () => {
    async function extractedFor(f: Fixture, issues: IssueInput[]) {
      const digest = (
        await adminQuery<{ source_payload_digest: string }>(
          "select source_payload_digest from public.source_property_observations where id = $1",
          [f.observationId],
        )
      )[0]!.source_payload_digest;
      return {
        sourcePropertyId: f.sourcePropertyId,
        sourceRunId: f.runId,
        wholeRecordPayloadDigest: digest,
        providerIssueCount: issues.length,
        issues: issues.map((i) => ({
          issueCode: i.issueCode,
          issueType: i.issueType,
          dateFromRaw: i.dateFrom ?? null,
          dateToRaw: i.dateTo ?? null,
          providerOrder: i.providerOrder ?? null,
          alternative: i.alternative ?? null,
          description: null,
        })),
      };
    }

    async function persist(batch: unknown[], apply: boolean) {
      const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
      await client.connect();
      try {
        return await persistIssueEvidence(client, batch as never, {
          source: SOURCE,
          environment: "evaluation",
          apply,
        });
      } finally {
        await client.end();
      }
    }

    const totals = async () => {
      const rows = await adminQuery<{ snapshots: string; issues: string; checksum: string | null }>(
        `select (select count(*)::text from public.source_property_issue_snapshots) as snapshots,
                (select count(*)::text from public.source_property_issue_evidence) as issues,
                (select md5(string_agg(evidence_digest, '|' order by evidence_digest))
                   from public.source_property_issue_evidence) as checksum`,
      );
      return rows[0]!;
    };

    it("A. fresh: the dry-run prediction equals what apply writes, and writes nothing itself", async () => {
      const a = await property("Fresh one");
      const b = await property("Fresh two");
      const batch = [
        await extractedFor(a, [
          { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: "2026-12-31" },
        ]),
        await extractedFor(b, []),
      ];

      const before = await totals();
      const dry = await persist(batch, false);
      const afterDry = await totals();

      // The dry-run mutated nothing at all.
      expect(afterDry).toEqual(before);

      expect(dry.snapshotsCreated).toBe(2);
      expect(dry.snapshotsAlreadyPresent).toBe(0);
      expect(dry.issuesCreated).toBe(1);

      const applied = await persist(batch, true);
      expect(applied.snapshotsCreated).toBe(dry.snapshotsCreated);
      expect(applied.snapshotsAlreadyPresent).toBe(dry.snapshotsAlreadyPresent);
      expect(applied.issuesCreated).toBe(dry.issuesCreated);
    });

    it("B. replay: after apply, the dry-run predicts zero writes", async () => {
      const f = await property("Replay preview");
      const batch = [
        await extractedFor(f, [
          { issueCode: "SPA", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: "2026-02-01" },
        ]),
      ];
      await persist(batch, true);

      const dry = await persist(batch, false);
      expect(dry.snapshotsCreated).toBe(0);
      // The old bug: every incoming issue counted as created even though apply
      // sees the snapshot, continues, and writes none.
      expect(dry.issuesCreated).toBe(0);
      expect(dry.snapshotsAlreadyPresent).toBe(1);

      const replay = await persist(batch, true);
      expect(replay.snapshotsCreated).toBe(0);
      expect(replay.issuesCreated).toBe(0);
      expect(replay.snapshotsAlreadyPresent).toBe(1);
    });

    it("C. cross-batch: snapshots OUTSIDE the batch do not affect its counts", async () => {
      // The exact Bali/Dubai failure: a database already full of snapshots for
      // other properties must not make this batch look already-done.
      const outsiders = [];
      for (let i = 0; i < 3; i += 1) {
        const o = await property(`Outsider ${i}`);
        outsiders.push(await extractedFor(o, []));
      }
      await persist(outsiders, true);

      const mine = await property("In batch");
      const batch = [
        await extractedFor(mine, [
          { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: "2026-12-31" },
        ]),
      ];

      const dry = await persist(batch, false);
      expect(dry.snapshotsCreated).toBe(1);
      expect(dry.snapshotsAlreadyPresent).toBe(0);
      expect(dry.issuesCreated).toBe(1);

      const applied = await persist(batch, true);
      expect(applied.snapshotsCreated).toBe(1);
      expect(applied.issuesCreated).toBe(1);
    });

    it("D. mixed batch: one existing, one new — counted separately", async () => {
      const existing = await property("Already extracted");
      const fresh = await property("Not yet extracted");
      const existingBatch = [
        await extractedFor(existing, [
          { issueCode: "SPA", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: "2026-02-01" },
        ]),
      ];
      await persist(existingBatch, true);

      const mixed = [
        existingBatch[0],
        await extractedFor(fresh, [
          { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: "2026-12-31" },
          {
            issueCode: "WATERPARK",
            issueType: "CLOSED",
            dateFrom: "2026-03-01",
            dateTo: "2026-04-01",
          },
        ]),
      ];

      const dry = await persist(mixed, false);
      expect(dry.snapshotsAlreadyPresent).toBe(1);
      expect(dry.snapshotsCreated).toBe(1);
      // ONLY the new snapshot's issues — the existing one contributes none.
      expect(dry.issuesCreated).toBe(2);

      const applied = await persist(mixed, true);
      expect(applied.snapshotsAlreadyPresent).toBe(1);
      expect(applied.snapshotsCreated).toBe(1);
      expect(applied.issuesCreated).toBe(2);
    });

    it("E. a dry-run leaves row counts and the evidence checksum untouched", async () => {
      const f = await property("Checksum guard");
      const batch = [
        await extractedFor(f, [
          { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: "2026-12-31" },
        ]),
      ];
      const before = await totals();
      await persist(batch, false);
      await persist(batch, false);
      expect(await totals()).toEqual(before);
    });

    it("a provenance mismatch predicts no writes in either mode", async () => {
      const f = await property("Mismatch preview");
      const bad = { ...(await extractedFor(f, [])), wholeRecordPayloadDigest: `NOPE-${uniq()}` };
      const dry = await persist([bad], false);
      expect(dry.snapshotsCreated).toBe(0);
      expect(dry.issuesCreated).toBe(0);
      expect(dry.provenanceMismatches).toHaveLength(1);
      expect(dry.provenanceMismatches[0]!.reason).toBe("no_exact_observation_match");
    });
  });

  // -----------------------------------------------------------------------
  // A UUID is not evidence about time. Observations are unique per
  // (run, identity), NOT per (identity, observed_at), so a tie is representable.
  describe("the CURRENT observation follows last_seen_run_id, never a UUID", () => {
    /** A second observation for the same identity, in its own run, SAME observed_at. */
    async function tiedObservation(f: Fixture, name: string, startedAtOffsetHours: number) {
      const runRows = await adminQuery<{ id: string }>(
        `insert into public.source_runs (source, source_environment, destination_id, run_mode, started_at)
         select $1,'evaluation',$2,'evaluation', p.started_at + ($3 || ' hours')::interval
           from public.source_runs p where p.id = $4
         returning id`,
        [SOURCE, DEST.bali, String(startedAtOffsetHours), f.runId],
      );
      const runId = runRows[0]!.id;
      const rows = await adminQuery<{ id: string }>(
        // IDENTICAL observed_at to the first observation — the tie the schema
        // permits and the old ordering could not resolve.
        `insert into public.source_property_observations
           (source_run_id, source_property_identity_id, source, source_environment, observed_at,
            source_name, source_payload_digest)
         select $1,$2,$3,'evaluation',
                (select o.observed_at from public.source_property_observations o where o.id = $4),
                $5, $6
         returning id`,
        [runId, f.identityId, SOURCE, f.observationId, name, `digest-${uniq()}`],
      );
      return { observationId: rows[0]!.id, runId };
    }

    it("A. identical observed_at: the run pointer decides, not the UUID", async () => {
      const f = await property("Tie: original");
      await persistSnapshot(f, f.observationId, [
        { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: "2026-12-31" },
      ]);

      // A second observation at the SAME instant, with no closure.
      const other = await tiedObservation(f, "Tie: other", 1);
      await persistSnapshot(f, other.observationId, []);

      const tied = await adminQuery<{ n: string }>(
        `select count(distinct observed_at)::text n from public.source_property_observations
          where source_property_identity_id = $1`,
        [f.identityId],
      );
      // Precondition: the two really are tied on observed_at.
      expect(tied[0]!.n).toBe("1");

      // last_seen_run_id still points at the ORIGINAL run.
      const before = await evaluateFromDb(f, "2026-08-17");
      expect(before.observationId).toBe(f.observationId);
      expect(before.outcome).toBe("known_closed");

      // Advance the pointer the way ingestion would, then re-evaluate.
      expect(await advanceLastSeen(f.identityId, other.runId)).toBe(1);
      const after = await evaluateFromDb(f, "2026-08-17");
      expect(after.observationId).toBe(other.observationId);
      expect(after.outcome).toBe("no_known_closure");
    });

    it("B. the answer does not change when UUID order opposes the run pointer", async () => {
      // Whichever way the UUIDs happen to sort, the pointer wins. Repeated so a
      // lucky ordering cannot pass by accident.
      for (let i = 0; i < 6; i += 1) {
        const f = await property(`Order probe ${i}`);
        await persistSnapshot(f, f.observationId, [
          { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: "2026-12-31" },
        ]);
        const other = await tiedObservation(f, `Order probe other ${i}`, 1);
        await persistSnapshot(f, other.observationId, []);

        // The pointer stays on the original, so the closure stays current —
        // even in the iterations where the other UUID sorts later.
        const evaluation = await evaluateFromDb(f, "2026-08-17");
        expect(evaluation.observationId, `iteration ${i}`).toBe(f.observationId);
        expect(evaluation.outcome, `iteration ${i}`).toBe("known_closed");
      }
    });

    it("C. a genuinely newer run advances the pointer and lifecycle follows it", async () => {
      const f = await property("Newer run");
      await persistSnapshot(f, f.observationId, [
        { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: "2026-12-31" },
      ]);
      expect((await evaluateFromDb(f, "2026-08-17")).outcome).toBe("known_closed");

      const newer = await laterObservation(f, "Reopened");
      await persistSnapshot(f, newer.observationId, []);

      const evaluation = await evaluateFromDb(f, "2026-08-17");
      expect(evaluation.observationId).toBe(newer.observationId);
      expect(evaluation.outcome).toBe("no_known_closure");
    });

    it("D. the current run has no snapshot while an older one does -> UNRESOLVED", async () => {
      const f = await property("No fallback");
      await persistSnapshot(f, f.observationId, [
        { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: "2026-12-31" },
      ]);
      const newer = await laterObservation(f, "Unextracted");

      const evaluation = await evaluateFromDb(f, "2026-08-17");
      expect(evaluation.outcome).toBe("unresolved");
      expect(evaluation.unresolvedReasons).toContain("no_complete_issue_snapshot");
      expect(evaluation.observationId).toBe(newer.observationId);
    });

    it("E. an unresolvable current-run pointer FAILS CLOSED and stays in the sweep", async () => {
      const f = await property("Dangling pointer");
      await persistSnapshot(f, f.observationId, [
        { issueCode: "HOTEL", issueType: "CLOSED", dateFrom: "2026-01-01", dateTo: "2026-12-31" },
      ]);

      // A newer run the identity now points at, with NO observation of its own —
      // representable because `last_seen_run_id` is a run reference, not an
      // observation one.
      const orphanRun = await newRunAfter(f.runId);
      expect(await advanceLastSeen(f.identityId, orphanRun)).toBe(1);

      const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
      await client.connect();
      let mine;
      try {
        const properties = await loadEvaluableProperties(client, {
          source: SOURCE,
          environment: "evaluation",
        });
        mine = properties.find((p) => p.identityId === f.identityId);
      } finally {
        await client.end();
      }

      // NOT dropped from the sweep — that would hide it from D062.
      expect(mine, "the property must still be evaluated").toBeDefined();
      expect(mine!.currentObservationId).toBeNull();
      expect(mine!.lastSeenRunId).toBe(orphanRun);
      expect(mine!.snapshot).toBeNull();

      const evaluation = await evaluateFromDb(f, "2026-08-17");
      expect(evaluation.outcome).toBe("unresolved");
      expect(evaluation.unresolvedReasons).toContain("no_current_observation");
      // And specifically NOT answered from the older observation that has one.
      expect(evaluation.snapshotId).toBeNull();
    });

    it("no lifecycle query uses a UUID as a temporal tie-breaker", () => {
      const code = readFileSync(
        path.join(REPO_ROOT, "scripts", "lifecycle", "store.ts"),
        "utf8",
      ).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(code).not.toMatch(/observed_at\s+desc\s*,\s*o?\.?id\s+desc/i);
      expect(code).toContain("o.source_run_id = i.last_seen_run_id");
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
