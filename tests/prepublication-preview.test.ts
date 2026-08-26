import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildFingerprintPayload,
  evaluatePreview,
  fingerprintSemanticBundle,
  type PreviewInput,
} from "../scripts/prepublication-preview/evaluate";
import { parseArgs } from "../scripts/prepublication-preview/preview";
import { resolvePreviewTarget } from "../scripts/prepublication-preview/target";
import { resolveIngestionTarget } from "../scripts/provider-ingestion/db-target";

const AS_OF = "2026-08-17";
const current = "00000000-0000-0000-0000-000000000010";
const candidate = (over: Record<string, unknown> = {}) => ({
  id: "finding-1",
  sourcePropertyIdentityId: "identity-1",
  kind: "new_property" as const,
  status: "accepted",
  candidateHotelId: null,
  candidateSourcePropertyIdentityId: null,
  sourceRunId: "run-1",
  matchMethod: "manual_search",
  nameEvidence: "none",
  domainEvidence: "unavailable",
  addressEvidence: "unavailable",
  phoneEvidence: "unavailable",
  brandEvidence: "unavailable",
  coordinateDistanceMetres: null,
  knownSourceMapping: false,
  reviewNote: "reviewed distinct",
  resolvedAt: "2026-08-17T00:00:00Z",
  supersededReason: null,
  ...over,
});

function valid(): PreviewInput {
  return {
    identity: {
      id: "identity-1",
      source: "hotelbeds",
      environment: "evaluation",
      currentObservationId: current,
    },
    review: {
      id: "review-1",
      decision: "approve_create",
      destinationId: "destination-1",
      targetHotelId: null,
      decidedInRunId: "run-1",
      reviewerUserId: "user-1",
      reviewerLabel: "Reviewer",
      reviewedAt: "2026-08-17T00:00:00Z",
      reviewNote: "reviewed",
      reviewStatus: "active",
      currentReceiptId: "receipt-1",
    },
    destination: { id: "destination-1", slug: "bali" },
    targetHotel: null,
    entity: {
      synchronized: true,
      acceptedCandidates: [candidate()],
      pendingCandidateIds: [],
      currentAnomalyReasons: [],
    },
    scope: {
      revisionId: "scope-1",
      observationId: current,
      outcome: "physical_hospitality",
      policyProvider: "hotelbeds",
      policyVersion: "scope/1",
      sourceValue: "HOTEL",
    },
    star: {
      revisionId: "star-1",
      observationId: current,
      outcome: "exact_four",
      resolvedStarValue: 4,
      conflictState: "none",
      policyProvider: "hotelbeds",
      policyVersion: "star/1",
      sourceValue: "4EST",
    },
    location: {
      revisionId: "location-1",
      observationId: current,
      outcome: "resolved",
      latitude: "-8.5",
      longitude: "115.2",
      conflictState: "none",
      unresolvedReason: null,
      policyProvider: "hotelbeds",
      policyVersion: "location/1",
    },
    // A04.5: an approve_create decision now needs its durable receipt, bound to
    // the CURRENT observation, before conditions 1 and 2 may pass.
    humanReview: {
      receiptId: "receipt-1",
      decision: "approve_create",
      evidenceObservationId: current,
      evidenceSourceRunId: "run-1",
      sourcePayloadDigest: "digest-1",
      destinationId: "destination-1",
      newPropertyFindingId: "finding-1",
      reviewerUserId: null,
      reviewerLabel: "reviewer",
      reviewedAt: "2026-08-17T00:00:00.000000Z",
      prereviewFingerprint: "a".repeat(64),
      prereviewAsOf: AS_OF,
      receiptDigest: "b".repeat(64),
      verifications: [
        { dimension: "distinct_property", verdict: "supports", note: null },
        { dimension: "destination_membership", verdict: "supports", note: null },
      ],
      evidenceReferenceCount: 1,
    },
    lifecycle: {
      policy: {
        provider: "hotelbeds",
        version: "lifecycle/1",
        approved: true,
        dateSemantics: "inclusive_day_interval",
        mappings: [{ issueCode: "HOTEL", issueType: "CLOSED", outcome: "property_closed_window" }],
      },
      snapshot: {
        snapshotId: "snapshot-1",
        observationId: current,
        providerIssueCount: 0,
        issues: [],
      },
    },
  };
}

const condition = (p: ReturnType<typeof evaluatePreview>, n: number) => p.conditions[n - 1]!;

