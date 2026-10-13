/**
 * Taxonomy aliases and load/hold reasons. Synthetic values only.
 */
import { describe, expect, it } from "vitest";

import {
  CLAIM_ALIASES,
  DEPARTMENT_ALIASES,
  SCOPE_ALIASES,
  normalizeClaimType,
  normalizeContactScope,
  normalizeDepartment,
  organizationTypeForContact,
} from "@/lib/import/aliases";
import type { ContactRecord } from "@/lib/import/contract";
import { classifyVerificationStatus } from "@/lib/import/normalize";
import { summarizeOutcomes } from "@/lib/import/rejections";
import { mapContact, stageRawSheets } from "@/lib/import/stage";
import type { RawRow } from "@/lib/import/parse";

function contact(data: Record<string, string | null>, row = 2): RawRow {
  return { sheetName: "contacts", sourceRowNumber: row, data };
}

function evidence(data: Record<string, string | null>): RawRow {
  return { sheetName: "evidence", sourceRowNumber: 2, data };
}

describe("verification status reported", () => {
  it("maps reported to probable and does not promote it to verified", () => {
    expect(classifyVerificationStatus("reported")).toEqual({ status: "probable", unmapped: false });
    expect(classifyVerificationStatus("REPORTED")).toEqual({ status: "probable", unmapped: false });
    expect(classifyVerificationStatus("reported").status).not.toBe("verified");
  });

  it("keeps not-reported and unknown tokens from becoming probable", () => {
    expect(classifyVerificationStatus("not reported").status).toBe("unverified");
    expect(classifyVerificationStatus("unreported").status).toBe("unverified");
    expect(classifyVerificationStatus("disputed")).toEqual({
      status: "unverified",
      unmapped: true,
    });
    expect(classifyVerificationStatus("not_found")).toEqual({
      status: "unverified",
      unmapped: true,
    });
  });
});

describe("department aliases", () => {
  it.each(Object.entries(DEPARTMENT_ALIASES))("maps %s to %s", (alias, expected) => {
    expect(normalizeDepartment(alias).value).toBe(expected);
    expect(normalizeDepartment(alias).unmapped).toBe(false);
  });

  it("maps punctuated and Spanish labels onto the canonical enum", () => {
    expect(normalizeDepartment("PR & Communications").value).toBe("pr");
    expect(normalizeDepartment("Marketing y Comunicación").value).toBe("communications");
    expect(normalizeDepartment("Ventas y Marketing").value).toBe("sales");
    expect(normalizeDepartment("Redes Sociales").value).toBe("social_media");
    expect(normalizeDepartment("Influencer").value).toBe("social_media");
    expect(normalizeDepartment("Head of Marketing").value).toBe("marketing");
  });

  it("does not guess when two departments tie", () => {
    const result = normalizeDepartment("sales communications");
    expect(result).toEqual({ value: "other", unmapped: true });
  });
});

describe("contact scope aliases", () => {
  it.each(Object.entries(SCOPE_ALIASES))("maps %s to %s", (alias, expected) => {
    expect(normalizeContactScope(alias).value).toBe(expected);
    expect(normalizeContactScope(alias).unmapped).toBe(false);
  });

  it("maps corporate and cluster to group, and representation to agency", () => {
    expect(normalizeContactScope("Corporate").value).toBe("group");
    expect(normalizeContactScope("cluster").value).toBe("group");
    expect(normalizeContactScope("representation").value).toBe("agency");
    expect(normalizeContactScope("agencia").value).toBe("agency");
  });
});

describe("claim aliases", () => {
  it.each(Object.entries(CLAIM_ALIASES))("maps %s to %s", (alias, expected) => {
    expect(normalizeClaimType(alias)).toEqual({ value: expected, unmapped: false });
  });

  it("maps legacy underscored claim names", () => {
    expect(normalizeClaimType("contact_email_found").value).toBe("contact_confirmation");
    expect(normalizeClaimType("pr_contact_identified").value).toBe("contact_confirmation");
    expect(normalizeClaimType("ugc_influencer_history").value).toBe(
      "creator_collaboration_evidence",
    );
    expect(normalizeClaimType("pr_agency_of_record").value).toBe("agency_representation");
    expect(normalizeClaimType("creator_collaboration_evidence").unmapped).toBe(false);
  });

  it("flags an unknown claim instead of publishing the raw token", () => {
    expect(normalizeClaimType("secret_internal_code")).toEqual({ value: "other", unmapped: true });
  });
});