describe("D062 pre-publication preview", () => {
  it("A/W/Y: all eleven pass, replay is identical, and evaluation is pure", () => {
    const input = valid();
    const before = JSON.stringify(input);
    const a = evaluatePreview(input, AS_OF);
    const b = evaluatePreview(input, AS_OF);
    expect(a.conditions).toHaveLength(11);
    expect(a.conditions.every((c) => c.status === "PASS")).toBe(true);
    expect(a.overall).toBe("PASS");
    expect(b).toEqual(a);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("B/C/D: FAIL wins overall while unrelated UNRESOLVED results remain visible", () => {
    const input = valid();
    input.scope!.outcome = "not_physical_hospitality";
    input.location = null;
    const p = evaluatePreview(input, AS_OF);
    expect(condition(p, 3).status).toBe("FAIL");
    expect(condition(p, 8).status).toBe("UNRESOLVED");
    expect(p.overall).toBe("FAIL");
    input.scope!.outcome = "unresolved";
    expect(evaluatePreview(input, AS_OF).overall).toBe("UNRESOLVED");
  });

  it("E/F: no review and unsupported approve_create never infer NEW", () => {
    const input = valid();
    input.review = null;
    input.entity.acceptedCandidates = [];
    expect(condition(evaluatePreview(input, AS_OF), 1).status).toBe("UNRESOLVED");
    input.review = valid().review;
    expect(condition(evaluatePreview(input, AS_OF), 1).reason).toBe(
      "identity_decision_lacks_support",
    );
  });

  it("G: approve_match passes only with the explicit accepted canonical target", () => {
    const input = valid();
    input.review = {
      ...input.review!,
      decision: "approve_match",
      destinationId: "destination-1",
      targetHotelId: "hotel-1",
    };
    input.targetHotel = { id: "hotel-1", destinationId: "destination-1", destinationSlug: "bali" };
    input.entity.acceptedCandidates = [
      candidate({ id: "candidate-1", kind: "canonical_hotel", candidateHotelId: "hotel-1" }),
    ];
    expect(condition(evaluatePreview(input, AS_OF), 1).status).toBe("PASS");
    input.review!.destinationId = null;
    expect(condition(evaluatePreview(input, AS_OF), 2).status).toBe("PASS");
    input.review!.destinationId = "destination-other";
    expect(condition(evaluatePreview(input, AS_OF), 2).reason).toBe(
      "reviewed_destination_target_mismatch",
    );
    input.review!.targetHotelId = "hotel-other";
    expect(condition(evaluatePreview(input, AS_OF), 1).reason).toBe(
      "identity_decision_lacks_support",
    );
  });

  it("H/I: pending current conflict holds; superseded history is absent and does not block", () => {
    const input = valid();
    input.entity.pendingCandidateIds = ["pending-1"];
    expect(condition(evaluatePreview(input, AS_OF), 11).status).toBe("UNRESOLVED");
    input.entity.pendingCandidateIds = [];
    expect(condition(evaluatePreview(input, AS_OF), 11).status).toBe("PASS");
  });

  it.each([
    ["exact_four", 4],
    ["exact_five", 5],
  ] as const)("J/K: %s passes star and provenance", (outcome, value) => {
    const input = valid();
    input.star!.outcome = outcome;
    input.star!.resolvedStarValue = value;
    const p = evaluatePreview(input, AS_OF);
    expect([condition(p, 6).status, condition(p, 7).status]).toEqual(["PASS", "PASS"]);
  });

  it("L/M: below-scope fails star; missing star is unresolved", () => {
    const input = valid();
    input.star!.outcome = "classified_not_v1_scope";
    input.star!.resolvedStarValue = null;
    expect(condition(evaluatePreview(input, AS_OF), 6).status).toBe("FAIL");
    input.star = null;
    const p = evaluatePreview(input, AS_OF);
    expect([condition(p, 6).status, condition(p, 7).status]).toEqual(["UNRESOLVED", "UNRESOLVED"]);
  });

  it("N/O/P: resolved coordinate chain passes; absent or implausible/current-invalid evidence holds", () => {
    const input = valid();
    let p = evaluatePreview(input, AS_OF);
    expect([8, 9, 10].map((n) => condition(p, n).status)).toEqual(["PASS", "PASS", "PASS"]);
    input.location = null;
    p = evaluatePreview(input, AS_OF);
    expect([8, 9, 10].map((n) => condition(p, n).status)).toEqual([
      "UNRESOLVED",
      "UNRESOLVED",
      "UNRESOLVED",
    ]);
    input.location = {
      ...valid().location!,
      outcome: "unresolved",
      latitude: null,
      longitude: null,
      unresolvedReason: "coordinates_implausible",
    };
    expect(condition(evaluatePreview(input, AS_OF), 8).status).toBe("UNRESOLVED");
  });

  it("Q/R/S: HOTEL closure fails in-window, passes after; facility closure never closes property", () => {
    const input = valid();
    input.lifecycle.snapshot!.providerIssueCount = 1;
    input.lifecycle.snapshot!.issues = [
      {
        issueCode: "HOTEL",
        issueType: "CLOSED",
        dateFromRaw: "2026-08-01",
        dateToRaw: "2026-08-31",
        providerOrder: 0,
        alternative: false,
      },
    ];
    expect(condition(evaluatePreview(input, AS_OF), 4).status).toBe("FAIL");
    expect(condition(evaluatePreview(input, "2026-09-01"), 4).status).toBe("PASS");
    input.lifecycle.snapshot!.issues[0]!.issueCode = "SPA";
    expect(condition(evaluatePreview(input, AS_OF), 4).status).toBe("PASS");
  });

  it("T/U/V: only the current-run observation is admissible and an invalid pointer holds", () => {
    const input = valid();
    input.identity.currentObservationId = "current-2";
    expect(condition(evaluatePreview(input, AS_OF), 4).status).toBe("UNRESOLVED");
    expect(condition(evaluatePreview(input, AS_OF), 3).status).toBe("UNRESOLVED");
    input.identity.currentObservationId = null;
    expect(condition(evaluatePreview(input, AS_OF), 4).reason).toBe(
      "lifecycle_evidence_unresolved",
    );
  });

  it("X: semantic evidence or as-of changes the deterministic fingerprint", () => {
    const a = evaluatePreview(valid(), AS_OF);
    const changed = valid();
    changed.star!.revisionId = "star-2";
    expect(evaluatePreview(changed, AS_OF).fingerprint).not.toBe(a.fingerprint);
    expect(evaluatePreview(valid(), "2026-08-18").fingerprint).not.toBe(a.fingerprint);
  });

  it("fingerprint ignores object insertion order, set order, and human display copy", () => {
    const left = valid();
    left.entity.pendingCandidateIds = ["b", "a"];
    left.entity.currentAnomalyReasons = ["z", "x"];
    const right = valid();
    right.entity.pendingCandidateIds = ["a", "b"];
    right.entity.currentAnomalyReasons = ["x", "z"];
    const a = evaluatePreview(left, AS_OF);
    const b = evaluatePreview(right, AS_OF);
    expect(a.fingerprint).toBe(b.fingerprint);

    const copyChanged = a.conditions.map((c) => ({ ...c, explanation: `new copy: ${c.number}` }));
    expect(
      fingerprintSemanticBundle(
        buildFingerprintPayload({ identity: left.identity, asOf: AS_OF, conditions: copyChanged }),
      ),
    ).toBe(a.fingerprint);
    expect(fingerprintSemanticBundle({ z: 1, a: { y: 2, x: 3 } })).toBe(
      fingerprintSemanticBundle({ a: { x: 3, y: 2 }, z: 1 }),
    );
  });

  it("fingerprint changes when condition status or machine reason changes", () => {
    const preview = evaluatePreview(valid(), AS_OF);
    for (const change of [{ status: "FAIL" as const }, { reason: "different_semantic_reason" }]) {
      const conditions = preview.conditions.map((c, i) => (i === 0 ? { ...c, ...change } : c));
      const digest = fingerprintSemanticBundle(
        buildFingerprintPayload({ identity: valid().identity, asOf: AS_OF, conditions }),
      );
      expect(digest).not.toBe(preview.fingerprint);
    }
  });

  it("condition 10 requires both location policy provider and version", () => {
    const input = valid();
    input.location!.policyProvider = "";
    expect(condition(evaluatePreview(input, AS_OF), 10).status).toBe("UNRESOLVED");
  });

  it("requires an explicit supported environment and accepts read-only production inspection", () => {
    const base = ["--as-of", AS_OF, "--source-property-id", "123", "--source", "hotelbeds"];
    expect(parseArgs([...base, "--environment", "evaluation"]).environment).toBe("evaluation");
    expect(parseArgs([...base, "--environment", "production"]).environment).toBe("production");
    expect(() => parseArgs([...base, "--environment", "staging"])).toThrow(
      /evaluation or production/,
    );
    expect(() => parseArgs(base)).toThrow(/environment/);
    expect(() =>
      parseArgs(["--as-of", AS_OF, "--environment", "evaluation", "--source-property-id", "123"]),
    ).toThrow(/source/);
  });

  it("holds contradictory accepted entity evidence independent of candidate order", () => {
    const a = candidate({ id: "a", kind: "canonical_hotel", candidateHotelId: "hotel-a" });
    const b = candidate({ id: "b", kind: "canonical_hotel", candidateHotelId: "hotel-b" });
    const first = valid();
    first.review = { ...first.review!, decision: "approve_match", targetHotelId: "hotel-a" };
    first.entity.acceptedCandidates = [a, b];
    const second = structuredClone(first);
    second.entity.acceptedCandidates.reverse();
    const p1 = evaluatePreview(first, AS_OF),
      p2 = evaluatePreview(second, AS_OF);
    expect(condition(p1, 1).reason).toBe("accepted_entity_evidence_inconsistent");
    expect(condition(p1, 11).reason).toBe("accepted_entity_evidence_inconsistent");
    expect(p2.fingerprint).toBe(p1.fingerprint);
    const mixed = valid();
    mixed.entity.acceptedCandidates.push(a);
    expect(condition(evaluatePreview(mixed, AS_OF), 1).reason).toBe(
      "accepted_entity_evidence_inconsistent",
    );
  });

  it("binds review and accepted-candidate semantics into the fingerprint", () => {
    const baseline = evaluatePreview(valid(), AS_OF).fingerprint;
    for (const mutate of [
      (x: PreviewInput) => {
        x.review!.decidedInRunId = "run-2";
      },
      (x: PreviewInput) => {
        x.review!.reviewNote = "different justification";
      },
      (x: PreviewInput) => {
        x.review!.decision = "defer";
      },
      (x: PreviewInput) => {
        x.review!.destinationId = "destination-2";
      },
      (x: PreviewInput) => {
        x.entity.acceptedCandidates[0]!.matchMethod = "manual_registry_search";
      },
      (x: PreviewInput) => {
        x.entity.acceptedCandidates[0]!.reviewNote = "different candidate evidence";
      },
    ]) {
      const input = valid();
      mutate(input);
      expect(evaluatePreview(input, AS_OF).fingerprint).not.toBe(baseline);
    }
  });

  it("allows remote read-only preview classification while ingestion still refuses it", () => {
    const env = { DATABASE_URL: "postgresql://user:secret@db.example.com:5432/app" };
    expect(resolvePreviewTarget(env).classification.isRemote).toBe(true);
    expect(resolvePreviewTarget(env).classification.redactedTarget).not.toContain("secret");
    expect(() => resolveIngestionTarget(env)).toThrow(/Refusing to ingest into a remote target/);
  });

  it("binds both source-identity pair endpoints and ignores candidate array order", () => {
    const a = candidate({
      id: "pair",
      kind: "source_identity",
      sourcePropertyIdentityId: "A",
      candidateSourcePropertyIdentityId: "B",
    });
    const b = candidate({
      id: "other",
      kind: "source_identity",
      sourcePropertyIdentityId: "C",
      candidateSourcePropertyIdentityId: "B",
    });
    const first = valid();
    first.entity.acceptedCandidates = [a, b];
    const reversed = structuredClone(first);
    reversed.entity.acceptedCandidates.reverse();
    expect(evaluatePreview(reversed, AS_OF).fingerprint).toBe(
      evaluatePreview(first, AS_OF).fingerprint,
    );
    const changed = structuredClone(first);
    changed.entity.acceptedCandidates[0]!.sourcePropertyIdentityId = "Z";
    expect(evaluatePreview(changed, AS_OF).fingerprint).not.toBe(
      evaluatePreview(first, AS_OF).fingerprint,
    );
  });

  it("canonicalizes lifecycle issue sets independently of array, tied order, and null order", () => {
    const issue = (code: string, order: number | null) => ({
      issueCode: code,
      issueType: "CLOSED",
      dateFromRaw: "2026-08-01",
      dateToRaw: "2026-08-31",
      providerOrder: order,
      alternative: false,
    });
    for (const order of [1, null]) {
      const left = valid(),
        right = valid();
      left.lifecycle.snapshot!.providerIssueCount = 2;
      left.lifecycle.snapshot!.issues = [issue("SPA", order), issue("HOTEL", order)];
      right.lifecycle.snapshot!.providerIssueCount = 2;
      right.lifecycle.snapshot!.issues = left.lifecycle
        .snapshot!.issues.map((value) => ({ ...value }))
        .reverse();
      expect(evaluatePreview(right, AS_OF).fingerprint).toBe(
        evaluatePreview(left, AS_OF).fingerprint,
      );
      right.lifecycle.snapshot!.issues.find((issue) => issue.issueCode === "HOTEL")!.dateToRaw =
        "2026-09-01";
      expect(evaluatePreview(right, AS_OF).fingerprint).not.toBe(
        evaluatePreview(left, AS_OF).fingerprint,
      );
    }
  });

  it("uses locale-independent fingerprint ordering and schema v2", () => {
    expect(
      buildFingerprintPayload({
        identity: valid().identity,
        asOf: AS_OF,
        conditions: evaluatePreview(valid(), AS_OF).conditions,
      }).fingerprintSchemaVersion,
    ).toBe("d062-prepublication-preview-fingerprint/2");
    const source =
      readFileSync("scripts/prepublication-preview/evaluate.ts", "utf8") +
      readFileSync("scripts/prepublication-preview/preview.ts", "utf8");
    expect(source).not.toContain("localeCompare");
  });
});