describe("organization_name columns", () => {
  it("keeps organization_name and does not invent it from the person", () => {
    const staged = mapContact(
      contact({
        source_property_id: "p1",
        contact_name: "Blue PR Agency",
        email: "person@example.com",
        contact_scope: "agency",
      }),
    );
    const record = staged.normalized as unknown as ContactRecord;
    expect(record.organizationName).toBeNull();
    expect(
      staged.warnings.some((warning) => warning.includes("organization_identity_missing")),
    ).toBe(true);
  });

  it("reads a management company column when organization_name is empty", () => {
    const staged = mapContact(
      contact({
        source_property_id: "p1",
        contact_name: "Ada Lovelace",
        email: "ada@example.com",
        contact_scope: "property",
        management_company: "Northwind Management",
      }),
    );
    const record = staged.normalized as unknown as ContactRecord;
    expect(record.organizationName).toBe("Northwind Management");
    expect(record.organizationType).toBe("management_company");
    expect(staged.status).not.toBe("rejected");
  });

  it("reads a hotel group column", () => {
    const staged = mapContact(
      contact({
        source_property_id: "p1",
        email: "desk@example.com",
        contact_scope: "group",
        hotel_group: "Harbor Hotels",
      }),
    );
    const record = staged.normalized as unknown as ContactRecord;
    expect(record.organizationName).toBe("Harbor Hotels");
    expect(record.organizationType).toBe("hotel_group");
    expect(organizationTypeForContact(record)).toBe("hotel_group");
  });

  it("prefers organization_name over a different company column", () => {
    const staged = mapContact(
      contact({
        source_property_id: "p1",
        email: "ada@example.com",
        contact_scope: "property",
        organization_name: "Kept Name",
        management_company: "Other Name",
      }),
    );
    const record = staged.normalized as unknown as ContactRecord;
    expect(record.organizationName).toBe("Kept Name");
    expect(record.organizationType).toBeNull();
    expect(
      staged.warnings.some((warning) => warning.includes("organization_column_conflict")),
    ).toBe(true);
  });
});

describe("load rejections", () => {
  it("rejects a row with no endpoint and keeps a linkedin-only row", () => {
    const empty = mapContact(contact({ source_property_id: "p1", department: "marketing" }, 2));
    expect(empty.status).toBe("rejected");
    expect(empty.errors.some((error) => error === "reason:no_usable_endpoint")).toBe(true);

    const linkedin = mapContact(
      contact(
        {
          source_property_id: "p1",
          linkedin_url: "https://www.linkedin.com/in/example",
        },
        3,
      ),
    );
    expect(linkedin.status).not.toBe("rejected");
    expect((linkedin.normalized as unknown as ContactRecord).linkedinUrl).toContain("linkedin.com");
  });

  it("flags a contact whose property is not in the batch", () => {
    const staged = stageRawSheets({
      properties: [],
      contacts: [
        contact({
          source_property_id: "missing-property",
          email: "a@example.com",
          contact_scope: "property",
          verification_status: "probable",
        }),
      ],
      evidence: [],
    });
    const row = staged.rows[0]!;
    expect(row.warnings).toContain("reason:source_property_missing");
    expect(row.status).toBe("review");
  });

  it("counts hold reasons without copying the contact value", () => {
    const staged = stageRawSheets({
      properties: [
        {
          sheetName: "properties",
          sourceRowNumber: 2,
          data: {
            source_property_id: "p1",
            property_name: "Example Hotel",
            country_code: "ES",
            destination_name: "Barcelona",
            source_url: "https://hotel.example",
          },
        },
      ],
      contacts: [
        contact({
          source_property_id: "p1",
          contact_name: "Should Not Appear",
          email: "person@example.com",
          contact_scope: "agency",
          verification_status: "inferred",
          department: "not-a-department",
        }),
      ],
      evidence: [
        evidence({
          source_property_id: "p1",
          claim_type: "ugc_influencer_history",
          source_type: "research_compilation",
          verification_status: "reported",
        }),
      ],
    });
    const report = summarizeOutcomes(staged.rows);
    expect(report.contacts).toBe(1);
    expect(report.rejected).toBe(0);
    expect(report.promotionInclude).toBe(0);
    expect(report.promotionDefer).toBe(1);
    expect(report.reasonCounts.department_unmapped).toBe(1);
    expect(report.reasonCounts.organization_identity_missing).toBe(1);
    expect(report.reasonCounts.deferred_inferred).toBe(1);
    const evidenceRow = staged.rows.find((row) => row.rowKind === "evidence");
    expect((evidenceRow?.normalized as { claimType: string }).claimType).toBe(
      "creator_collaboration_evidence",
    );
    expect((evidenceRow?.normalized as { verificationStatus: string }).verificationStatus).toBe(
      "probable",
    );
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain("Should Not Appear");
  });
});
